import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUnpackedPath } from "../../server/asar-paths.js";
import { resetFfmpegCache, resolveFfmpeg } from "../../server/device-center/ffmpeg-path.js";
import { createDeviceP2PTarget } from "../../server/device-center/device-p2p.js";

const mocks = vi.hoisted(() => ({
	exists: vi.fn((p: string) => p.includes("app.asar.unpacked")),
	unpackedCalls: [] as string[],
	spawnCmds: [] as string[],
	spawnImpl: undefined as ((options: { cmd: string }) => { child: unknown; stop: () => Promise<boolean> }) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return { ...real, existsSync: (p: string) => mocks.exists(p) };
});

vi.mock("../../server/asar-paths.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/asar-paths.js")>();
	return {
		...real,
		toUnpackedPath: (p: string) => {
			mocks.unpackedCalls.push(p);
			return real.toUnpackedPath(p);
		},
	};
});

vi.mock("../../server/spawn-child.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/spawn-child.js")>();
	return {
		...real,
		spawnChildPiped: (options: { cmd: string }) => {
			mocks.spawnCmds.push(options.cmd);
			if (!mocks.spawnImpl) throw new Error("spawnChildPiped called without a fixture");
			return mocks.spawnImpl(options);
		},
	};
});

const realPlatform = process.platform;
function stubPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	vi.unstubAllEnvs();
	mocks.exists.mockReset();
	mocks.exists.mockImplementation((p: string) => p.includes("app.asar.unpacked"));
	mocks.unpackedCalls.length = 0;
	mocks.spawnCmds.length = 0;
	mocks.spawnImpl = undefined;
	resetFfmpegCache();
});

describe("toUnpackedPath 路径矩阵", () => {
	it("win32 反斜杠：命中 app.asar 且解包副本存在时改写", () => {
		stubPlatform("win32");
		const p = "C:\\app\\resources\\app.asar\\bin\\device-p2p\\win32-x64.exe";
		expect(toUnpackedPath(p)).toBe("C:\\app\\resources\\app.asar.unpacked\\bin\\device-p2p\\win32-x64.exe");
	});
	it("win32 大小写不敏感", () => {
		stubPlatform("win32");
		const p = "C:\\APP\\RESOURCES\\APP.ASAR\\bin\\ffmpeg\\win32-x64\\ffmpeg.exe";
		expect(toUnpackedPath(p)).toBe("C:\\APP\\RESOURCES\\app.asar.unpacked\\bin\\ffmpeg\\win32-x64\\ffmpeg.exe");
	});
	it("win32 正斜杠同样是分隔符", () => {
		stubPlatform("win32");
		const p = "C:/app/resources/app.asar/bin/ffmpeg/win32-x64/ffmpeg.exe";
		expect(toUnpackedPath(p)).toBe("C:/app/resources/app.asar.unpacked/bin/ffmpeg/win32-x64/ffmpeg.exe");
	});
	it("posix：大小写敏感，全小写才命中", () => {
		stubPlatform("linux");
		const p = "/opt/app/resources/app.asar/bin/device-p2p/linux-x64";
		expect(toUnpackedPath(p)).toBe("/opt/app/resources/app.asar.unpacked/bin/device-p2p/linux-x64");
		expect(toUnpackedPath("/opt/APP.ASAR/x")).toBe("/opt/APP.ASAR/x");
	});
	it("解包副本不存在时原样返回（dev/未打包直通）", () => {
		stubPlatform("win32");
		mocks.exists.mockReturnValue(false);
		const p = "C:\\app\\resources\\app.asar\\bin\\ffmpeg\\win32-x64\\ffmpeg.exe";
		expect(toUnpackedPath(p)).toBe(p);
	});
	it("不含 app.asar 时原样返回且不碰文件系统", () => {
		stubPlatform("linux");
		mocks.exists.mockClear();
		expect(toUnpackedPath("/usr/bin/ffmpeg")).toBe("/usr/bin/ffmpeg");
		expect(mocks.exists).not.toHaveBeenCalled();
	});
	it("app.asar 只是别的段的子串时不改写", () => {
		stubPlatform("linux");
		mocks.exists.mockClear();
		expect(toUnpackedPath("/x/my-app.asar/y")).toBe("/x/my-app.asar/y");
		expect(toUnpackedPath("/x/my-app.asar/bak/y")).toBe("/x/my-app.asar/bak/y");
		expect(mocks.exists).not.toHaveBeenCalled();
	});
	it("空串直通", () => {
		expect(toUnpackedPath("")).toBe("");
	});
});

