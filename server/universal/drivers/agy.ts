import { execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnUsage } from "../driver-base.js";
import type { PromptAttachment } from "../../protocol.js";
import { probeEngineCliVersion, resolveEngineCliLaunch } from "../../engine-cli.js";
import { spawnChildPiped, type SpawnedChild } from "../../spawn-child.js";
import { decodeInlineImage, describeCliAttachment } from "../universal-attachments.js";

const execFileAsync = promisify(execFile);

export interface AgyDriverOptions {
	executablePath?: string;
	agentDir?: string;
	dataDir?: string;
}

/** 探测本机 Antigravity (`agy`) CLI 是否可用及版本号。 */
export async function probeAgy(
	executablePath?: string,
	refresh = false,
): Promise<{ available: boolean; version?: string; error?: string }> {
	const result = await probeEngineCliVersion("agy", executablePath, refresh);
	return result.available && result.version
		? { ...result, version: result.version.replace(/^(?:agy|antigravity)\s+/i, "") }
		: result;
}

interface ActiveRun {
	child: ChildProcessWithoutNullStreams;
	stop: SpawnedChild["stop"];
	done: Promise<void>;
	cancelled: boolean;
	stopped?: Promise<void>;
}

const FALLBACK_AGY_MODELS: ReadonlyArray<{ id: string; name: string }> = [
	{ id: "default", name: "Antigravity config default" },
	{ id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
	{ id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
	{ id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
	{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
	{ id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
	{ id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
];

/** Antigravity (`agy`) CLI Universal 驱动，基于 `--output-format stream-json`。 */
export class AgyDriver extends BaseAgentDriver {
	readonly id = "agy";
	readonly name = "Antigravity";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: false,
		supportsAskUser: false,
		supportsSubagents: true,
		mcpTransport: "none",
		systemPromptChannel: "turn-prefix",
	};
	private sessionId = "";
	private model = "default";
	private active?: ActiveRun;
	private disposed = false;
	private cachedModels?: Array<{ id: string; name: string }>;
	private systemPromptAppendix = "";

	constructor(
		cwd: string,
		private readonly options: AgyDriverOptions = {},
	) {
		super(cwd);
	}

	async createSession(): Promise<string> {
		this.sessionId = "";
		return "";
	}

	async resumeSession(sessionId: string): Promise<void> {
		this.sessionId = sessionId;
	}

	getActiveSessionId(): string {
		return this.sessionId;
	}

	async setModel(modelId: string): Promise<void> {
		this.model = modelId.replace(/^agy\//, "");
	}

	override setSystemPromptAppendix(appendix: string): void {
		this.systemPromptAppendix = appendix.trim();
	}

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		if (this.cachedModels) return this.cachedModels;
		const rows: Array<{ id: string; name: string }> = [{ id: "default", name: "Antigravity config default" }];
		try {
			const launch = resolveEngineCliLaunch("agy", { executablePath: this.options.executablePath, cwd: this.cwd });
			const { stdout } = await execFileAsync(launch.file, [...launch.args, "models"], {
				cwd: this.cwd,
				timeout: 10_000,
			});
			for (const rawLine of stdout.split(/\r?\n/)) {
				const line = rawLine.replace(/^\r?[^\w\s]*\s*/, "").trim();
				const match = line.match(/^([a-z0-9][a-z0-9._-]+)\s{2,}(.+)$/i);
				if (!match) continue;
				const [, id, name] = match;
				if (!rows.some((r) => r.id === id)) rows.push({ id, name: name.trim() });
			}
			if (rows.length > 1) {
				this.cachedModels = rows;
				return rows;
			}
		} catch {}
		return [...FALLBACK_AGY_MODELS];
	}

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		if (this.disposed) throw new Error("Antigravity driver disposed");
		if (this.active) throw new Error("Antigravity is already running");
		const cwd = this.cwd;
		let imageDir: string | undefined;
		let input = !this.sessionId && this.systemPromptAppendix ? `${this.systemPromptAppendix}\n\n${prompt}` : prompt;
		let imageCount = 0;
		try {
			for (const att of attachments ?? []) {
				if (att.imageData && !att.fileData && !att.uploadPath) {
					const image = decodeInlineImage(att);
					if (!image) throw new Error("Unsupported Antigravity image format");
					imageDir ??= mkdtempSync(join(tmpdir(), "pi-agy-images-"));
					const path = join(imageDir, `${imageCount++}.${image.mimeType.split("/")[1]}`);
					writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
					input += `\n[Attached image file: ${path}]`;
					continue;
				}
				const note = describeCliAttachment(att);
				if (note) input += `\n${note}`;
			}
			const launch = resolveEngineCliLaunch("agy", { executablePath: this.options.executablePath, cwd });
			const args = [...launch.args, "--output-format", "stream-json", "--dangerously-skip-permissions"];
			if (this.model && this.model !== "default") args.push("--model", this.model);
			if (this.sessionId) args.push("--resume", this.sessionId);
			args.push(`--print=${input}`);

			const spawned = spawnChildPiped({
				cmd: launch.file,
				args,
				cwd,
			});
			const child = spawned.child;
			let finish!: () => void;
			const run: ActiveRun = {
				child,
				stop: spawned.stop,
				cancelled: false,
				done: new Promise<void>((resolve) => {
					finish = resolve;
				}),
			};
			this.active = run;
			const decoder = new StringDecoder("utf8");
			let pending = "",
				stderr = "",
				error: Error | undefined,
				completed = false,
				settled = false;
			let usage: AgentTurnUsage | undefined;
			let model: string | undefined;
			const startedTools = new Set<string>();
			const endedTools = new Set<string>();

			const parse = (line: string) => {
				if (!line.trim() || run.cancelled) return;
				let evt: Record<string, any>;
				try {
					evt = JSON.parse(line) as Record<string, any>;
				} catch {
					throw new Error("Invalid Antigravity JSON event");
				}
				if (evt.event === "init") {
					if (typeof evt.conversation_id === "string" && evt.conversation_id) {
						this.sessionId = evt.conversation_id;
						sink.onSessionStarted?.(evt.conversation_id);
					}
					if (typeof evt.init?.model === "string") model = evt.init.model;
					return;
				}
				if (evt.event === "step_update" && evt.step_update && typeof evt.step_update === "object") {
					const su = evt.step_update as Record<string, any>;
					const stepType = su.step_type;
					if (stepType === "agent_response") {
						if (typeof su.thinking_delta === "string" && su.thinking_delta) sink.onThinkingDelta(su.thinking_delta);
						if (typeof su.text_delta === "string" && su.text_delta) sink.onTextDelta(su.text_delta);
					} else if (stepType === "thinking" || stepType === "thought") {
						const delta =
							typeof su.thinking_delta === "string"
								? su.thinking_delta
								: typeof su.text_delta === "string"
									? su.text_delta
									: "";
						if (delta) sink.onThinkingDelta(delta);
					} else if (stepType === "tool") {
						const callId = `${su.conversation_id ?? this.sessionId ?? ""}:${su.step_index ?? "0"}`;
						const info = (su.tool_info ?? {}) as Record<string, any>;
						const toolName = String(su.tool_name || info.name || "tool");
						const params = (info.parameters && typeof info.parameters === "object" ? info.parameters : {}) as Record<
							string,
							unknown
						>;
						if (!startedTools.has(callId)) {
							startedTools.add(callId);
							sink.onToolStart(callId, toolName, params);
						}
						if (su.state === "DONE" && !endedTools.has(callId)) {
							endedTools.add(callId);
							sink.onToolEnd(callId, {
								output: typeof info.output === "string" ? info.output : JSON.stringify(info.output ?? ""),
								...(info.error ? { error: String(info.error) } : {}),
							});
						}
					}
					return;
				}
				if (evt.event === "result" && evt.result && typeof evt.result === "object") {
					const res = evt.result as Record<string, any>;
					if (typeof res.conversation_id === "string" && res.conversation_id) {
						this.sessionId = res.conversation_id;
					}
					if (res.status === "SUCCESS") {
						completed = true;
						const u = res.usage as Record<string, any> | undefined;
						if (u && typeof u === "object") {
							const cached = Number(u.cache_read_tokens ?? 0) || 0;
							const inputTokens = Number(u.input_tokens ?? 0) || 0;
							usage = {
								inputTokens: Math.max(0, inputTokens - cached),
								cacheReadTokens: cached,
								outputTokens: Number(u.output_tokens ?? 0) || 0,
							};
						}
					} else {
						error = new Error(String(res.error || res.message || `Antigravity failed (${res.status ?? "unknown"})`));
					}
				}
			};

			const fail = (err: unknown) => {
				error = err instanceof Error ? err : new Error(String(err));
				void this.stopRun(run);
			};
			child.stdout?.on("data", (chunk: Buffer) => {
				try {
					pending += decoder.write(chunk);
					if (pending.length > 8 * 1024 * 1024) throw new Error("Antigravity output event exceeds limit");
					let newline: number;
					while ((newline = pending.indexOf("\n")) >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						parse(line);
					}
				} catch (err) {
					fail(err);
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-8000);
			});
			const settle = (code: number | null) => {
				if (settled) return;
				settled = true;
				try {
					pending += decoder.end();
					if (pending.trim() && !run.cancelled) parse(pending);
					if (this.active === run) this.active = undefined;
					if (run.cancelled) {
						if (error) sink.onError(error);
					} else if (error || code !== 0 || !completed) {
						sink.onError(error ?? new Error(stderr.trim() || `Antigravity exited before completion (${code})`));
					} else {
						sink.onTurnComplete({ ...(usage ? { usage } : {}), ...(model ? { model } : {}) });
					}
				} catch (err) {
					sink.onError(err instanceof Error ? err : String(err));
				} finally {
					if (this.active === run) this.active = undefined;
					finish();
				}
			};
			child.on("error", (err) => {
				error = err;
				settle(null);
			});
			child.on("close", settle);
			child.stdin?.end();
			await run.done;
		} finally {
			if (imageDir) rmSync(imageDir, { recursive: true, force: true });
		}
	}

	private stopRun(run: ActiveRun): Promise<void> {
		if (run.stopped) return run.stopped;
		run.cancelled = true;
		run.stopped = (async () => {
			if (run.child.pid) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						run.stop({ timeoutMs: 3000 }).then(() => undefined),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 3000);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			} else run.child.kill();
			await Promise.race([
				run.done,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 3000);
					timer.unref();
					run.done.then(() => clearTimeout(timer));
				}),
			]);
		})();
		return run.stopped;
	}

	async abort(): Promise<void> {
		if (this.active) await this.stopRun(this.active);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.abort();
	}
}
