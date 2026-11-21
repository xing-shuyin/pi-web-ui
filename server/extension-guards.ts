/**
 * extension-guards — 宿主内联扩展（`extensionFactories`）对「会话已失效」的统一降级（#958）。
 *
 * SDK 在会话被替换 / reload / dispose 之后会把整个 `ExtensionRunner` 标成 stale，之后任何一次
 * `ctx.*` 访问都抛 `This extension ctx is stale ...`。SDK 自己按 handler try/catch + `onError`
 * 上报，所以这些抛不会炸进程 —— 但长会话里就是「每轮每扩展一条带栈报错」（实测单会话 3,659 条 /
 * 9.7 MB 日志）。宿主能做的、也应当做到的是：**stale 就当这一轮没这个扩展**，而不是把同一个
 * 已知失效的状态反复抛出去。
 *
 * 两种降级语义，调用点必须显式选一个：
 *   - `skip`（缺省）：返回 undefined = 本轮该钩子不生效。适用 `context` / `before_agent_start` /
 *     `before_provider_request` 这类「改请求」的钩子。
 *   - `block`：拒绝这次工具调用。适用守卫类钩子（沙箱终局闸门 / Bot 授权）—— 必须 fail-closed，
 *     绝不能在 ctx 失效时静默放行。
 *
 * 只吞「stale」一种错误；其它异常照旧抛出交给 SDK 的 `onError`，避免把真实 bug 也静默掉。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * SDK `ExtensionRunner.assertActive()` 抛出的文案（`invalidate()` 的默认 message）。
 * 用 `invalidate(custom)` 时自定义文案可能不带这句话，那就按普通错误处理（仍然如实上报）。
 */
const STALE_CONTEXT_MARKER = /extension ctx is stale/i;

export function isStaleExtensionContextError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const message = (err as { message?: unknown }).message;
	return typeof message === "string" && STALE_CONTEXT_MARKER.test(message);
}

/** 保持原 handler 的签名不变，`pi.on(...)` 的重载解析因此和包装前完全一致。 */
type HandlerLike = (event: never, ctx: ExtensionContext) => unknown;

export interface StaleSafeOptions<E> {
	/** stale 时的返回值；守卫类钩子用 `() => ({ block: true, reason })` 保证 fail-closed。 */
	onStale?: (event: E) => unknown;
}

export function staleSafe<H extends HandlerLike>(handler: H, options: StaleSafeOptions<Parameters<H>[0]> = {}): H {
	const wrapped = async (event: Parameters<H>[0], ctx: ExtensionContext): Promise<unknown> => {
		try {
			return await (handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown)(event, ctx);
		} catch (err) {
			if (!isStaleExtensionContextError(err)) throw err;
			return options.onStale?.(event);
		}
	};
	return wrapped as unknown as H;
}
