import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
	PluginChatRequest,
	PluginConversationQuery,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "../contracts/plugin.js";
import type { DispatchSession } from "../engine-service.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { projectSessionMessages, projectStreamingMessage } from "../adapters/sdk/view.js";
import { statsOfSession } from "../adapters/sdk/session-stats.js";
import { QuiesceRejectedError } from "../contracts/quiesce.js";

export function modelChangeKey(snap: { clientId: string; conversationId: string; model?: string }): string {
	return `${snap.clientId}\u0000${snap.conversationId}\u0000${snap.model ?? ""}`;
}

export function pickLatestClientSnapshot<T extends { isSubagent: boolean; at: number }>(
	snapshots: Iterable<T | null | undefined>,
): T | null {
	let best: T | null = null;
	for (const s of snapshots) {
		if (!s || s.isSubagent) continue;
		if (!best || s.at > best.at) best = s;
	}
	return best;
}

export function snapshotForConversation(runtime: ClientRuntime, conv: Conversation): PluginConversationSnapshot | null {
	const opened = runtime.options.sessions?.get(conv.id);
	const session = opened?.session;
	let stats = {
		totalMessages: 0,
		tokens: { input: 0, output: 0, total: 0 },
		cost: 0,
	};
	if (session) {
		try {
			const s = statsOfSession(session);
			if (s) {
				stats = {
					totalMessages: s.totalMessages,
					tokens: s.tokens,
					cost: (session as any).getSessionStats?.()?.cost ?? 0,
				};
			}
		} catch {}
	}
	const curModel = session?.model as { provider?: string; id?: string } | undefined;
	const modelId =
		curModel && typeof curModel === "object" && curModel.provider && curModel.id
			? `${curModel.provider}/${curModel.id}`
			: undefined;
	const sessionFile = opened?.sessionFile ?? conv.meta.sessionFile;
	const sessionDir =
		(opened?.session as any)?.sessionManager?.getSessionDir?.() ?? (sessionFile ? dirname(sessionFile) : undefined);
	return {
		clientId: runtime.clientId,
		conversationId: conv.id,
		isSubagent: Boolean(conv.meta.kind === "subagent"),
		sessionId: opened?.sessionId ?? conv.meta.sessionFile ?? conv.id,
		...(sessionFile ? { sessionFile } : {}),
		...(sessionDir ? { sessionDir } : {}),
		title: conv.meta.title,
		...(modelId ? { model: modelId } : {}),
		at: conv.meta.lastActiveAt,
		isStreaming: session?.isStreaming ?? conv.phase === "running",
		messages: projectSessionMessages(session),
		streamingMessage: projectStreamingMessage(session),
		stats,
	};
}

export function readConversationForPlugins(
	runtimes: ReadonlyMap<string, ClientRuntime>,
	opts?: PluginConversationQuery,
): PluginConversationSnapshot | null {
	const want = (opts?.clientId ?? "").trim();
	if (want) {
		const runtime = runtimes.get(want);
		if (runtime) {
			try {
				const conv = runtime.registry.activeConv() ?? runtime.registry.list().at(-1);
				if (conv) {
					const snap = snapshotForConversation(runtime, conv);
					if (snap) return snap;
				}
			} catch {}
		}
	}
	const snaps: PluginConversationSnapshot[] = [];
	for (const runtime of runtimes.values()) {
		try {
			const conv = runtime.registry.activeConv() ?? runtime.registry.list().at(-1);
			if (conv) {
				const s = snapshotForConversation(runtime, conv);
				if (s) snaps.push(s);
			}
		} catch {}
	}
	return pickLatestClientSnapshot(snaps);
}

export function notifyPluginModelChange(
	engine: {
		onClientModelChanged?: ((snap: PluginConversationSnapshot) => void) | undefined;
	},
	modelKeys: Map<string, string>,
	runtimes: ReadonlyMap<string, ClientRuntime>,
	clientId: string,
	conversationId: string,
): void {
	if (!engine.onClientModelChanged) return;
	try {
		const snap = readConversationForPlugins(runtimes, { clientId });
		if (!snap || snap.conversationId !== conversationId) return;
		const key = modelChangeKey(snap);
		if (modelKeys.get(snap.conversationId) === key) return;
		modelKeys.set(snap.conversationId, key);
		engine.onClientModelChanged(snap);
	} catch (err) {
		console.error("[core-engine] onClientModelChanged failed:", err);
	}
}

