import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeCliDiscoveryHandler } from "../../server/native-cli-routes.js";
import { discoverRemoteNativeClis } from "../../server/remote-native-cli.js";
import { resolveEngineCliLaunch } from "../../server/engine-cli.js";
import { probeRemoteCliPersistence } from "../../server/remote-cli-persistence.js";
import { getGlobalRemoteSshService, setGlobalRemoteSshService } from "../../server/remote-ssh-service.js";

vi.mock("../../server/remote-native-cli.js", () => ({ discoverRemoteNativeClis: vi.fn() }));
vi.mock("../../server/engine-cli.js", () => ({ resolveEngineCliLaunch: vi.fn() }));
vi.mock("../../server/remote-cli-persistence.js", () => ({ probeRemoteCliPersistence: vi.fn() }));
const cwd = "ssh://tester@example.test:22/workspace";
let original: ReturnType<typeof getGlobalRemoteSshService>;
let service: any;
function response(): any {
	const res: any = new EventEmitter();
	res.writableEnded = false;
	res.status = vi.fn(() => res);
	res.json = vi.fn(() => {
		res.writableEnded = true;
		return res;
	});
	return res;
}
beforeEach(() => {
	vi.resetAllMocks();
	original = getGlobalRemoteSshService();
	service = {} as any;
	setGlobalRemoteSshService(service);
	vi.mocked(discoverRemoteNativeClis).mockResolvedValue([
		{ preset: "claude", available: true, executable: "/remote/claude" },
	]);
	vi.mocked(resolveEngineCliLaunch).mockImplementation((id) => ({ file: `/local/${id}`, args: [] }));
	vi.mocked(probeRemoteCliPersistence).mockResolvedValue({ available: true });
});
afterEach(() => {
	setGlobalRemoteSshService(original as any);
});

describe("native CLI discovery endpoint", () => {
	it("requires the terminal feature before connecting to SSH", async () => {
		const res = response();
		await nativeCliDiscoveryHandler(() => false)({ query: { cwd } } as any, res);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(discoverRemoteNativeClis).not.toHaveBeenCalled();
	});
	it.each([undefined, [cwd], "", "bad\u0000path", "ssh:///bad", "ssh://user@host:65536/path"])(
		"rejects invalid target %#",
		async (value) => {
			const res = response();
			await nativeCliDiscoveryHandler(() => true)({ query: { cwd: value } } as any, res);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(discoverRemoteNativeClis).not.toHaveBeenCalled();
		},
	);
	it("returns only remote discovery for an SSH workspace and preserves the requested URI", async () => {
		const res = response();
		await nativeCliDiscoveryHandler(() => true)({ query: { cwd } } as any, res);
		expect(discoverRemoteNativeClis).toHaveBeenCalledWith(service, cwd, expect.any(AbortSignal));
		expect(resolveEngineCliLaunch).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith({
			target: "ssh",
			cwd,
			clis: [{ preset: "claude", available: true, executable: "/remote/claude" }],
			persistence: { available: true },
		});
	});
	it("reports a host trust or connection error without claiming an installed CLI", async () => {
		vi.mocked(discoverRemoteNativeClis).mockRejectedValue(new Error("SSH host key is not trusted"));
		const res = response();
		await nativeCliDiscoveryHandler(() => true)({ query: { cwd } } as any, res);
		expect(res.status).toHaveBeenCalledWith(502);
		expect(res.json).toHaveBeenCalledWith({ error: "SSH host key is not trusted" });
	});
	it("cancels discovery on browser response close and suppresses late results", async () => {
		let finish!: (value: any) => void;
		vi.mocked(discoverRemoteNativeClis).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const res = response();
		const pending = nativeCliDiscoveryHandler(() => true)({ query: { cwd } } as any, res);
		const signal = vi.mocked(discoverRemoteNativeClis).mock.calls[0][2]!;
		res.emit("close");
		expect(signal.aborted).toBe(true);
		finish([]);
		await pending;
		expect(res.json).not.toHaveBeenCalled();
		expect(res.listenerCount("close")).toBe(0);
	});
	it("keeps local detection separate and excludes programs without interactive CLIs", async () => {
		const res = response();
		await nativeCliDiscoveryHandler(() => true)({ query: { cwd: "E:/project" } } as any, res);
		const result = res.json.mock.calls[0][0];
		expect(result.target).toBe("local");
		expect(result.clis.map((item: any) => item.preset)).toEqual(["pi", "claude", "codex", "agy"]);
		expect(discoverRemoteNativeClis).not.toHaveBeenCalled();
	});
});
