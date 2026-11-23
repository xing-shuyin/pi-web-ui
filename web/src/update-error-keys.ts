/**
 * 桌面更新错误码 → i18n key 的**唯一映射**。
 *
 * 壳与运行时是两条通道，错误语义不同（运行时多了 manifest / unsupported / corrupt /
 * busy / health），面板不应该各写一份。`update-verdict.ts` 只给错误码，取文案只来这里。
 */
export const SHELL_ERROR_KEYS = {
	network: "updateDesktopErrNetwork",
	feed: "updateDesktopErrFeed",
	permission: "updateDesktopErrPermission",
	disk: "updateDesktopErrDisk",
	signature: "updateDesktopErrSignature",
	unknown: "updateDesktopErrUnknown",
} as const;

export const RUNTIME_ERROR_KEYS = {
	network: "updateDesktopErrNetwork",
	feed: "updateDesktopErrFeed",
	permission: "updateDesktopErrPermission",
	disk: "updateDesktopErrDisk",
	signature: "updateDesktopErrSignature",
	manifest: "updateDesktopRuntimeErrManifest",
	unsupported: "updateDesktopRuntimeErrUnsupported",
	corrupt: "updateDesktopRuntimeErrCorrupt",
	busy: "updateDesktopRuntimeErrBusy",
	health: "updateDesktopRuntimeErrHealth",
	unknown: "updateDesktopErrUnknown",
} as const;

export type ShellErrorKey = (typeof SHELL_ERROR_KEYS)[keyof typeof SHELL_ERROR_KEYS];
export type RuntimeErrorKey = (typeof RUNTIME_ERROR_KEYS)[keyof typeof RUNTIME_ERROR_KEYS];

export function shellErrorKey(code: string | null | undefined): ShellErrorKey {
	return (SHELL_ERROR_KEYS as Record<string, ShellErrorKey>)[code ?? "unknown"] ?? "updateDesktopErrUnknown";
}

export function runtimeErrorKey(code: string | null | undefined): RuntimeErrorKey {
	return (RUNTIME_ERROR_KEYS as Record<string, RuntimeErrorKey>)[code ?? "unknown"] ?? "updateDesktopErrUnknown";
}