export function pickPluginClient(runtimes: ReadonlyMap<string, ClientRuntime>): DispatchSession | undefined {
	let fallback: ClientRuntime | undefined;
	for (const runtime of runtimes.values()) {
		if (!fallback) fallback = runtime;
		try {
			if (runtime.registry.list().length > 0) {
				fallback = runtime;
				break;
			}
		} catch {}
	}
	if (!fallback) return undefined;
	const runtime = fallback;
	const handlers = runtime.handlers();
	return Object.assign(Object.create(handlers), {
		listRunningForPlugins(): Array<{
			id: string;
			title: string;
			cwd: string;
			kind: "running";
			isStreaming: boolean;
		}> {
			return runtime.registry.list().map((conv) => {
				const opened = runtime.options.sessions?.get(conv.id);
				return {
					id: conv.id,
					title: conv.meta.title,
					cwd: conv.meta.cwd,
					kind: "running" as const,
					isStreaming: opened?.session.isStreaming ?? conv.phase === "running",
				};
			});
		},
		async listHistoryForPlugins(_limit = 50) {
			return [];
		},
		async searchForPlugins(query: string, limit = 20) {
			const q = query.trim().toLowerCase();
			if (!q) return [];
			return runtime.registry
				.list()
				.filter((c) => c.meta.title.toLowerCase().includes(q))
				.slice(0, limit)
				.map((c) => ({ id: c.id, title: c.meta.title }));
		},
		async writeForPlugins(id: string, text: string) {
			const conv = runtime.registry.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (id !== runtime.registry.activeId()) await handlers.switchConversation(id);
			await handlers.prompt(text);
			return { ok: true };
		},
		async listModelsForPlugins() {
			return [];
		},
		async steerForPlugins(id: string, text: string) {
			const trimmed = text.trim();
			if (!trimmed) return { ok: false, error: "空消息" };
			const conv = runtime.registry.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			try {
				await runtime.noteConversation(id, trimmed);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},
		async abortForPlugins(id?: string) {
			if (id) {
				const conv = runtime.registry.get(id);
				if (!conv) return { ok: false, error: `未知对话：${id}` };
				const opened = runtime.options.sessions?.get(id);
				await opened?.session.abort?.();
				return { ok: true };
			}
			await handlers.abort();
			return { ok: true };
		},
	});
}

export function subscribePluginSessionEvents(options: {
	session: any;
	conv: Conversation;
	clientId: string;
	sessionId?: string;
	onChange: () => void;
	onToolEvent?: ((ev: PluginToolEvent) => void) | undefined;
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
}): () => void {
	if (!options.session?.subscribe) return () => {};
	const toolStarts = new Map<string, number>();
	return options.session.subscribe((event: any) => {
		try {
			options.onChange();
			if (!event || typeof event !== "object") return;
			const now = Date.now();
			switch (event.type) {
				case "tool_execution_start": {
					if (event.toolCallId) toolStarts.set(event.toolCallId, now);
					options.onToolEvent?.({
						phase: "start",
						toolName: event.toolName,
						conversationId: options.conv.id,
						toolCallId: event.toolCallId,
					});
					options.onRunEvent?.({
						type: "tool_start",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						at: now,
					});
					break;
				}
				case "tool_execution_end": {
					const startedAt = event.toolCallId ? toolStarts.get(event.toolCallId) : undefined;
					if (event.toolCallId) toolStarts.delete(event.toolCallId);
					const durationMs = startedAt !== undefined ? now - startedAt : undefined;
					options.onToolEvent?.({
						phase: "end",
						toolName: event.toolName,
						conversationId: options.conv.id,
						toolCallId: event.toolCallId,
						...(durationMs !== undefined ? { durationMs } : {}),
						isError: event.isError,
					});
					options.onRunEvent?.({
						type: "tool_end",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						...(durationMs !== undefined ? { durationMs } : {}),
						isError: event.isError,
						at: now,
					});
					break;
				}
				case "agent_start": {
					options.onRunEvent?.({
						type: "run_start",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						at: now,
					});
					break;
				}
				case "agent_end": {
					options.onRunEvent?.({
						type: "run_end",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						at: now,
					});
					break;
				}
				case "turn_start": {
					options.onRunEvent?.({
						type: "turn_start",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						at: now,
					});
					break;
				}
				case "turn_end": {
					options.onRunEvent?.({
						type: "turn_end",
						conversationId: options.conv.id,
						clientId: options.clientId,
						sessionId: options.sessionId,
						at: now,
					});
					break;
				}
			}
		} catch (err) {
			console.error("[core-engine] subscribePluginSessionEvents failed:", err);
		}
	});
}

export async function chatFromPlugin(
	engine: {
		runtimes: Map<string, ClientRuntime>;
		attach(clientId: string, send: (msg: any) => void): Promise<any>;
		isQuiesced(): boolean;
	},
	pluginId: string,
	req: PluginChatRequest,
): Promise<{ conversationId: string; clientId: string; sessionId?: string; runId?: string }> {
	const safe = String(pluginId ?? "plugin").replace(/[^A-Za-z0-9_-]/g, "") || "plugin";
	const acct = String(req?.accountId ?? "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
	const clientId = `plugin:${safe}:${acct}`;
	const text = String(req?.text ?? "");
	if (!text.trim()) throw new Error("chatFromPlugin: text 为空");
	if (engine.isQuiesced()) throw new QuiesceRejectedError("插件无头调用被拒绝，请等服务器恢复后重试");
	const runId = `pr-${randomUUID()}`;
	const target = String(req?.conversationId ?? "").trim();
	if (target) {
		for (const [ownerId, runtime] of engine.runtimes) {
			const conv = runtime.registry.get(target);
			if (conv) {
				if (req.model) await runtime.handlers().setModel(req.model);
				if (req.thinkingLevel) runtime.handlers().setThinking(req.thinkingLevel as any);
				void runtime.handlers().prompt(text);
				return {
					conversationId: conv.id,
					clientId: ownerId,
					sessionId: conv.meta.sessionFile ?? conv.id,
					runId,
				};
			}
		}
	}
	let runtime = engine.runtimes.get(clientId);
	if (!runtime) {
		await engine.attach(clientId, () => {});
		runtime = engine.runtimes.get(clientId);
	}
	if (!runtime) throw new Error(`chatFromPlugin: failed to attach client ${clientId}`);
	if (req.cwd) {
		await runtime.handlers().setCwd(req.cwd);
	}
	if (req.model) {
		await runtime.handlers().setModel(req.model);
	}
	if (req.thinkingLevel) {
		runtime.handlers().setThinking(req.thinkingLevel as any);
	}
	const conv = runtime.registry.activeConv() ?? runtime.createConversation();
	void runtime.handlers().prompt(text);
	return { conversationId: conv.id, clientId, sessionId: conv.meta.sessionFile ?? conv.id, runId };
}
