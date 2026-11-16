/**
 * 网页侧的 passkey 本地确认闸门（document-start 注入，`browser/renderer/passkey-gate.js` 是它的源码）。
 *
 * 为什么需要它：Chromium 的虚拟认证器把 `user verification` 直接置为“已满足”，网站要 UV 时我们
 * **不弹任何东西就通过了**——这既和 Edge/Chrome 的体感差一截，也少了“你要用这把 passkey”的时刻。
 * 这层闸门把 `navigator.credentials.create/get` 包一层：先请主进程弹本地确认窗口（本机没有可用
 * 的生物识别实现，所以是“本地确认、自动通过”），批准后才真正发起 ceremony；拒绝则按 WebAuthn 的
 * 语义抛 `NotAllowedError`，网站走它自己的失败分支。
 *
 * 边界：这是**页内包装**，不是协议层的认证器实现；包装失败/桥不可用时直接放行（fail-open），
 * 绝不因为闸门本身把 passkey 弄坏。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function getPasskeyGateScript(): string {
	const candidates = [
		path.join(here, "..", "renderer", "passkey-gate.js"),
		path.join(here, "..", "..", "browser", "renderer", "passkey-gate.js"),
		path.join(here, "passkey-gate.js"),
	];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
		} catch {}
	}
	return "";
}

export const PASSKEY_GATE_SCRIPT = getPasskeyGateScript();
