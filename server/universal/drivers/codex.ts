import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnUsage } from "../driver-base.js";
import type { PromptAttachment } from "../../protocol.js";
import { probeEngineCliVersion, resolveEngineCliLaunch } from "../../engine-cli.js";
import { spawnChildPiped, type SpawnedChild } from "../../spawn-child.js";
import { decodeInlineImage, describeCliAttachment } from "../universal-attachments.js";
import { collectEnabledMcpServers, toCodexMcpOverrides } from "../engine-mcp.js";
import {
	isModelProtocolSupportedByEngine,
	listCustomModelsFromConfig,
	readModelsJson,
	resolveModelProtocol,
	resolveProviderCredential,
} from "../../model-resolver.js";

export interface CodexDriverOptions {
	executablePath?: string;
	agentDir?: string;
	dataDir?: string;
}

export async function probeCodex(
	executablePath?: string,
	refresh = false,
): Promise<{ available: boolean; version?: string; error?: string }> {
	const result = await probeEngineCliVersion("codex", executablePath, refresh);
	return result.available && result.version
		? { ...result, version: result.version.replace(/^codex(?:-cli)?\s+/i, "") }
		: result;
}

/** Text content of a completed `mcp_tool_call` item (`result.content[].text`), if any. */
function mcpResultText(item: any): string | undefined {
	if (item?.type !== "mcp_tool_call" || !Array.isArray(item.result?.content)) return undefined;
	const text = item.result.content
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
	return text || undefined;
}

interface ActiveRun {
	child: ChildProcessWithoutNullStreams;
	stop: SpawnedChild["stop"];
	done: Promise<void>;
	cancelled: boolean;
	stopped?: Promise<void>;
}

interface CodexModelsCacheEntry {
	mtimeMs: number;
	size: number;
	models: Array<{ id: string; name: string }>;
}

const codexModelsCache = new Map<string, CodexModelsCacheEntry>();

function readCodexModelsCache(cachePath: string): Array<{ id: string; name: string }> {
	let mtimeMs: number;
	let size: number;
	try {
		const st = statSync(cachePath);
		mtimeMs = st.mtimeMs;
		size = st.size;
	} catch {
		codexModelsCache.delete(cachePath);
		return [];
	}

	const cached = codexModelsCache.get(cachePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached.models;
	}

	try {
		const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
			models?: Array<{ slug?: unknown; display_name?: unknown }>;
		};
		const models: Array<{ id: string; name: string }> = [];
		const seen = new Set<string>(["default"]);
		for (const model of cache.models ?? []) {
			if (typeof model.slug === "string" && !seen.has(model.slug)) {
				seen.add(model.slug);
				models.push({
					id: model.slug,
					name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug,
				});
			}
		}
		codexModelsCache.set(cachePath, { mtimeMs, size, models });
		return models;
	} catch {
		codexModelsCache.delete(cachePath);
		return [];
	}
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
		this.model = modelId.startsWith("codex/") ? modelId.slice("codex/".length) : modelId;
	}
	setThinkingLevel(level: string): void {
		this.effort = this.getSupportedThinkingLevels().includes(level) ? level : "medium";
	}
	getSupportedThinkingLevels(): string[] {
		return ["minimal", "low", "medium", "high", "xhigh"];
	}
	async listModels(): Promise<Array<{ id: string; name: string }>> {
		const rows = [{ id: "default", name: "Codex config default" }];
		const cachePath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
		for (const model of readCodexModelsCache(cachePath)) {
			rows.push({ id: model.id, name: model.name });
		}
		if (this.options.agentDir) {
			const custom = listCustomModelsFromConfig(this.options.agentDir, (entry) =>
				isModelProtocolSupportedByEngine("codex", entry, entry.baseUrl),
			);
			for (const c of custom) {
				const id = `${c.providerId}/${c.modelId}`;
				if (!rows.some((row) => row.id === id)) {
					rows.push({ id, name: c.name });
				}
			}
		}
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
				if (att.imageData && !att.fileData && !att.uploadPath) {
					const image = decodeInlineImage(att);
					if (!image) throw new Error("Unsupported Codex image format");
					if (image.data.length > 28 * 1024 * 1024) throw new Error("Codex image exceeds size limit");
					imageDir ??= mkdtempSync(join(tmpdir(), "pi-codex-images-"));
					const path = join(imageDir, `${imageArgs.length}.${image.mimeType.split("/")[1]}`);
					writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
					imageArgs.push("--image", path);
					continue;
				}
				const note = describeCliAttachment(att);
				if (note) input += `\n${note}`;
			}
			const mcp = toCodexMcpOverrides(
				collectEnabledMcpServers({ cwd, agentDir: this.options.agentDir, dataDir: this.options.dataDir }),
			);
			const launch = resolveEngineCliLaunch("codex", { executablePath: this.options.executablePath, cwd });
			const customEnv: Record<string, string> = { ...mcp.env };
			const customConfigArgs: string[] = [];
			let targetModel = this.model;
			if (this.model !== "default" && this.model.includes("/")) {
				const slash = this.model.indexOf("/");
				const targetProvider = this.model.slice(0, slash);
				targetModel = this.model.slice(slash + 1);
				const safeKey = targetProvider.replace(/[^a-zA-Z0-9_-]/g, "_") || "custom";
				const cred = this.options.agentDir
					? resolveProviderCredential(this.options.agentDir, targetProvider)
					: { providerId: targetProvider };
				const providerRow = this.options.agentDir
					? readModelsJson(this.options.agentDir).providers[targetProvider]
					: undefined;
				const api = typeof providerRow?.api === "string" ? providerRow.api : undefined;
				const protocol = resolveModelProtocol(api, targetProvider, targetModel);
				const wireApi = protocol === "openai-responses" ? "responses" : "chat";
				customConfigArgs.push(
					"-c",
					`model_provider=${JSON.stringify(safeKey)}`,
					"-c",
					`model_providers.${safeKey}.name=${JSON.stringify(targetProvider)}`,
					"-c",
					`model_providers.${safeKey}.wire_api=${JSON.stringify(wireApi)}`,
				);
				if (cred.baseUrl) {
					customConfigArgs.push("-c", `model_providers.${safeKey}.base_url=${JSON.stringify(cred.baseUrl)}`);
				}
				if (cred.apiKey) {
					customConfigArgs.push("-c", `model_providers.${safeKey}.env_key="PI_CODEX_API_KEY"`);
					customEnv.PI_CODEX_API_KEY = cred.apiKey;
				}
			}
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
				...customConfigArgs,
				...mcp.args,
			];
			if (targetModel !== "default") args.push("--model", targetModel);
			if (this.sessionId) args.push("resume", this.sessionId);
			args.push(...imageArgs, "-");
			const spawned = spawnChildPiped({
				cmd: launch.file,
				args,
				cwd,
				env: customEnv,
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
								output: item.aggregated_output ?? mcpResultText(item) ?? JSON.stringify(item),
								...(item.status === "failed" ||
								item.error ||
								(typeof item.exit_code === "number" && item.exit_code !== 0)
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
		if (run.stopped) return run.stopped;
		run.cancelled = true;
		run.stopped = (async () => {
			if (run.child.pid) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					// 整棵树收口到单源 stop()；仍保留 3s 上限（超时就往下走，不等确认）。
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
