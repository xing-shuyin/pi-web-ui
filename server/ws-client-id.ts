import { isBotExecutionRegistered } from "./device-center/bot-execution.js";

export const MAX_CLIENT_ID_LEN = 128;

const CLIENT_ID_RE = /^[A-Za-z0-9:_-]+$/;

/** 服务端内部专用的持有方前缀：外部 hello 不得自报（否则可挂到别人的清账上）。 */
const INTERNAL_CLIENT_PREFIXES = ["scheduler:", "plugin:"] as const;

/**
 * 校验收到的 hello.clientId（issue #971）：字符/长度只是底线，还要判「这个命名空间归谁」。
 * `scheduler:` / `plugin:` 是服务端内部持有方；`device-task-` 必须已在 Bot 执行注册表里登记。
 * 不合法就返回 null，由调用方换成随机 id（而不是把连接挂在别人的身份上）。
 */
export function validateClientId(input: unknown): string | null {
	if (typeof input !== "string") return null;
	if (input.length < 1 || input.length > MAX_CLIENT_ID_LEN) return null;
	if (!CLIENT_ID_RE.test(input)) return null;
	if (INTERNAL_CLIENT_PREFIXES.some((prefix) => input.startsWith(prefix))) return null;
	if (input.startsWith("device-task-") && !isBotExecutionRegistered(input)) return null;
	return input;
}
