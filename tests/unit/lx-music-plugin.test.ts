/**
 * 洛雪音乐 (lx-music) 插件单测 —— 覆盖多平台排行榜、歌单能力、服务端路由与播控工具
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import lxMusicPlugin from "../../plugins/lx-music/index.mjs";
import * as musicSdk from "../../plugins/lx-music/server/music-sdk.mjs";
import { createMusicTool } from "../../plugins/lx-music/server/tools.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "lx-music");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeHost() {
	const dataDir = mkdtempSync(join(tmpdir(), "pi-lx-music-test-"));
	cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const host = createMockHost({ dataDir, dir: pluginDir });
	return { host, dataDir };
}

describe("lx-music plugin", () => {
	it("manifest conforms to specifications", () => {
		expect(manifest.id).toBe("lx-music");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.version).toBe("0.1.11");
		expect(manifest.permissions).toContain("http");
		expect(manifest.permissions).toContain("tools");
		expect(manifest.view).toBe(true);
	});

	describe("music-sdk multi-source leaderboard & playlist methods", () => {
		it("provides top lists for all supported platforms", async () => {
			for (const src of ["wy", "tx", "kw", "kg"]) {
				const lists = await musicSdk.getTopLists(src);
				expect(Array.isArray(lists)).toBe(true);
				expect(lists.length).toBeGreaterThan(0);
				expect(lists[0]).toHaveProperty("id");
				expect(lists[0]).toHaveProperty("name");
				expect(lists[0].source).toBe(src);
			}
		});

		it("provides playlist tags for all supported platforms", async () => {
			for (const src of ["wy", "tx", "kw", "kg"]) {
				const tags = await musicSdk.getPlaylistTags(src);
				expect(Array.isArray(tags)).toBe(true);
				expect(tags.length).toBeGreaterThan(0);
				expect(tags).toContain("全部");
			}
		});

		it("backward compatible getTopList calls default source", async () => {
			const songs = await musicSdk.getTopList("hot", 5);
			expect(Array.isArray(songs)).toBe(true);
		});
	});

	describe("server routes in index.mjs", () => {
		it("registers top-lists, top-list, and playlist routes on host", async () => {
			const { host } = makeHost();
			lxMusicPlugin.activate(host);

			const routeList = host.mock.routes || [];
			const paths = routeList.map((r: any) => `${r.method} ${r.path}`);

			expect(paths).toContain("GET /top-lists");
			expect(paths).toContain("GET /top-list");
			expect(paths).toContain("GET /playlist/tags");
			expect(paths).toContain("GET /playlist/list");
			expect(paths).toContain("GET /playlist/detail");
		});

		it("responds to /top-lists for specified source", async () => {
			const { host } = makeHost();
			lxMusicPlugin.activate(host);

			const topListsRoute = host.mock.routes.find((r: any) => r.method === "GET" && r.path === "/top-lists");
			expect(topListsRoute).toBeDefined();

			let responseJson = "";
			const req = { url: "/top-lists?source=kw" };
			const res = {
				writeHead: vi.fn().mockReturnThis(),
				end: vi.fn((data: string) => {
					responseJson = data;
				}),
			};

			await topListsRoute.handler(req, res);
			expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
			const parsed = JSON.parse(responseJson);
			expect(parsed.ok).toBe(true);
			expect(Array.isArray(parsed.lists)).toBe(true);
			expect(parsed.lists.length).toBeGreaterThan(0);
			expect(parsed.lists[0].source).toBe("kw");
		});

		it("responds to /playlist/tags and /playlist/list", async () => {
			const { host } = makeHost();
			lxMusicPlugin.activate(host);

			const tagsRoute = host.mock.routes.find((r: any) => r.method === "GET" && r.path === "/playlist/tags");
			expect(tagsRoute).toBeDefined();

			let tagsJson = "";
			const reqTags = { url: "/playlist/tags?source=tx" };
			const resTags = {
				writeHead: vi.fn().mockReturnThis(),
				end: vi.fn((data: string) => {
					tagsJson = data;
				}),
			};
			await tagsRoute.handler(reqTags, resTags);
			const parsedTags = JSON.parse(tagsJson);
			expect(parsedTags.ok).toBe(true);
			expect(Array.isArray(parsedTags.tags)).toBe(true);
			expect(parsedTags.tags).toContain("全部");

			const listRoute = host.mock.routes.find((r: any) => r.method === "GET" && r.path === "/playlist/list");
			expect(listRoute).toBeDefined();

			let listJson = "";
			const reqList = { url: "/playlist/list?source=tx&tag=全部&page=1&limit=5" };
			const resList = {
				writeHead: vi.fn().mockReturnThis(),
				end: vi.fn((data: string) => {
					listJson = data;
				}),
			};
			await listRoute.handler(reqList, resList);
			const parsedList = JSON.parse(listJson);
			expect(parsedList.ok).toBe(true);
			expect(Array.isArray(parsedList.list)).toBe(true);
		});
	});

	describe("music_control AI agent tool", () => {
		it("provides music_control tool with playlist support", () => {
			const { host } = makeHost();
			const tool = createMusicTool(host, null as any);

			expect(tool.name).toBe("music_control");
			expect(tool.parameters.properties.action.enum).toContain("play_all");
			expect(tool.parameters.properties).toHaveProperty("playlistId");
			expect(tool.parameters.properties).toHaveProperty("chart");
			expect(tool.parameters.properties).toHaveProperty("source");
		});

		it("executes play_all using broadcast", async () => {
			const { host } = makeHost();
			const tool = createMusicTool(host, null as any);

			const broadcastSpy = vi.spyOn(host, "broadcast");
			const result = await (tool as any).execute({
				action: "play_all",
				source: "kw",
				chart: "16",
			});

			expect(result.status).toBe("ok");
			expect(broadcastSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "lx:play_all",
				}),
			);
		});
	});
});
