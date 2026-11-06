import { readFileSync, statSync } from "node:fs";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";
import type { ScheduleToolHost } from "./schedule-agent-tool.js";
import type { SchedulerStore } from "./scheduler-tasks.js";
import type { ConversationReadHost } from "./conversation-read-tool.js";
import { parseTranscriptLines } from "./conversation-read-tool.js";
import type { ClaimFilesHost } from "./claim-files-tool.js";
import type { ClaimStore } from "./claim-store.js";
import { readTouchSidecar } from "./claim-store.js";
import type { CompactContextHost, PendingCompaction } from "./compact-context-tool.js";
import type { SkillToolHost } from "./skill-tool.js";
import type { AgentMessage } from "./serialize.js";
import type { Conversation } from "./agent-service.js";
import { MAX_TRANSCRIPT_SCAN_BYTES, piSessionsRoot } from "./session-search.js";

export function createScheduleToolHost(ctx: {
	getSchedulerStore: () => SchedulerStore | undefined;
	getCwd: () => string;
	getActiveId: () => string;
	getConversation: (id: string) => Conversation | undefined;
}): ScheduleToolHost {
	return {
		store: () => ctx.getSchedulerStore(),
		cwd: () => ctx.getCwd(),
		activeConversationId: () => ctx.getActiveId(),
		conversationInfo: (id?: string) => {
			try {
				const activeId = ctx.getActiveId();
				const target = (id ?? "").trim() ? ctx.getConversation((id ?? "").trim()) : ctx.getConversation(activeId);
				if (!target) return undefined;
				let sessionFile = "";
				try {
					sessionFile = String(target.session.sessionFile ?? "");
				} catch {
					sessionFile = "";
				}
				return { cwd: target.cwd ?? ctx.getCwd(), sessionFile };
			} catch {
				return undefined;
			}
		},
	};
}

export function createConversationReadHost(ctx: {
	getConversations: () => Iterable<Conversation>;
	getConversation: (id: string) => Conversation | undefined;
	getConvTranscript: (
		conv: Conversation,
	) => Parameters<ConversationReadHost["readRunningConversation"]>[0] extends undefined ? never : any;
	getCwd: () => string;
}): ConversationReadHost {
	return {
		listRunningConversations: () => {
			const out: {
				id: string;
				title: string;
				cwd: string;
				messageCount: number;
				isStreaming: boolean;
				isSubagent: boolean;
				parentId?: string;
			}[] = [];
			for (const c of ctx.getConversations()) {
				let messageCount = 0;
				let isStreaming = false;
				try {
					messageCount = c.session.getSessionStats().totalMessages;
					isStreaming = c.session.isStreaming;
				} catch {}
				out.push({
					id: c.id,
					title: c.title,
					cwd: c.cwd,
					messageCount,
					isStreaming,
					isSubagent: !!c.isSubagent,
					...(c.parentId ? { parentId: c.parentId } : {}),
				});
			}
			return out;
		},
		readRunningConversation: (id) => {
			const c = ctx.getConversation(id);
			if (!c) return undefined;
			return { title: c.title, cwd: c.cwd, isSubagent: !!c.isSubagent, messages: ctx.getConvTranscript(c) };
		},
		listHistorySessions: async (scope, cwd) => {
			let infos: SessionInfo[];
			const targetCwd = cwd || ctx.getCwd();
			const extra = piSessionsRoot();
			if (scope === "all") {
				const defaultAll = await SessionManager.listAll().catch(() => []);
				const extraAll = extra ? await SessionManager.listAll(extra).catch(() => []) : [];
				const seen = new Set<string>();
				infos = [];
				for (const s of [...defaultAll, ...extraAll]) {
					const key = normalizePathKey(s.path);
					if (!seen.has(key)) {
						seen.add(key);
						infos.push(s);
					}
				}
				infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			} else {
				const projectInfos = await SessionManager.list(targetCwd).catch(() => []);
				const extraInfos = extra ? await SessionManager.list(targetCwd, extra).catch(() => []) : [];
				const seen = new Set<string>();
				infos = [];
				for (const s of [...projectInfos, ...extraInfos]) {
					const key = normalizePathKey(s.path);
					if (!seen.has(key)) {
						seen.add(key);
						infos.push(s);
					}
				}
				infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			}
			return infos.map((s) => ({
				path: s.path,
				name: s.name,
				firstMessage: s.firstMessage,
				messageCount: s.messageCount,
				modified: s.modified.getTime(),
				cwd: s.cwd,
			}));
		},
		readTouchSidecar: (id, path) => {
			try {
				if (id) {
					const c = ctx.getConversation(id);
					let file: string | undefined;
					try {
						file = c?.session.sessionFile ?? undefined;
					} catch {
						file = undefined;
					}
					return readTouchSidecar(file);
				}
				if (path) return readTouchSidecar(path);
				return undefined;
			} catch {
				return undefined;
			}
		},
		readHistorySession: async (path) => {
			const extra = piSessionsRoot();
			const defaultAll = await SessionManager.listAll().catch(() => []);
			const extraAll = extra ? await SessionManager.listAll(extra).catch(() => []) : [];
			const seen = new Set<string>();
			const all: SessionInfo[] = [];
			for (const s of [...defaultAll, ...extraAll]) {
				const key = normalizePathKey(s.path);
				if (!seen.has(key)) {
					seen.add(key);
					all.push(s);
				}
			}
			const targetKey = normalizePathKey(path);
			const hit = all.find((s) => normalizePathKey(s.path) === targetKey);
			if (!hit) return undefined;
			try {
				if (statSync(hit.path).size > MAX_TRANSCRIPT_SCAN_BYTES) return undefined;
				const text = readFileSync(hit.path, "utf8");
				return {
					title: hit.name || hit.firstMessage,
					cwd: hit.cwd,
					sessionPath: hit.path,
					messages: parseTranscriptLines(text),
				};
			} catch {
				return undefined;
			}
		},
	};
}

