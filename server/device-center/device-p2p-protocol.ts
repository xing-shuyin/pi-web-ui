export const DEVICE_P2P_TIMEOUT_MS = 25_000;
export const DEVICE_P2P_SIGNAL_TIMEOUT_MS = 10_000;
export const DEVICE_P2P_GATHER_TIMEOUT_MS = 8_000;
export const DEVICE_P2P_TUNNEL_TIMEOUT_MS = 8_000;
export const DEVICE_P2P_REMOTE_FAILURES = [
	"target-busy",
	"target-cancelled",
	"target-helper-missing",
	"target-unavailable",
	"target-ice-config",
	"target-gather-timeout",
	"target-gather-failed",
	"signal-timeout",
	"signal-failed",
] as const;
export type DeviceP2PRemoteFailure = (typeof DEVICE_P2P_REMOTE_FAILURES)[number];
export function deviceP2PRemoteFailure(value: unknown): DeviceP2PRemoteFailure | undefined {
	return typeof value === "string" && DEVICE_P2P_REMOTE_FAILURES.includes(value as DeviceP2PRemoteFailure)
		? (value as DeviceP2PRemoteFailure)
		: undefined;
}
export type DeviceP2PSignal = { version: 1; sdp: string };

export function validDeviceP2PSignal(value: unknown): value is DeviceP2PSignal {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as DeviceP2PSignal;
	return (
		Object.keys(data).length === 2 &&
		data.version === 1 &&
		typeof data.sdp === "string" &&
		Buffer.byteLength(data.sdp) <= 32768 &&
		/^v=0\r?\n/.test(data.sdp) &&
		!data.sdp.includes("\0") &&
		data.sdp.split("\n").length <= 256 &&
		(data.sdp.match(/^a=candidate:/gm)?.length ?? 0) <= 64 &&
		/^m=application /m.test(data.sdp)
	);
}
