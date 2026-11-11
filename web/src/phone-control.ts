/**
 * 手机操控的宿主桥：服务端发 `phone_request`，这里转发给手机壳（Capacitor 无障碍插件），
 * 再把结果作为 `phone_response` 发回去。浏览器 / 桌面没有这个桥，会得到明确的「不可用」。
 */
export interface PhoneHostResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface PhoneHostBridge {
	phoneCall?: (opts: { op: string; args?: Record<string, unknown>; timeoutMs?: number }) => Promise<PhoneHostResult>;
}

export function phoneHost(): PhoneHostBridge["phoneCall"] | undefined {
	const bridge = (globalThis as unknown as { __piPhoneHost?: PhoneHostBridge }).__piPhoneHost;
	return typeof bridge?.phoneCall === "function" ? bridge.phoneCall.bind(bridge) : undefined;
}