export function createClaimToolHost(ctx: {
	resolveTarget: (ownerId?: string) => Conversation | undefined;
	getActiveId: () => string;
	getCwd: () => string;
	getClaimStore: () => ClaimStore | undefined;
	ownerId?: string;
}): ClaimFilesHost {
	const target = () => ctx.resolveTarget(ctx.ownerId);
	return {
		cwd: () => target()?.cwd ?? ctx.getCwd(),
		self: () => {
			const t = target();
			return { convId: t?.id ?? ctx.getActiveId(), title: t?.title ?? "" };
		},
		store: () => ctx.getClaimStore(),
	};
}

export function createCompactContextHost(ctx: {
	resolveTarget: (ownerId?: string) => Conversation | undefined;
	getActiveId: () => string;
	ownerId?: string;
}): CompactContextHost {
	const target = () => ctx.resolveTarget(ctx.ownerId);
	return {
		conversationId: () => target()?.id ?? ctx.getActiveId(),
		getContextStats: () => {
			const conv = target();
			if (!conv) return { messageCount: 0, estimatedTokens: 0 };
			let messages: AgentMessage[] = [];
			try {
				messages = conv.session.messages;
			} catch {
				messages = [];
			}
			let totalChars = 0;
			for (const m of messages) {
				if (m && typeof m === "object" && "content" in m) {
					const content = (m as { content?: unknown }).content;
					if (Array.isArray(content)) {
						for (const c of content) {
							if (
								c &&
								typeof c === "object" &&
								"type" in c &&
								(c as { type: unknown }).type === "text" &&
								typeof (c as { text?: unknown }).text === "string"
							) {
								totalChars += (c as { text: string }).text.length;
							}
						}
					} else if (typeof content === "string") {
						totalChars += content.length;
					}
				}
			}
			return {
				messageCount: messages.length,
				estimatedTokens: Math.ceil(totalChars / 4),
			};
		},
		scheduleCompaction: (pending: PendingCompaction) => {
			const conv = target();
			if (conv) {
				conv.pendingCompaction = pending;
			}
		},
	};
}

export function createSkillToolHost(ctx: {
	resolveTarget: (ownerId?: string) => Conversation | undefined;
	getDisabledSkills: () => string[];
	getMaxFileBytes?: () => number;
	ownerId?: string;
}): SkillToolHost {
	return {
		maxFileBytes: ctx.getMaxFileBytes,
		listSkills: () => {
			try {
				const target = ctx.resolveTarget(ctx.ownerId);
				const all = target?.session.resourceLoader.getSkills().skills ?? [];
				const disabled = new Set(ctx.getDisabledSkills());
				return all
					.filter((s) => !disabled.has(s.name))
					.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
						source: (s as { source?: string }).source,
						scope: (s as { scope?: string }).scope,
					}));
			} catch {
				return [];
			}
		},
	};
}
