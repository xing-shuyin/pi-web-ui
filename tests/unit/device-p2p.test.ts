import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceP2PRemoteFailure, validDeviceP2PSignal } from "../../server/device-center/device-p2p-protocol.js";
import {
	connectDeviceP2P,
	createDeviceP2PTarget,
	DEVICE_P2P_DEFAULT_STUN,
	deviceP2PAvailable,
	parseTurn,
	validIceServerUrl,
} from "../../server/device-center/device-p2p.js";
import { probeDeviceTunnel } from "../../server/device-center/device-lan.js";

afterEach(() => vi.unstubAllEnvs());
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
describe("P2P negotiation boundaries", () => {
	it("reports bounded target failure reasons without exposing arbitrary remote data", async () => {
		expect(deviceP2PRemoteFailure("target-unavailable")).toBe("target-unavailable");
		for (const invalid of [{ failure: "target-unavailable" }, "secret credentials", null, 42])
			expect(deviceP2PRemoteFailure(invalid)).toBeUndefined();
		const lan = { issueGrant: vi.fn(), revoke: vi.fn(), close: vi.fn() };
		const target = createDeviceP2PTarget(lan);
		vi.stubEnv("PI_DEVICE_P2P", "0");
		expect(await target.accept({ version: 1, sdp }, new AbortController().signal)).toEqual({
			failure: "target-helper-missing",
		});
		expect(await target.accept({ version: 1, sdp }, AbortSignal.abort())).toEqual({ failure: "target-cancelled" });
		expect(await target.accept({ version: 2, sdp }, new AbortController().signal)).toBeNull();
		expect(lan.issueGrant).not.toHaveBeenCalled();
		target.reset();
	});
	it("accepts TURN TCP/TLS transports and rejects invalid ICE destinations", () => {
		for (const url of [
			"turn:relay.example:3478?transport=tcp",
			"turns:relay.example:5349?transport=tcp",
			"turn:[::1]:3478",
			"turn:relay.example?transport=udp",
		])
			expect(
				parseTurn({ PI_DEVICE_TURN: url, PI_DEVICE_TURN_USERNAME: "u", PI_DEVICE_TURN_CREDENTIAL: "c" })?.urls,
			).toEqual([url]);
		for (const url of [
			"turn:host:0",
			"turn:host:65536",
			"turn:user@host:3478",
			"turn:host:3478/path",
			"turn:host:3478#fragment",
			"turn:host?transport=http",
			"turn:[not-ip]:3478",
		])
			expect(validIceServerUrl(url, "turn")).toBe(false);
		expect(validIceServerUrl("stun:[::1]:3478", "stun")).toBe(true);
		expect(validIceServerUrl("stun:host:3478?transport=tcp", "stun")).toBe(false);
	});
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
		const reasons: string[] = [];
		expect(await deviceP2PAvailable()).toBe(false);
		expect(await connectDeviceP2P(exchange, undefined, (reason) => reasons.push(reason))).toBeNull();
		expect(exchange).not.toHaveBeenCalled();
		expect(reasons).toEqual(["helper-missing"]);
		vi.stubEnv("PI_DEVICE_P2P", "1");
		vi.stubEnv("PI_DEVICE_P2P_HELPER", "relative-untrusted-helper");
		expect(await deviceP2PAvailable()).toBe(false);
		expect(await connectDeviceP2P(exchange, undefined, (reason) => reasons.push(reason))).toBeNull();
		expect(exchange).not.toHaveBeenCalled();
		expect(reasons).toEqual(["helper-missing", "helper-missing"]);
	});
	it("accepts TURN only when the server list and credentials are both sane", () => {
		expect(parseTurn({})).toBeUndefined();
		expect(parseTurn({ PI_DEVICE_TURN: "  " })).toBeUndefined();
		const turn = parseTurn({
			PI_DEVICE_TURN: "turn:82.156.246.55:3478",
			PI_DEVICE_TURN_USERNAME: "pi",
			PI_DEVICE_TURN_CREDENTIAL: "s3cret",
		});
		expect(turn).toEqual({ urls: ["turn:82.156.246.55:3478"], username: "pi", credential: "s3cret" });
		expect(
			parseTurn({
				PI_DEVICE_TURN: "turn:a:3478, turns:b:5349",
				PI_DEVICE_TURN_USERNAME: "u",
				PI_DEVICE_TURN_CREDENTIAL: "c",
			})?.urls,
		).toEqual(["turn:a:3478", "turns:b:5349"]);
	});

	it("rejects half-configured or malformed TURN instead of silently dropping the relay", () => {
		for (const env of [
			{ PI_DEVICE_TURN: "turn:a:3478" },
			{ PI_DEVICE_TURN: "turn:a:3478", PI_DEVICE_TURN_USERNAME: "u" },
			{ PI_DEVICE_TURN: "http://a:3478", PI_DEVICE_TURN_USERNAME: "u", PI_DEVICE_TURN_CREDENTIAL: "c" },
			{
				PI_DEVICE_TURN: "turn:a:3478,turn:b:3478,turn:c:3478,turn:d:3478",
				PI_DEVICE_TURN_USERNAME: "u",
				PI_DEVICE_TURN_CREDENTIAL: "c",
			},
			{ PI_DEVICE_TURN: "turn:a:3478", PI_DEVICE_TURN_USERNAME: "u\u0000", PI_DEVICE_TURN_CREDENTIAL: "c" },
		])
			expect(() => parseTurn(env)).toThrow();
	});

	it("defaults to several STUN servers so one blocked host cannot disable P2P", () => {
		const servers = DEVICE_P2P_DEFAULT_STUN.split(",");
		expect(servers.length).toBeGreaterThan(1);
		expect(servers.length).toBeLessThanOrEqual(4);
		for (const server of servers) expect(server).toMatch(/^stun:[a-zA-Z0-9.\-[\]:]+$/);
	});
	it("rejects invalid tunnel destinations and missing authentication before dialing", async () => {
		for (const port of [0, -1, 65536, 1.5, NaN]) expect(await probeDeviceTunnel({}, port)).toBeNull();
		expect(await probeDeviceTunnel({}, 8999)).toBeNull();
	});
});
