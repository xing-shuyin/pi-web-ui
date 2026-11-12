export const DEVICE_P2P_TIMEOUT_MS = 10_000;
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
