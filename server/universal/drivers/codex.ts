import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnUsage } from "../driver-base.js";
import type { PromptAttachment } from "../../protocol.js";
import { probeEngineCliVersion, resolveEngineCliLaunch } from "../../engine-cli.js";
import { killPidTree } from "../../process-utils.js";
import { formatUnavailableCanvasReference } from "../universal-attachments.js";

export interface CodexDriverOptions {
	executablePath?: string;
}

export async function probeCodex(
	executablePath?: string,
): Promise<{ available: boolean; version?: string; error?: string }> {
	const result = await probeEngineCliVersion("codex", executablePath);
	return result.available && result.version
		? { ...result, version: result.version.replace(/^codex(?:-cli)?\s+/i, "") }
		: result;
}

interface ActiveRun {
	child: ChildProcess;
	done: Promise<void>;
	cancelled: boolean;
	stop?: Promise<void>;
}

export class CodexDriver extends BaseAgentDriver {
	readonly id = "codex";
	readonly name = "Codex";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: false,
		supportsSubagents: true,
	};
	private sessionId = "";
	private model = "default";
	private effort = "medium";
	private active?: ActiveRun;
	private disposed = false;
	constructor(
		cwd: string,
		private readonly options: CodexDriverOptions = {},
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
		this.model = modelId.replace(/^codex\//, "");
	}
	setThinkingLevel(level: string): void {
		this.effort = this.getSupportedThinkingLevels().includes(level) ? level : "medium";
	}
	getSupportedThinkingLevels(): string[] {
		return ["minimal", "low", "medium", "high", "xhigh"];
	}
	async listModels(): Promise<Array<{ id: string; name: string }>> {
		const rows = [{ id: "default", name: "Codex config default" }];
		try {
			const cache = JSON.parse(
				readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"), "utf8"),
			);
			for (const model of cache.models ?? []) {
				if (typeof model.slug === "string" && !rows.some((row) => row.id === model.slug))
					rows.push({ id: model.slug, name: model.display_name || model.slug });
			}
		} catch {}
		return rows;
	}

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		if (this.disposed) throw new Error("Codex driver disposed");
		if (this.active) throw new Error("Codex is already running");
		const cwd = this.cwd;
		let imageDir: string | undefined;
		const imageArgs: string[] = [];
		let input = prompt;
		try {
			for (const att of attachments ?? []) {
				if (att.mode === "canvas") {
					input += `\n${formatUnavailableCanvasReference(att)}`;
					continue;
				}
				if (att.mode === "page" || att.mode === "conversation") {
					input += `\nReferenced ${att.mode}: ${JSON.stringify(att.path)} (host access unavailable in Codex).`;
					continue;
				}
				if (att.imageData) {
					const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(att.imageData);
					const mime = match?.[1] ?? att.mimeType;
					if (!mime || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime))
						throw new Error("Unsupported Codex image format");
					const encoded = match?.[2] ?? att.imageData;
					if (encoded.length > 28 * 1024 * 1024) throw new Error("Codex image exceeds size limit");
					imageDir ??= mkdtempSync(join(tmpdir(), "pi-codex-images-"));
					const path = join(imageDir, `${imageArgs.length}.${mime.split("/")[1]}`);
					writeFileSync(path, Buffer.from(encoded, "base64"), { mode: 0o600 });
					imageArgs.push("--image", path);
				} else if (att.mode === "quote" && att.quote) input += `\n<quote>\n${att.quote.text}\n</quote>`;
				else
					input += `\nFile reference: ${JSON.stringify(att.path)}${att.mode === "lines" ? ` (lines ${att.lines?.start ?? ""}-${att.lines?.end ?? ""})` : ""}`;
			}
			const launch = resolveEngineCliLaunch("codex", { executablePath: this.options.executablePath, cwd });
			const args = [
				...launch.args,
				"--ask-for-approval",
				"never",
				"exec",
				"--json",
				"--skip-git-repo-check",
				"--sandbox",
				"workspace-write",
				"--color",
				"never",
				"-c",
				`model_reasoning_effort=${JSON.stringify(this.effort)}`,
			];
			if (this.model !== "default") args.push("--model", this.model);
			if (this.sessionId) args.push("resume", this.sessionId);
			args.push(...imageArgs, "-");
			const child = spawn(launch.file, args, {
				cwd,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1" },
			});
			let finish!: () => void;
			const run: ActiveRun = {
				child,
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
			const texts = new Map<string, string>();
			const tools = new Set<string>();
			const parse = (line: string) => {
				if (!line.trim() || run.cancelled) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					throw new Error("Invalid Codex JSON event");
				}
				if (event.type === "thread.started" && typeof event.thread_id === "string") {
					this.sessionId = event.thread_id;
					sink.onSessionStarted?.(event.thread_id);
				} else if (event.type === "turn.completed") {
					completed = true;
					const u = event.usage ?? {};
					const cached = u.cached_input_tokens ?? 0;
					usage = {
						inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
						cacheReadTokens: cached,
						outputTokens: u.output_tokens ?? 0,
					};
				} else if (event.type === "turn.failed") error = new Error(event.error?.message || "Codex turn failed");
				else if (event.type === "error") error = new Error(event.message || "Codex error");
				else if (event.type?.startsWith("item.") && event.item) {
					const item = event.item,
						id = String(item.id);
					if (item.type === "agent_message" || item.type === "reasoning") {
						const text = typeof item.text === "string" ? item.text : "";
						const previous = texts.get(id) ?? "";
						const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
						texts.set(id, text);
						if (delta) {
							if (item.type === "reasoning") sink.onThinkingDelta(delta);
							else sink.onTextDelta(delta);
						}
					} else if (
						["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"].includes(item.type)
					) {
						if (!tools.has(id)) {
							tools.add(id);
							sink.onToolStart(
								id,
								item.type,
								item.type === "command_execution" ? { command: item.command } : { ...item },
							);
						}
						if (event.type === "item.completed")
							sink.onToolEnd(id, {
								output: item.aggregated_output ?? JSON.stringify(item),
								...(item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)
									? { error: item.error?.message || `Codex ${item.type} failed (${item.exit_code ?? item.status})` }
									: {}),
							});
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
					if (pending.length > 8 * 1024 * 1024) throw new Error("Codex output event exceeds limit");
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
			child.stdin?.on("error", (err) => {
				if (!run.cancelled) error = err;
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
					} else if (error || code !== 0 || !completed)
						sink.onError(error ?? new Error(stderr.trim() || `Codex exited before completion (${code})`));
					else sink.onTurnComplete({ usage });
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
			child.stdin?.end(input);
			await run.done;
		} finally {
			if (imageDir) rmSync(imageDir, { recursive: true, force: true });
		}
	}

	private stopRun(run: ActiveRun): Promise<void> {
		if (run.stop) return run.stop;
		run.cancelled = true;
		run.stop = (async () => {
			if (run.child.pid) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						killPidTree(run.child.pid),
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
		return run.stop;
	}
	async abort(): Promise<void> {
		if (this.active) await this.stopRun(this.active);
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.abort();
	}
}
