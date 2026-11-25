import { resolve } from "node:path";
import type { ElsewhereRunning, ServerMessage } from "../protocol.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { FrameSender } from "./core-engine.js";
import { isOrphanAdoptionExcludedClientId, isPseudoClientId, isUnattendedClientId } from "../client-id-utils.js";
import { findMostRecentSessionFileFast } from "../session-parser.js";
import { resolveWorkspaceSessionDir } from "../remote-workspace.js";

export interface ElsewhereDeps {
	runtimes: ReadonlyMap<string, ClientRuntime>;
	sockets: ReadonlyMap<string, Set<FrameSender>>;
	offlineSince: ReadonlyMap<string, number>;
	hasQuestionOf?: (clientId: string, conversationId: string) => boolean;
	questionTitleOf?: (clientId: string, conversationId: string) => string | undefined;
}

/**
 * 跨客户端「别处运行中」行（issue #145 / #291）：
 * 把别的客户端里持有的对话下发给当前页（只读感知 + 手动过户定位）。
 * 离线残骸在宽限期内标 `ownerOffline` 下发，到期后自动消失。
 */
export function listExternalRunning(
	deps: ElsewhereDeps,
	excludeClientId: string,
	offlineTtlMs: number,
): ElsewhereRunning[] {
	const currentRuntime = deps.runtimes.get(excludeClientId);
	const localFiles = new Set<string>();
	const localCwdTitles = new Set<string>();
	if (currentRuntime) {
		for (const conv of currentRuntime.registry.list()) {
			if (conv.meta.sessionFile) {
				try {
					localFiles.add(resolve(conv.meta.sessionFile));
				} catch {}
			}
			localCwdTitles.add(`${conv.meta.cwd}\0${conv.meta.title}`);
		}
	}

	const dedupMap = new Map<string, ElsewhereRunning>();
	const now = Date.now();

	for (const [clientId, runtime] of deps.runtimes) {
		if (clientId === excludeClientId) continue;
		const isPseudo = isPseudoClientId(clientId);
		const offline = !isPseudo && (deps.sockets.get(clientId)?.size ?? 0) === 0;
		if (offline && offlineTtlMs <= 0) continue;
		const offlineTs = offline ? (deps.offlineSince.get(clientId) ?? 0) : 0;
		const exposeSubagents = isUnattendedClientId(clientId);

		const list = runtime.registry.list();
		const parentIds = new Set(list.filter((c) => c.meta.kind !== "subagent").map((c) => c.id));

		for (const conv of list) {
			const isSubagent = conv.meta.kind === "subagent";
			const streaming = conv.phase === "running";
			if (isSubagent && !exposeSubagents && !streaming) continue;
			if (isSubagent && (!conv.meta.parentId || !parentIds.has(conv.meta.parentId))) continue;

			const hasQ = deps.hasQuestionOf ? deps.hasQuestionOf(clientId, conv.id) : false;
			// 还没落盘且非流式、无问卷、默认标题的纯空白新对话不列入别处
			if (!streaming && !hasQ && conv.meta.title === "新对话" && !conv.meta.sessionFile) {
				continue;
			}

			const activity = conv.meta.lastActiveAt || 0;
			if (offline && !streaming) {
				const latest = Math.max(offlineTs, activity);
				if (latest > 0 && now - latest > offlineTtlMs) continue;
			}

			let normFile: string | undefined;
			if (conv.meta.sessionFile) {
				try {
					normFile = resolve(conv.meta.sessionFile);
				} catch {}
			}
			if (normFile && localFiles.has(normFile)) continue;
			if (localCwdTitles.has(`${conv.meta.cwd}\0${conv.meta.title}`)) continue;

			const qTitle = hasQ && deps.questionTitleOf ? deps.questionTitleOf(clientId, conv.id) : undefined;
			const entry: ElsewhereRunning = {
				title: conv.meta.title,
				cwd: conv.meta.cwd,
				isStreaming: streaming,
				owner: clientId,
				convId: conv.id,
				independent: true,
				...(isSubagent ? { isSubagent: true, parentId: conv.meta.parentId } : {}),
				...(normFile ? { sessionFile: normFile } : {}),
				...(isPseudo ? { pseudo: true as const } : {}),
				...(offline ? { ownerOffline: true as const } : {}),
				...(hasQ ? { hasQuestion: true as const } : {}),
				...(qTitle ? { questionTitle: qTitle } : {}),
			};

			const dedupKey = normFile ? `file:${normFile}` : `title:${conv.meta.cwd}\0${conv.meta.title}`;
			const existing = dedupMap.get(dedupKey);
			if (existing) {
				const preferNew =
					(!existing.isStreaming && entry.isStreaming) ||
					(!existing.hasQuestion && entry.hasQuestion) ||
					(Boolean(existing.ownerOffline) && !entry.ownerOffline);
				if (preferNew) {
					dedupMap.set(dedupKey, entry);
				}
				continue;
			}
			dedupMap.set(dedupKey, entry);
		}
	}

	return [...dedupMap.values()];
}

