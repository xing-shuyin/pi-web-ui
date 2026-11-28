import { resolve } from "node:path";
import type { ServerMessage } from "../protocol.js";
import type { TransportPort } from "../contracts/ports.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { scanHistory } from "../domains/history/index.js";
import { canDeleteSessionPath, deleteSessionFile, dismissConversation } from "../domains/sessions/index.js";
import { readCwdFromSessionHeader } from "../session-search.js";

/** 删转录要用到的运行时事实（都是 thunk：判定发生在调用时，不在装配时快照）。 */
export interface DeleteSessionDeps {
	registry: ConversationRegistry<Conversation>;
	transport(): TransportPort;
	/** 列表根（`scanHistory` 的 `root`）：宿主拼的会话目录。 */
	historyRoot(): string | undefined;
	/** 上一轮扫盘的内存态（与 `list_sessions` / 历史帧共用同一份缓存）。 */
	historyState(): Parameters<typeof scanHistory>[0]["state"];
	/** 被删的是当前对话时，先把活动对话挪到次新会话（缺省：新建空白对话）。 */
	switchSessionTo(path: string): Promise<void>;
	/** 次新会话也不存在时新建一条空白对话。 */
	createBlankConversation(): void;
	/** 释放一个对话的运行时外壳（会话句柄）。 */
	closeSession?(conversationId: string): void;
	/** 允许删哪些路径（缺省 fail-closed）。 */
	isAllowedPath?(path: string): boolean;
	now(): number;
	/** 删成功后重扫历史列表（传 targetCwd 时刷新对应项目，否则刷新当前项目）。 */
	refreshSessions(targetCwd?: string): void | Promise<void>;
	clearPinnedSession?(path: string): void;
}

