/**
 * session-turns — 「这一段文字要不要/能不能喂给 AgentSession」的唯一单源（#958）。
 *
 * 背景：SDK 的 `AgentSession` 被 `dispose()` 之后不会自我防护——runner 只是被打上 stale 标记，
 * 但 `sdk.js` 仍从 `extensionRunnerRef` 取它，于是「退役会话又被喂一轮」的每一轮都会
 * 全量 `structuredClone` + 每扩展一条 stale 报错（实测单会话 3,659 条 / 9.7 MB 日志）。
 * 补丁层（`patch-extension-runner.ts`）让这个状态**无害**，但真正的问题是**来源**：
 * 往会话里塞文字的地方原先散在 8 个文件、16 处，各写各的 `isStreaming ? steer : sendUserMessage`。
 * 只要还有一处直接调 SDK，就还有一条能喂到退役会话上的路。
 *
 * 所以这里收成两个单源：
 * 1. **退役**：`guardSession()` 在宿主接管会话时包一层 `dispose`，任何来源的 dispose（reload、
 *    force reset、沙盒清理、进程关闭、SDK 自己换会话）都会把该 session 记进 `retired`；
 *    `isRetiredSession()` 是唯一判定。
 * 2. **喂轮**：`promptSession()` / `steerSession()` / `runTurn()` 是唯一出口，退役即抛
 *    `SessionRetiredError`（fail-closed：没有「无记忆跑一轮」的中间态）。其余 `server/**`
 *    禁止直接调用 `sendUserMessage` / `session.steer` / `session.prompt`，由
 *    `tests/unit/session-turn-single-source.test.ts` 静态守卫。
 *
 * 语义选择（#958 讨论结论）：退役是**终态**，不懒重建。重建（`performForceResetConversation`）
 * 走的是「新 session 接管同一个 Conversation」，旧 session 退役后不会再被用到；投递门在
 * 退役窗口里返回 `gated`（意图留队），等新 session 绑好后重投，消息不会丢。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 已退役（dispose 过）的会话对象。按对象身份记，与 `session-identity.ts` 同口径。 */
const retired = new WeakSet<object>();

/** 退役会话收到一轮输入时抛的错。调用方可据此走「留队稍后重投」或如实报错。 */
export class SessionRetiredError extends Error {
	readonly code = "session_retired";

	constructor(detail = "this conversation has been retired") {
		super(`Cannot run a turn: ${detail}. Open the conversation again instead.`);
		this.name = "SessionRetiredError";
	}
}

export function isRetiredSession(session: unknown): boolean {
	return typeof session === "object" && session !== null && retired.has(session);
}

/**
 * SDK 侧兜底：把 `extensionRunnerRef.current` 清掉，让 `sdk.js` 的 `if (!runner) return messages`
 * 生效。`patch-extension-runner.ts` 已经在 SDK 源码里做了同样的事；这里覆盖「跑的是没被补丁
 * 命中过的 SDK 副本」（用户跟随更新的全局 SDK、源码结构变化后补丁降级）的情形。
 */
function clearStaleRunnerRef(session: object): void {
	try {
		const ref = (session as { _extensionRunnerRef?: { current?: unknown } })._extensionRunnerRef;
		if (ref && typeof ref === "object") ref.current = undefined;
	} catch {
		// 私有字段不存在或不可写：退化为「只由补丁层防护」。
	}
}

export function retireSession(session: unknown): void {
	if (typeof session !== "object" || session === null) return;
	retired.add(session);
	clearStaleRunnerRef(session);
}

const GUARD_MARK = Symbol.for("pi-web-ui.session-turns.guarded");

/**
 * 接管一个 `AgentSession`：`dispose()` 一旦发生就把该会话标成退役。幂等。
 * 必须在**宿主拿到会话的第一个地方**调用（`makeConversation` / `bindSession`），
 * 这样「谁 dispose 的」就不重要了——含 SDK 内部的会话替换。
 */
export function guardSession<T extends object>(session: T): T {
	if (typeof session !== "object" || session === null) return session;
	const target = session as T & { dispose?: () => unknown } & { [GUARD_MARK]?: true };
	if (target[GUARD_MARK]) return session;
	const original = target.dispose;
	if (typeof original !== "function") return session;
	Object.defineProperty(target, GUARD_MARK, { value: true, enumerable: false, configurable: false });
	target.dispose = function guardedDispose(this: unknown) {
		retireSession(session);
		return (original as () => unknown).call(this);
	};
	return session;
}

function assertTurnable(session: AgentSession | undefined, action: string): asserts session is AgentSession {
	if (!session) throw new SessionRetiredError(`the conversation for "${action}" is gone`);
	if (isRetiredSession(session)) throw new SessionRetiredError(`the conversation for "${action}" was disposed`);
}

export interface PromptSessionOptions {
	/** 正在跑一轮时怎么投：`steer` 插队 / `followUp` 等这轮结束；缺省 = 开新一轮。 */
	deliverAs?: "steer" | "followUp";
}

/**
 * 唯一「开一轮 / 投一条用户消息」的出口（SDK `sendUserMessage`）。
 *
 * 刻意**不是 async**：直接把 SDK 的 promise 返回给调用方，微任务时序与改造前完全一致
 * （投递队列的假体测试按 tick 数收尾，多一层 await 就会改变到达顺序）。
 * 退役时用 rejected promise 报错，这样 `void promptSession(...).catch(...)` 依旧成立。
 */
export function promptSession(
	session: AgentSession | undefined,
	text: string,
	options: PromptSessionOptions = {},
): Promise<void> {
	try {
		assertTurnable(session, "prompt");
	} catch (err) {
		return Promise.reject(err);
	}
	// 参数形态与直接调用保持一字不差（假体与调用方都按原样断言）。
	return options.deliverAs
		? session.sendUserMessage(text, { deliverAs: options.deliverAs })
		: session.sendUserMessage(text);
}

type SteerImages = Parameters<AgentSession["steer"]>[1];

/** 唯一「插进正在跑的一轮」的出口（SDK `steer`）。同步委托，理由同 `promptSession()`。 */
export function steerSession(session: AgentSession | undefined, text: string, images?: SteerImages): Promise<void> {
	try {
		assertTurnable(session, "steer");
	} catch (err) {
		return Promise.reject(err);
	}
	// 没图就只传正文：与各调用点改造前的调用形态一字不差（假体按参数个数断言）。
	return (images ? session.steer(text, images) : session.steer(text)).then(() => {});
}

type TurnPromptOptions = Parameters<AgentSession["prompt"]>[1];

/** 唯一「按 SDK prompt 语义跑一轮」的出口（画布 / 插件等按 `prompt()` 语义调用的地方）。 */
export function runTurn(session: AgentSession | undefined, text: string, options?: TurnPromptOptions): Promise<void> {
	try {
		assertTurnable(session, "run");
	} catch (err) {
		return Promise.reject(err);
	}
	return options ? session.prompt(text, options) : session.prompt(text);
}