/** 查找某个转录文件是否正被别的客户端持有（用于避免多端双写）。 */
export function findSessionOwner(
	runtimes: ReadonlyMap<string, ClientRuntime>,
	sockets: ReadonlyMap<string, Set<FrameSender>>,
	sessionFilePath: string,
	excludeClientId: string,
): { ownerId: string; conversationId: string; title: string; isStreaming: boolean; connected: boolean } | null {
	let targetNorm = "";
	try {
		targetNorm = resolve(sessionFilePath);
	} catch {
		return null;
	}
	for (const [id, runtime] of runtimes) {
		if (id === excludeClientId) continue;
		for (const conv of runtime.registry.list()) {
			if (!conv.meta.sessionFile) continue;
			try {
				if (resolve(conv.meta.sessionFile) === targetNorm) {
					const connected = (sockets.get(id)?.size ?? 0) > 0;
					const isStreaming = conv.phase === "running";
					return { ownerId: id, conversationId: conv.id, title: conv.meta.title, isStreaming, connected };
				}
			} catch {}
		}
	}
	return null;
}

export function offlineRowsTtlMs(): number {
	const raw = String(process.env.PI_WEB_OFFLINE_ROWS_TTL_MS ?? "")
		.trim()
		.toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return 0;
	const v = Number(raw);
	const ms = Number.isFinite(v) && v > 0 ? v : 30 * 60_000;
	return Math.min(ms, 6 * 60 * 60_000);
}

export function armOfflineRowExpiry(
	clientId: string,
	runtime: ClientRuntime,
	offlineSince: ReadonlyMap<string, number>,
	offlineTimers: Map<string, ReturnType<typeof setTimeout>>,
	onExpire: () => void,
): void {
	const ttl = offlineRowsTtlMs();
	if (ttl <= 0) return;
	const prev = offlineTimers.get(clientId);
	if (prev) clearTimeout(prev);
	let activity = 0;
	for (const conv of runtime.registry.list()) {
		activity = Math.max(activity, conv.meta.lastActiveAt || 0);
	}
	const since = Math.max(offlineSince.get(clientId) ?? 0, activity || 0);
	const delay = Math.max(100, since + ttl - Date.now());
	const timer = setTimeout(() => {
		offlineTimers.delete(clientId);
		onExpire();
	}, delay);
	timer.unref?.();
	offlineTimers.set(clientId, timer);
}

export function clearOfflineRows(
	clientId: string,
	offlineSince: Map<string, number>,
	offlineTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
	offlineSince.delete(clientId);
	const timer = offlineTimers.get(clientId);
	if (timer) {
		clearTimeout(timer);
		offlineTimers.delete(clientId);
	}
}

export async function checkHeldSessionNotice(
	runtimes: ReadonlyMap<string, ClientRuntime>,
	sockets: ReadonlyMap<string, Set<FrameSender>>,
	agentDir: string,
	cwd: string,
	clientId: string,
): Promise<ServerMessage | undefined> {
	if (runtimes.size === 0 || isOrphanAdoptionExcludedClientId(clientId)) return undefined;
	try {
		const sessionBaseDir = resolveWorkspaceSessionDir(agentDir, cwd);
		const recentPath = await findMostRecentSessionFileFast(sessionBaseDir, cwd);
		const recent = recentPath ? resolve(recentPath) : undefined;
		const owner = recent ? findSessionOwner(runtimes, sockets, recent, clientId) : null;
		if (!owner || (!owner.connected && !owner.isStreaming)) return undefined;
		return owner.isStreaming
			? {
					type: "notice",
					level: "info",
					text: `该项目最近的对话「${owner.title}」正在另一处运行，为你停在了新对话 —— 直接打开会造出第二个写者。左栏「运行的对话」里能看到它（标着“另一处”），等它跑完再打开。`,
					textEn: `The most recent conversation ("${owner.title}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
				}
			: {
					type: "notice",
					level: "info",
					text: `该项目最近的对话「${owner.title}」在另一处开着（当前空闲），为你停在了空白新对话 —— 可在左栏「运行的对话」里把它过户过来继续看，或从历史对话里打开（只留一处发送消息，否则历史分叉）。`,
					textEn: `The most recent conversation ("${owner.title}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
				};
	} catch {
		return undefined;
	}
}

export function handleClientDetach(
	clientId: string,
	runtime: ClientRuntime,
	offlineSince: Map<string, number>,
	offlineTimers: Map<string, ReturnType<typeof setTimeout>>,
	onExpire: () => void,
): boolean {
	if (clientId.startsWith("canvas:") || clientId.startsWith("canvas-") || clientId.startsWith("device-task-")) {
		return true;
	}
	if (!isPseudoClientId(clientId)) {
		offlineSince.set(clientId, Date.now());
		armOfflineRowExpiry(clientId, runtime, offlineSince, offlineTimers, onExpire);
	}
	return false;
}
