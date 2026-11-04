import { describe, expect, it, vi } from "vitest";
import { UserApiEngine } from "../../plugins/lx-music/server/user-api-vm.mjs";
import { findCrossSourceMusicUrl } from "../../plugins/lx-music/server/music-sdk.mjs";

describe("LX Music UserApi VM & Quality Enhancement", () => {
	it("parses script metadata correctly and tolerates UTF-8 BOM", () => {
		const engine = new UserApiEngine({ log: () => {} });
		const bomScript = `\uFEFF/**
 * @name 测试高音质源
 * @version 2.1.0
 * @author 测试团队
 * @description 专为无损音质测试
 */
const { EVENT_NAMES, on, send } = globalThis.lx;
on(EVENT_NAMES.request, async ({ action, source, info }) => {
  return "https://music.example.com/audio.flac";
});
send(EVENT_NAMES.inited, { name: "测试高音质源" });
`;
		const res = engine.importScript("test_bom", bomScript);
		expect(res.ok).toBe(true);
		expect(res.meta!.name).toBe("测试高音质源");
		expect(res.meta!.version).toBe("2.1.0");
		expect(res.meta!.author).toBe("测试团队");
	});

	it("smoothly falls back through quality ladder when requested tier is unavailable", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response("audio data", { status: 200, headers: { "content-type": "audio/mpeg" } });
		});
		try {
			const engine = new UserApiEngine({ log: () => {} });
			// 模拟一个仅支持 128k 和 320k 的音源
			const script = `
const { EVENT_NAMES, on } = globalThis.lx;
on(EVENT_NAMES.request, async ({ action, source, info }) => {
  if (info.type === 'flac' || info.type === 'hires') {
    return null; // 无损不可用
  }
  if (info.type === '320k') {
    return "https://mock.cdn.com/song_320k.mp3";
  }
  return "https://mock.cdn.com/song_128k.mp3";
});
`;
			engine.importScript("mock_source", script);
			engine.setActive("mock_source");

			// 请求 flac，应该自动降级获取 320k
			const result = await engine.resolveUrl("wy", { id: "1001", name: "海阔天空", singer: "Beyond" }, "flac");
			expect(result).not.toBeNull();
			expect(result!.quality).toBe("320k");
			expect(result!.url).toBe("https://mock.cdn.com/song_320k.mp3");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects dead URLs (like changqing 404) and reports probe diagnostics", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response("Not Found", { status: 404, statusText: "Not Found" });
		});
		try {
			const engine = new UserApiEngine({ log: () => {} });
			// 模拟长青音源返回 404 地址
			const script = `
const { EVENT_NAMES, on } = globalThis.lx;
on(EVENT_NAMES.request, async () => {
  return "http://yinyue.haitangw.net/wy/wy.php?type=mp3&id=186016&level=standard";
});
`;
			engine.importScript("mock_dead", script);
			engine.setActive("mock_dead");

			const probe = await engine.probeApi("mock_dead");
			expect(probe.ok).toBe(false);
			expect(probe.error).toContain("失效");

			const resolved = await engine.resolveUrl("wy", { id: "186016", name: "晴天", singer: "周杰伦" }, "128k");
			expect(resolved).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("cleans up active timers when removing or re-importing scripts", () => {
		const engine = new UserApiEngine({ log: () => {} });
		const intervalScript = `
const timer = setInterval(() => {}, 10000);
`;
		engine.importScript("timer_source", intervalScript);
		const target = engine.apis.get("timer_source");
		expect(target.timers.size).toBeGreaterThan(0);

		engine.removeScript("timer_source");
		expect(target.timers.size).toBe(0);
		expect(engine.apis.has("timer_source")).toBe(false);
	});

	it("provides cross-source fallback search mechanism", async () => {
		expect(typeof findCrossSourceMusicUrl).toBe("function");
	});
});
