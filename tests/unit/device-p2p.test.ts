import { afterEach, describe, expect, it, vi } from "vitest";
import { validDeviceP2PSignal } from "../../server/device-center/device-p2p-protocol.js";
import { connectDeviceP2P, deviceP2PAvailable } from "../../server/device-center/device-p2p.js";
import { probeDeviceTunnel } from "../../server/device-center/device-lan.js";

afterEach(() => vi.unstubAllEnvs());
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
describe("P2P negotiation boundaries", () => {
	it("accepts a bounded versioned application SDP and rejects malformed or oversized signals", () => {
		expect(validDeviceP2PSignal({ version: 1, sdp })).toBe(true);
		for (const value of [
			null,
			[],
			{},
			{ version: 2, sdp },
			{ version: 1, sdp, target: "other" },
			{ version: 1, sdp: "x" + sdp },
			{ version: 1, sdp: sdp + "\0" },
			{ version: 1, sdp: sdp + "a=candidate:1\r\n".repeat(65) },
			{ version: 1, sdp: sdp + "x\n".repeat(256) },
			{ version: 1, sdp: sdp + "界".repeat(11000) },
		])
			expect(validDeviceP2PSignal(value)).toBe(false);
	});
	it("does not start negotiation when the helper is disabled or absent", async () => {
		vi.stubEnv("PI_DEVICE_P2P", "0");
		const exchange = vi.fn();
		expect(await deviceP2PAvailable()).toBe(false);
		expect(await connectDeviceP2P(exchange)).toBeNull();
		expect(exchange).not.toHaveBeenCalled();
		vi.stubEnv("PI_DEVICE_P2P", "1");
		vi.stubEnv("PI_DEVICE_P2P_HELPER", "relative-untrusted-helper");
		expect(await deviceP2PAvailable()).toBe(false);
		expect(await connectDeviceP2P(exchange)).toBeNull();
		expect(exchange).not.toHaveBeenCalled();
	});
	it("rejects invalid tunnel destinations and missing authentication before dialing", async () => {
		for (const port of [0, -1, 65536, 1.5, NaN]) expect(await probeDeviceTunnel({}, port)).toBeNull();
		expect(await probeDeviceTunnel({}, 8999)).toBeNull();
	});
});