function normalizeForCompare(p: string): string {
	let resolved: string;
	try {
		resolved = resolve(p);
	} catch {
		resolved = p;
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samefile(a: string, b: string): boolean {
	return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * 删掉当前对话那份转录之后该接着看哪份（老 `deleteSession` 的 `loadSessionInfos` + 取次新）：
 * 同一项目目录里除被删那份之外最新的一个；一个都没有 = `undefined`（调用方落空白对话）。
 * 扫盘失败也当「没有」：宁肯开新空白对话，也不把半熟路径交给重绑。
 */
async function nextSessionAfterDeleting(deps: DeleteSessionDeps, deleted: string): Promise<string | undefined> {
	const root = deps.historyRoot();
	if (!root) return undefined;
	try {
		const scanned = await scanHistory({ root, state: deps.historyState() });
		return scanned.entries
			.filter((entry) => !samefile(entry.sessionFile, deleted))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionFile;
	} catch {
		return undefined;
	}
}

/**
 * `delete_session` 的完整语义（老 `ClientSession.deleteSession` 前半段 + 落盘删除）。
 *
 * 关键一条：被删的不是「没人用的历史文件」，而是**当前对话正拿着的那份**时，必须先把活动对话
 * 挑开（次新会话，没别的就新建空白），否则删完就剩一条挂着死文件的对话。后台还拿着它的
 * 对话则不删（它可能正在跑），只回一条 warning。
 */
export async function deleteSession(deps: DeleteSessionDeps, path: string): Promise<void> {
	const notice = (message: ServerMessage): void => {
		if (!deps.transport().isClosed()) deps.transport().send(message);
	};
	// 越界**先**判：老实现在动手之前就 return（挑开活动对话算动过手，不能等到删文件那一步才知道越界）。
	if (!canDeleteSessionPath(path, deps.isAllowedPath)) {
		notice({
			type: "notice",
			level: "error",
			text: "只能删除会话目录中的对话记录",
			textEn: "Only transcripts inside the session directory can be deleted",
		});
		await deps.refreshSessions();
		return;
	}
	const abs = (() => {
		try {
			return resolve(path);
		} catch {
			return path;
		}
	})();
	const holder = deps.registry.list().find((conv) => {
		const file = conv.meta.sessionFile;
		return file !== undefined && samefile(file, abs);
	});
	const activeId = deps.registry.activeId();
	const targetCwd = holder?.meta.cwd ?? (await readCwdFromSessionHeader(abs)) ?? undefined;

	if (holder && holder.id !== activeId) {
		notice({
			type: "notice",
			level: "warning",
			text: "该对话正在后台运行，请先停止或关闭该对话再删除",
			textEn: "This conversation is still running — stop or close it before deleting",
		});
		await deps.refreshSessions(targetCwd);
		return;
	}
	if (holder) {
		const next = await nextSessionAfterDeleting(deps, abs);
		if (next) await deps.switchSessionTo(next);
		else deps.createBlankConversation();
		// 挑开之后旧对话不该再挂在运行列表上（老实现 `removeConversation`）。
		if (deps.registry.has(holder.id)) {
			await dismissConversation({
				registry: deps.registry,
				conversationId: holder.id,
				now: deps.now,
				...(deps.closeSession ? { closeSession: deps.closeSession } : {}),
			});
		}
	}

	const result = await deleteSessionFile({
		registry: deps.registry,
		sessionFile: path,
		now: deps.now,
		...(deps.isAllowedPath ? { isAllowedPath: deps.isAllowedPath } : {}),
	});
	if (!result.deleted) {
		// 失败必须回话（fetch 成功 ≠ 删了）：越界 / 文件已不在两种原因分开说（老实现同口径）。
		const notAllowed = result.reason === "not-allowed";
		if (!notAllowed) {
			// 文件已不在磁盘时也清理钉子并刷新列表，避免前端残留幽灵行反复报“已不存在”。
			deps.clearPinnedSession?.(path);
		}
		await deps.refreshSessions(targetCwd);
		notice({
			type: "notice",
			level: "error",
			text: notAllowed ? "只能删除会话目录中的对话记录" : "该对话记录已不存在（可能已被删除）",
			textEn: notAllowed
				? "Only transcripts inside the session directory can be deleted"
				: "That transcript no longer exists (it may have been deleted already)",
		});
		return;
	}
	// 钉子落在已不存在的文件上：不清掉就是「永远点不亮的历史行」。
	deps.clearPinnedSession?.(path);
	// 历史列表是扫盘得到的：不重扫一拍，左栏就还顶着已删的那一行（老实现 `invalidateSessionInfos` + `refreshSessions`）。
	await deps.refreshSessions(targetCwd);
}

export interface DeleteProjectSessionsDeps extends Omit<DeleteSessionDeps, "historyRoot" | "switchSessionTo"> {
	historyRootFor(cwd: string): string | undefined;
}

/**
 * 批量删除指定项目下的全部历史对话记录（跳过仍在后台运行的会话转录）。
 */
export async function deleteProjectSessions(deps: DeleteProjectSessionsDeps, projectCwd: string): Promise<void> {
	const notice = (message: ServerMessage): void => {
		if (!deps.transport().isClosed()) deps.transport().send(message);
	};
	const activeId = deps.registry.activeId();
	const protectedFiles = new Set<string>();
	let activeInProject: Conversation | undefined;

	for (const conv of deps.registry.list()) {
		if (!samefile(conv.meta.cwd, projectCwd)) continue;
		if (conv.id === activeId) {
			activeInProject = conv;
		} else if (conv.meta.sessionFile) {
			protectedFiles.add(normalizeForCompare(conv.meta.sessionFile));
		}
	}

	if (activeInProject) {
		deps.createBlankConversation();
		if (deps.registry.has(activeInProject.id)) {
			await dismissConversation({
				registry: deps.registry,
				conversationId: activeInProject.id,
				now: deps.now,
				...(deps.closeSession ? { closeSession: deps.closeSession } : {}),
			});
		}
	}

	const root = deps.historyRootFor(projectCwd);
	let deletedCount = 0;
	if (root) {
		try {
			const scanned = await scanHistory({ root, state: deps.historyState() });
			for (const entry of scanned.entries) {
				if (protectedFiles.has(normalizeForCompare(entry.sessionFile))) continue;
				const result = await deleteSessionFile({
					registry: deps.registry,
					sessionFile: entry.sessionFile,
					now: deps.now,
					...(deps.isAllowedPath ? { isAllowedPath: deps.isAllowedPath } : {}),
				});
				if (result.deleted) {
					deps.clearPinnedSession?.(entry.sessionFile);
					deletedCount++;
				}
			}
		} catch {
			// 扫盘失败时仍刷新列表以保持状态一致
		}
	}

	await deps.refreshSessions(projectCwd);

	if (protectedFiles.size > 0) {
		notice({
			type: "notice",
			level: "warning",
			text: `已删除 ${deletedCount} 条对话记录，另有 ${protectedFiles.size} 条正在后台运行的对话未删除`,
			textEn: `Deleted ${deletedCount} transcript(s); ${protectedFiles.size} running in background were kept`,
		});
	} else if (deletedCount > 0) {
		notice({
			type: "notice",
			level: "info",
			text: `已删除 ${deletedCount} 条对话记录`,
			textEn: `Deleted ${deletedCount} transcript(s)`,
		});
	}
}
