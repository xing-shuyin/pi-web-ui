import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHongguo, PLAYBACK_FORMAT } from "../../plugins/hongguo/index.mjs";
import { byteRange, cdnUrl, rewriteManifest } from "../../plugins/hongguo/lib/media.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Record<string, unknown> = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-hongguo-"));
	const client = {
		async *discoverAll() {
			yield { id: "show1", title: "测试短剧", episode_count: 2 };
		},
		search: vi.fn(async () => ({ items: [{ id: "show1", title: "搜索结果" }], cursor: "next", has_more: true })),
		getSeries: vi.fn(async () => ({ id: "show1", title: "测试短剧", cover_url: "https://p1.fqnovelpic.com/cover" })),
		person: vi.fn(async () => ({ user_id: "actor1", name: "马小宇", description: "演员" })),
		personWorks: vi.fn(async () => ({
			items: [{ series_id: "show1", title: "测试短剧", episode_count: 2 }],
			cursor: "works-next",
			has_more: true,
		})),
		listEpisodes: vi.fn(async () => ({
			items: [
				{ id: "ep1", number: 1, playable: true },
				{ id: "ep2", number: 2 },
			],
		})),
		resolvePlayback: vi.fn(async () => ({
			playback: {
				protected: true,
				duration_seconds: 120,
				streams: [{ url: "https://v.qznovelvod.com/a.mp4?signature=private" }],
			},
			contentKey: { key: "private-content-key" },
		})),
		resetDevice: vi.fn(async () => {}),
	};
	const upstream = vi.fn(async () => new Response("encrypted", { headers: { "content-type": "video/mp4" } }));
	const run = vi.fn(async (_command: string, args: string[]) => {
		if (args[0] !== "-version") await writeFile(args.at(-1)!, "0123456789");
		return "";
	});
	const service = createHongguo(
		{ dataDir, log() {}, getSettings: () => ({}) },
		{ client, fetch: upstream, run, ...options },
	);
	const server: Server = createServer((req, res) => {
		(req as any).pluginPath = new URL(req.url!, "http://localhost").pathname;
		void service.handle(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	expect(port).toBeGreaterThanOrEqual(8900);
	cleanups.push(async () => {
		service.dispose();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});
	return {
		dataDir,
		client,
		upstream,
		service,
		run,
		get: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init),
	};
}

describe("Hongguo media boundary", () => {
	it("allows CDN subdomains and rejects credentials, ports, lookalikes and local redirects", () => {
		expect(cdnUrl("../clip.mp4", "https://v.qznovelvod.com/path/master.m3u8")).toBe(
			"https://v.qznovelvod.com/clip.mp4",
		);
		for (const url of [
			"http://127.0.0.1/private",
			"file:///etc/passwd",
			"https://qznovelvod.com.evil.test/",
			"https://user:secret@v.qznovelvod.com/",
			"https://v.qznovelvod.com:9000/",
		])
			expect(() => cdnUrl(url)).toThrow();
	});
	it("rewrites playlists, keys and DASH BaseURL with relative application paths", () => {
		const text = rewriteManifest(
			'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg.ts',
			"https://v.qznovelvod.com/path/a.m3u8",
		);
		expect(text).toContain('URI="./stream?u=https%3A%2F%2Fv.qznovelvod.com%2Fpath%2Fkey.bin"');
		expect(text).toContain("./stream?u=https%3A%2F%2Fv.qznovelvod.com%2Fpath%2Fseg.ts");
		expect(rewriteManifest("<MPD><BaseURL>file.mp4</BaseURL></MPD>", "https://v.qznovelvod.com/a.mpd")).toContain(
			"./stream?u=",
		);
		expect(() => rewriteManifest("#EXTM3U\nhttp://localhost/private", "https://v.qznovelvod.com/a")).toThrow();
	});
	it("handles normal, suffix and open ranges and rejects unsatisfiable/multipart requests", () => {
		expect(byteRange(undefined, 10)).toBeNull();
		expect(byteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
		expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
		expect(byteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
		for (const value of ["bytes=99-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4"])
			expect(() => byteRange(value, 10)).toThrow();
	});
});

describe("Hongguo HTTP routes", () => {
	it("returns discovery, paginated search and episode metadata", async () => {
		const f = await fixture();
		expect((await (await f.get("/list")).json()).items[0].title).toBe("测试短剧");
		const page = await (await f.get("/search?q=test&cursor=3")).json();
		expect(page).toMatchObject({ cursor: "next", hasMore: true });
		expect(f.client.search).toHaveBeenCalledWith("test", { cursor: "3", tab: "剧集" });
		expect(await (await f.get("/series?id=show1")).json()).toMatchObject({
			series: { id: "show1" },
			episodes: [{ id: "ep1" }, { id: "ep2" }],
		});
	});
	it("searches actors separately and opens their paginated dramas", async () => {
		const f = await fixture();
		f.client.search.mockResolvedValueOnce({
			items: [{ id: "actor1", title: "马小宇" }],
			cursor: "next",
			has_more: true,
		});
		const actors = await (await f.get("/search?q=马小宇&type=actor")).json();
		expect(f.client.search).toHaveBeenCalledWith("马小宇", { cursor: "", tab: "用户" });
		expect(actors.items[0]).toMatchObject({ id: "actor1", name: "马小宇", kind: "actor" });
		const works = await (await f.get("/actors/works?id=actor1")).json();
		expect(works).toMatchObject({
			person: { id: "actor1", name: "马小宇" },
			items: [{ id: "show1", episodes: 2 }],
			cursor: "works-next",
			hasMore: true,
		});
		await (await f.get("/actors/works?id=actor1&cursor=works-next")).arrayBuffer();
		expect(f.client.personWorks).toHaveBeenCalledWith("actor1", "works-next");
		expect(f.client.person).toHaveBeenCalledTimes(1);
		expect((await f.get("/actors/works?id=..%2Fsecret")).status).toBe(400);
	});
	it("prepares the next complete video and reuses it for playback without another SDK call", async () => {
		const f = await fixture();
		const ready = await (await f.get("/preload?episode=ep2", { method: "POST" })).json();
		expect(ready).toEqual({ episodeId: "ep2", ready: true });
		expect((await (await f.get("/play?episode=ep2")).json()).streams[0].url).toContain(PLAYBACK_FORMAT);
		expect(await (await f.get("/media/ep2")).text()).toBe("0123456789");
		expect(f.client.resolvePlayback).toHaveBeenCalledTimes(1);
		expect(f.upstream).toHaveBeenCalledTimes(1);
		expect(f.run.mock.calls.filter(([, args]) => args.includes("-c:v"))).toHaveLength(1);
	});
	it("attaches playback to an in-flight preload instead of resolving or encoding twice", async () => {
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const encode = vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("-c:v")) {
				await gate;
				await writeFile(args.at(-1)!, "0123456789");
			}
			return "";
		});
		const f = await fixture({ run: encode });
		const preload = f.get("/preload?episode=ep2", { method: "POST" });
		try {
			await vi.waitFor(() => expect(encode.mock.calls.some(([, args]) => args.includes("-c:v"))).toBe(true));
			const play = await (await f.get("/play?episode=ep2")).json();
			expect(play.streams[0].url).toContain(PLAYBACK_FORMAT);
			expect(f.client.resolvePlayback).toHaveBeenCalledTimes(1);
		} finally {
			finish();
		}
		expect((await preload).status).toBe(200);
		expect(await (await f.get("/media/ep2")).text()).toBe("0123456789");
		expect(encode.mock.calls.filter(([, args]) => args.includes("-c:v"))).toHaveLength(1);
	});
	it("keeps keys private, reuses the resolved model, caches media and serves seeking ranges", async () => {
		const f = await fixture();
		const payload = await (await f.get("/play?episode=ep1")).text();
		expect(payload).toContain(`"url":"./media/ep1?format=${PLAYBACK_FORMAT}"`);
		expect(payload).not.toMatch(/private-content-key|signature|qznovelvod/);
		const response = await f.get("/media/ep1", { headers: { Range: "bytes=2-5" } });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await response.text()).toBe("2345");
		expect(f.client.resolvePlayback).toHaveBeenCalledTimes(1);
		const suffix = await f.get("/media/ep1", { headers: { Range: "bytes=-3" } });
		expect(await suffix.text()).toBe("789");
		expect((await f.get("/media/ep1", { headers: { Range: "bytes=100-" } })).status).toBe(416);
		expect(f.upstream).toHaveBeenCalledTimes(1);
	});
	it("reencodes old decrypted HEVC caches without resolving or downloading the episode again", async () => {
		const f = await fixture();
		const directory = join(f.dataDir, "hongguo", "media");
		await mkdir(directory, { recursive: true });
		const legacy = join(directory, "ep1.mp4");
		await writeFile(legacy, "old HEVC cache");
		const payload = await (await f.get("/play?episode=ep1")).json();
		expect(payload.streams[0].url).toContain(`?format=${PLAYBACK_FORMAT}`);
		const response = await f.get(`/media/ep1?format=${PLAYBACK_FORMAT}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("0123456789");
		const encode = f.run.mock.calls.find(([, args]) => args.includes("-c:v"))![1];
		expect(encode[encode.indexOf("-i") + 1]).toBe(legacy);
		expect(encode[encode.indexOf("-c:v") + 1]).toBe("libx264");
		expect(encode[encode.indexOf("-c:a") + 1]).toBe("aac");
		expect(encode[encode.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
		expect(encode).not.toContain("-decryption_key");
		expect(encode).not.toContain("copy");
		expect(f.client.resolvePlayback).not.toHaveBeenCalled();
		expect(f.upstream).not.toHaveBeenCalled();
		await (await f.get("/play?episode=ep1")).arrayBuffer();
		await (await f.get("/media/ep1")).arrayBuffer();
		expect(f.run.mock.calls.filter(([, args]) => args.includes("-c:v"))).toHaveLength(1);
	});
	it("also converts unencrypted MP4 streams to H.264/AAC without passing a decryption key", async () => {
		const f = await fixture();
		f.client.resolvePlayback.mockResolvedValueOnce({
			playback: { protected: false, streams: [{ url: "https://v.qznovelvod.com/clear.mp4" }] },
		} as any);
		const payload = await (await f.get("/play?episode=ep2")).json();
		expect(payload.streams[0].url).toBe(`./media/ep2?format=${PLAYBACK_FORMAT}`);
		await (await f.get("/media/ep2")).arrayBuffer();
		const encode = f.run.mock.calls.find(([, args]) => args.includes("-c:v"))![1];
		expect(encode).not.toContain("-decryption_key");
		expect(encode[encode.indexOf("-c:v") + 1]).toBe("libx264");
		expect(encode[encode.indexOf("-profile:a") + 1]).toBe("aac_low");
	});
	it("revalidates redirects and refuses executable upstream content", async () => {
		const fetcher = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
		);
		const f = await fixture({ fetch: fetcher });
		expect((await f.get("/stream?u=https%3A%2F%2Fv.qznovelvod.com%2Fclip.mp4")).status).toBe(403);
		expect(fetcher).toHaveBeenCalledTimes(1);
		fetcher.mockImplementation(
			async () => new Response("<script>bad()</script>", { headers: { "content-type": "text/html" } }),
		);
		expect((await f.get("/stream?u=https%3A%2F%2Fv.qznovelvod.com%2Fclip.mp4")).status).toBe(403);
	});
	it("reports FFmpeg availability and rejects malformed episode IDs before calling the SDK", async () => {
		const f = await fixture();
		expect(await (await f.get("/config")).json()).toEqual({ ffmpegAvailable: true });
		expect((await f.get("/play?episode=..%2Fsecret")).status).toBe(400);
		expect(f.client.resolvePlayback).not.toHaveBeenCalled();
	});
});
