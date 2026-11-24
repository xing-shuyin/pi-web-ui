import { normalizePageCallTimeoutMs } from "../../browser-page-tool.js";

export { normalizePageCallTimeoutMs };

/**
 * 手机侧的钳制（默认 20s / 下限 1s / 上限 60s）。
 *
 * 数字与宿主 `server/phone-tool.ts` 的 `normalizePhoneCallTimeoutMs` 同源，但那里是**工具入参**的归一化
 * （UI 侧默认值的所有者）。这里是**桥的第二道钳制**：第三方直接调 handler（不经工具）时，也不能靠一个
 * 超长 `timeoutMs` 把一轮挂死。搬进内核的下一步就是把工具侧那份也改成 import 这里。
 */
const PHONE_DEFAULT_TIMEOUT_MS = 20_000;
const PHONE_MIN_TIMEOUT_MS = 1_000;
const PHONE_MAX_TIMEOUT_MS = 60_000;

export function normalizePhoneBridgeTimeoutMs(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PHONE_DEFAULT_TIMEOUT_MS;
	return Math.min(PHONE_MAX_TIMEOUT_MS, Math.max(PHONE_MIN_TIMEOUT_MS, n));
}
