import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type AgentSession,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertSupportedTranscriptVersion, openSessionManagerAsync } from "../../session-open.js";
import { guardSession } from "../../session-turns.js";
import { prepareTranscriptForOpen } from "../../transcript-prepare.js";
import type { TurnCapableSession } from "../../contracts/session.js";

export interface OpenSessionOptions {
	cwd: string;
	agentDir: string;
	/** 要接着写的那份转录；缺省 = 在 `cwd` 下新建会话。 */
	sessionFile?: string;
	/** 本次要注册的工具名（由 `domains/tools` 的装载域给出）；缺省 = SDK 自己的默认集。 */
	tools?: readonly string[];
	/**
	 * 宿主自定义工具（审批、提问、子代理等能力的唯一入口）；缺省 = 不注册。
	 * 类型故意收成 `unknown`：app 层不许依赖 SDK，形状在这里收回 `ToolDefinition`。
	 */
	customTools?: readonly unknown[];
}

export interface OpenedSession {
	session: TurnCapableSession;
	sessionId: string;
	sessionFile?: string;
	dispose(): void;
}

/** 打开会话的哪一步失败：调用方据此区分「转录读不了」与「SDK 建不起来」。 */
export type OpenSessionPhase = "open-transcript" | "create-session";

/** 打开会话失败：必带 cwd 与目标转录，禁静默返回半成品。 */
export class OpenSessionError extends Error {
	readonly code = "session_open_failed";
	readonly phase: OpenSessionPhase;
	readonly cwd: string;
	readonly sessionFile?: string;

	constructor(phase: OpenSessionPhase, cwd: string, sessionFile: string | undefined, cause: unknown) {
		super(`打开会话失败（${phase}）：cwd=${cwd} file=${sessionFile ?? "<新建会话>"}：${describeCause(cause)}`, {
			cause,
		});
		this.name = "OpenSessionError";
		this.phase = phase;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
	}
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim()) return cause.message;
	return String(cause);
}

async function isExistingFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function openSessionManager(cwd: string, sessionFile: string | undefined): Promise<SessionManager> {
	if (sessionFile === undefined) return SessionManager.create(cwd);
	const existing = await isExistingFile(sessionFile);
	if (!existing) throw new Error("转录文件不存在，已拒绝在别处新建来假装打开（fail-closed）");
	// 顺序是硬约束：版本校验必须早于打开前修复，否则看不懂的转录会被新内核按自己的语义改写。
	assertSupportedTranscriptVersion(sessionFile);
	await prepareTranscriptForOpen(sessionFile);
	return openSessionManagerAsync(sessionFile);
}

export interface BranchFileOptions {
	/** 被派生的转录（必须已落盘）。 */
	sessionFile: string;
	/** 分叉点条目 id：新转录只保留「根 → 该条目」这条路径。 */
	leafId: string;
}

/**
 * `forkSession` 的 SDK 窄口：从现有转录派生一份**新**转录，返回新文件路径。
 *
 * 语义逐字就是 `SessionManager.createBranchedSession(leafId)`：写一份新文件（新 session id，头部
 * `parentSession` 指向原文件），原文件一个字节都不动。**必须用新开的 manager**——
 * `createBranchedSession()` 会把 manager 自己改成新会话（`this.sessionFile` 换掉），用活动会话的
 * manager 等于把原对话迁走，下一次 append 就写进新文件 = 两个对话同时写一份转录。
 *
 * 位置参数（`messageId` / `position`）在调用方解析成 `leafId`：消息 → 条目单源在 `domains/turns/entries`，
 * 这里只认条目 id（SDK 不认 UI 消息 id）。
 */
export async function createBranchFile(options: BranchFileOptions): Promise<string> {
	const source = resolve(options.sessionFile);
	if (!(await isExistingFile(source))) {
		throw new Error(`源转录不存在，已拒绝派生（fail-closed）：${source}`);
	}
	// 版本门禁在 `openSessionManagerAsync` 里（读首行即判，不把看不懂的转录按新语义再盘一遍）。
	const manager = await openSessionManagerAsync(source);
	const branch = manager.createBranchedSession(options.leafId);
	if (!branch) throw new Error(`SDK 没有为分叉写出新转录（内存会话不支持派生）：${source}`);
	if (!(await isExistingFile(branch))) {
		// 分支路径上没有 user/assistant 消息时 SDK 只算路径、不落盘：显式拒绝，别把空路径当成功。
		throw new Error(`分叉路径上没有消息，SDK 未落盘任何内容：${branch}`);
	}
	assertSupportedTranscriptVersion(branch);
	return branch;
}

/**
 * 新树里唯一建/开 SDK 会话的入口：返回窄面 `TurnCapableSession`，宿主拿到的会话一律先过
 * `guardSession()`（否则 dispose 之后退役记账不生效，#958）。
 *
 * 这里刻意只做「拿一个能喂轮的会话」：工具门控、提示词覆盖、模型钉定都在各自域里决定，
 * 适配器不替它们做默认值（否则两套默认值迟早打架）。因此未配置模型/auth 时 SDK 仍会建出会话
 * 并把问题降级成 `modelFallbackMessage`，真正报错发生在跑第一轮时。
 */
export async function openTurnSession(opts: OpenSessionOptions): Promise<OpenedSession> {
	const cwd = resolve(opts.cwd);
	const agentDir = resolve(opts.agentDir);
	const sessionFile = opts.sessionFile === undefined ? undefined : resolve(opts.sessionFile);

	let manager: SessionManager;
	try {
		manager = await openSessionManager(cwd, sessionFile);
	} catch (error) {
		throw new OpenSessionError("open-transcript", cwd, sessionFile, error);
	}

	let session: AgentSession;
	try {
		const services = await createAgentSessionServices({ cwd, agentDir });
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager: manager,
				...(opts.tools ? { tools: [...opts.tools] } : {}),
				...(opts.customTools ? { customTools: [...opts.customTools] as ToolDefinition[] } : {}),
			})
		).session;
	} catch (error) {
		throw new OpenSessionError("create-session", cwd, sessionFile, error);
	}

	const guarded = guardSession(session);
	const file = manager.getSessionFile();
	let disposed = false;
	return {
		session: guarded,
		sessionId: manager.getSessionId(),
		...(file === undefined ? {} : { sessionFile: file }),
		dispose() {
			// 幂等：先置位再 dispose，SDK 那边抛错也不会让调用方有机会重复 dispose 同一个会话。
			if (disposed) return;
			disposed = true;
			guarded.dispose();
		},
	};
}