describe("ffmpeg resolve 落点", () => {
	beforeEach(() => {
		resetFfmpegCache();
		mocks.unpackedCalls.length = 0;
	});
	it("bundled 命中经过 toUnpackedPath（查找仍用原路径、只映射交出去的结果）", () => {
		stubPlatform("linux");
		mocks.exists.mockReturnValue(true);
		const found = resolveFfmpeg({});
		expect(found).toBeDefined();
		expect(found).toContain("ffmpeg");
		expect(mocks.unpackedCalls).toHaveLength(1);
		expect(found).toBe(toUnpackedPath(mocks.unpackedCalls[0]));
	});
	it("PI_DESKTOP_FFMPEG 覆盖路径不改写", () => {
		stubPlatform("linux");
		mocks.exists.mockReturnValue(true);
		expect(resolveFfmpeg({ PI_DESKTOP_FFMPEG: "/custom/ffmpeg" })).toBe("/custom/ffmpeg");
		expect(mocks.unpackedCalls).toHaveLength(0);
	});
	it("相对覆盖路径视为缺失（回退逻辑不变）", () => {
		expect(resolveFfmpeg({ PI_DESKTOP_FFMPEG: "relative/ffmpeg" })).toBeUndefined();
	});
});

describe("device-p2p spawn 落点", () => {
	const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
	function helperFixture() {
		const child = new EventEmitter() as unknown as Record<string, unknown>;
		const stdout = new EventEmitter() as unknown as Record<string, unknown>;
		stdout["setEncoding"] = () => {};
		const stderr = new EventEmitter() as unknown as Record<string, unknown>;
		stderr["setEncoding"] = () => {};
		const stdin = new EventEmitter() as unknown as Record<string, unknown>;
		stdin["write"] = () => true;
		stdin["end"] = () => {};
		stdin["writableLength"] = 0;
		child["stdout"] = stdout;
		child["stderr"] = stderr;
		child["stdin"] = stdin;
		queueMicrotask(() => (stdout as unknown as EventEmitter).emit("data", `${JSON.stringify({ type: "sdp", sdp })}\n`));
		return { child, stop: async () => true };
	}
	beforeEach(() => {
		stubPlatform("linux");
		mocks.spawnImpl = () => helperFixture() as { child: unknown; stop: () => Promise<boolean> };
	});
	it("交出去的 helper 路径经过 toUnpackedPath（asar 内改走 unpacked 副本）", async () => {
		vi.stubEnv("PI_DEVICE_P2P_HELPER", "/tmp/pi-asar-test/app.asar/helper");
		const lan = {
			issueGrant: vi.fn(async () => ({ identity: "g1", port: 4567, expiresAt: Date.now() + 30_000 })),
			revoke: vi.fn(),
		};
		const target = createDeviceP2PTarget(lan as never);
		try {
			const result = await target.accept({ version: 1, sdp }, new AbortController().signal);
			expect(result).toMatchObject({ signal: { version: 1, sdp } });
			expect(mocks.spawnCmds).toEqual(["/tmp/pi-asar-test/app.asar.unpacked/helper"]);
			expect(mocks.unpackedCalls).toContain("/tmp/pi-asar-test/app.asar/helper");
		} finally {
			target.reset();
		}
	});
	it("非 asar 路径原样透出（dev 回归）", async () => {
		vi.stubEnv("PI_DEVICE_P2P_HELPER", "/tmp/pi-plain/helper");
		const lan = {
			issueGrant: vi.fn(async () => ({ identity: "g2", port: 4568, expiresAt: Date.now() + 30_000 })),
			revoke: vi.fn(),
		};
		const target = createDeviceP2PTarget(lan as never);
		try {
			const result = await target.accept({ version: 1, sdp }, new AbortController().signal);
			expect(result).toMatchObject({ signal: { version: 1, sdp } });
			expect(mocks.spawnCmds).toEqual(["/tmp/pi-plain/helper"]);
		} finally {
			target.reset();
		}
	});
});
