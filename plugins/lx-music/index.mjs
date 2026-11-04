/**
 * 洛雪音乐 (lx-music) 插件服务端入口
 */
import { join } from "node:path";
import { createStore } from "./store.mjs";
import {
	getLyricInfo,
	getMusicPlayUrl,
	getTopList,
	getTopLists,
	getTopListSongs,
	getPlaylists,
	getPlaylistTags,
	getPlaylistDetail,
	searchMusics,
	findCrossSourceMusicUrl,
} from "./server/music-sdk.mjs";
import { proxyAudioStream } from "./server/stream-proxy.mjs";
import { UserApiEngine } from "./server/user-api-vm.mjs";
import { createMusicTool } from "./server/tools.mjs";

/** 安全读取 Express 已解析或未解析的 Body */
async function getRequestBody(req) {
	if (req.body && typeof req.body === "object") return req.body;
	if (typeof req.body === "string" && req.body.trim()) {
		try {
			return JSON.parse(req.body);
		} catch {
			return {};
		}
	}
	if (req.readableEnded || req.complete) return {};
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch {
				resolve({});
			}
		});
		req.on("error", () => resolve({}));
	});
}

/** 辅助拉取远程脚本（支持 GitHub 加速镜像重试） */
async function fetchRemoteScript(url) {
	const urlsToTry = [url];
	if (url.includes("raw.githubusercontent.com")) {
		urlsToTry.unshift(
			url.replace("https://raw.githubusercontent.com", "https://ghproxy.net/raw.githubusercontent.com"),
		);
		urlsToTry.unshift(`https://ghfast.top/${url}`);
	}

	for (const targetUrl of urlsToTry) {
		try {
			const res = await fetch(targetUrl, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				},
				signal: AbortSignal.timeout(10000),
			});
			if (res.ok) {
				const text = await res.text();
				if (text && text.trim().length > 50) return text;
			}
		} catch {}
	}
	throw new Error(`无法从远程 URL 下载脚本，请检查网络或直接复制源码粘贴导入: ${url}`);
}

export default {
	activate(host) {
		const store = createStore(join(host.dataDir, "lx-music"));
		const userApi = new UserApiEngine({ log: (msg) => host.log(msg) });

		// 恢复已保存的自定义音源
		const savedApis = store.get("user-apis", []);
		for (const item of savedApis) {
			if (item?.id && item?.script) {
				userApi.importScript(item.id, item.script);
			}
		}
		const activeApiId = store.get("active-api-id", null);
		if (activeApiId) userApi.setActive(activeApiId);

		// 1. 搜索歌曲
		host.route("GET", "/search", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const keyword = query.get("keyword") || "";
				const source = query.get("source") || "wy";
				const page = parseInt(query.get("page") || "1", 10);
				const limit = parseInt(query.get("limit") || "20", 10);

				if (!keyword.trim()) {
					return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ songs: [] }));
				}

				const songs = await searchMusics(source, keyword.trim(), page, limit);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, songs }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 2. 获取排行榜列表
		host.route("GET", "/top-lists", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const lists = await getTopLists(source);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, lists }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 2.1 获取排行榜歌曲
		host.route("GET", "/top-list", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const bangId = query.get("bangId") || query.get("type") || "hot";
				const limit = parseInt(query.get("limit") || "50", 10);
				const page = parseInt(query.get("page") || "1", 10);
				const songs = await getTopListSongs(source, bangId, page, limit);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, songs }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 2.2 歌单标签与分类
		host.route("GET", "/playlist/tags", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const tags = await getPlaylistTags(source);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, tags }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 2.3 歌单列表
		host.route("GET", "/playlist/list", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const tag = query.get("tag") || "全部";
				const page = parseInt(query.get("page") || "1", 10);
				const limit = parseInt(query.get("limit") || "30", 10);
				const result = await getPlaylists(source, tag, page, limit);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...result }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 2.4 歌单详情
		host.route("GET", "/playlist/detail", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const id = query.get("id") || "";
				if (!id) {
					return res
						.writeHead(400, { "Content-Type": "application/json" })
						.end(JSON.stringify({ ok: false, error: "Missing playlist id" }));
				}
				const playlist = await getPlaylistDetail(source, id);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, playlist }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 3. 获取歌曲真实播放链接 (参考 enhanced 架构：支持音质梯级降级与跨源换源容灾)
		host.route("GET", "/song-url", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const songId = query.get("songId") || "";
				const name = query.get("name") || "";
				const singer = query.get("singer") || "";
				const album = query.get("album") || "";
				const quality = query.get("quality") || "128k";

				if (!songId) {
					return res
						.writeHead(400, { "Content-Type": "application/json" })
						.end(JSON.stringify({ error: "Missing songId" }));
				}

				let url = null;
				let resolvedQuality = quality;

				// 1. 优先尝试自定义音源沙箱（内置音质平滑降级与有效性预检）
				if (userApi.activeId) {
					const resolveRes = await userApi.resolveUrl(source, { id: songId, name, singer, album }, quality);
					if (resolveRes?.url) {
						url = resolveRes.url;
						resolvedQuality = resolveRes.quality || quality;
					}
				}

				// 2. 自定义源未命中或返回死链时，回退到当前平台的官方/内置备选源
				if (!url) {
					url = await getMusicPlayUrl(source, songId);
				}

				// 3. 当前平台仍无可用链接时，跨平台智能换源容灾匹配 (酷我/酷狗/网易)
				if (!url && name) {
					const fallbackRes = await findCrossSourceMusicUrl(name, singer, source);
					if (fallbackRes?.url) {
						url = fallbackRes.url;
					}
				}

				if (!url) {
					return res
						.writeHead(404, { "Content-Type": "application/json" })
						.end(JSON.stringify({ ok: false, error: "无法解析该歌曲的有效播放音频链接" }));
				}

				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: true, url, quality: resolvedQuality }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 4. 歌曲歌词
		host.route("GET", "/lyric", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const source = query.get("source") || "wy";
				const songId = query.get("songId") || "";
				if (!songId) {
					return res
						.writeHead(400, { "Content-Type": "application/json" })
						.end(JSON.stringify({ error: "Missing songId" }));
				}
				const lrc = await getLyricInfo(source, songId);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...lrc }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 5. 音频流 Range 代理 (防盗链 + 前端 Seek)
		host.route("GET", "/stream", async (req, res) => {
			const query = new URL(req.url, "http://127.0.0.1").searchParams;
			const targetUrl = query.get("url");
			const referer = query.get("referer") || "";
			if (!targetUrl) {
				res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing url parameter");
				return;
			}
			proxyAudioStream(req, res, targetUrl, referer);
		});

		// 6. 音频文件一键下载
		host.route("GET", "/download", async (req, res) => {
			const query = new URL(req.url, "http://127.0.0.1").searchParams;
			const targetUrl = query.get("url");
			const name = query.get("name") || "music";
			const singer = query.get("singer") || "";
			const filename = `${name}${singer ? ` - ${singer}` : ""}.mp3`;
			if (!targetUrl) {
				res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing url parameter");
				return;
			}
			proxyAudioStream(req, res, targetUrl, "", filename);
		});

		// 7. 收藏夹我喜欢的音乐
		host.route("GET", "/favorites", (req, res) => {
			const favorites = store.get("favorites", []);
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ favorites }));
		});

		host.route("POST", "/favorites", async (req, res) => {
			try {
				const body = await getRequestBody(req);
				const favorites = body.favorites || [];
				store.set("favorites", favorites);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
			} catch (err) {
				res
					.writeHead(400, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 8. 歌单与队列
		host.route("GET", "/playlists", (req, res) => {
			const data = store.get("playlists", {
				currentQueue: [],
			});
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
		});

		host.route("POST", "/playlists", async (req, res) => {
			try {
				const data = await getRequestBody(req);
				store.set("playlists", data);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
			} catch (err) {
				res
					.writeHead(400, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 9. 自定义音源管理
		host.route("GET", "/user-apis", (req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ apis: userApi.listApis() }));
		});

		// 9.1 社区推荐可用音源列表 (源自 pdone/lx-music-source 仓库)
		host.route("GET", "/user-api/recommended", (req, res) => {
			const recommended = [
				{
					id: "fish",
					name: "大鱼吃小鱼 (Fish Music)",
					version: "1.9.0",
					author: "大鱼吃小鱼",
					description: "社区活跃稳定音源，支持 QQ、网易、酷狗、酷我全平台，支持 FLAC 无损 / 320K 极高音质",
					descriptionEn: "Stable community source supporting multiple platforms with lossless audio",
					url: "https://raw.githubusercontent.com/pdone/lx-music-source/main/fish/latest.js",
					recommended: true,
					status: "healthy",
				},
				{
					id: "helloworld",
					name: "HelloWorld 音源",
					version: "1.0.0",
					author: "HelloWorld",
					description: "备选多源脚本，支持 QQ 等平台标准及高品音频解析",
					descriptionEn: "Alternative multi-source script for standard and high quality audio",
					url: "https://raw.githubusercontent.com/pdone/lx-music-source/main/helloworld/latest.js",
					recommended: false,
					status: "healthy",
				},
				{
					id: "jiexiang",
					name: "JieXiang (结香音源)",
					version: "1.0.0",
					author: "JieXiang",
					description: "支持 QQ / 酷我等多源音频检索",
					descriptionEn: "Supports audio search across multiple sources",
					url: "https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js",
					recommended: false,
					status: "healthy",
				},
				{
					id: "changqing",
					name: "长青SVIP音源 (已失效)",
					version: "1.3.0",
					author: "SVIP",
					description: "上游解析服务器 (yinyue.haitangw.net) 已全面关停，接口全报 404，不建议使用",
					descriptionEn: "Upstream server discontinued, not recommended",
					url: "https://raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js",
					recommended: false,
					status: "dead",
				},
			];
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, list: recommended }));
		});

		// 9.2 探测指定音源或当前活跃音源可用性
		host.route("GET", "/user-api/probe", async (req, res) => {
			try {
				const query = new URL(req.url, "http://127.0.0.1").searchParams;
				const id = query.get("id") || userApi.activeId;
				if (!id) {
					return res
						.writeHead(200, { "Content-Type": "application/json" })
						.end(JSON.stringify({ ok: false, error: "未选择或未激活任何音源" }));
				}
				const probeResult = await userApi.probeApi(id);
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: true, probe: probeResult }));
			} catch (err) {
				res
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 9.3 删除自定义音源
		host.route("POST", "/user-api/delete", async (req, res) => {
			try {
				const { id } = await getRequestBody(req);
				if (!id) throw new Error("缺少音源 id");
				userApi.removeScript(id);
				const all = store.get("user-apis", []).filter((x) => x.id !== id);
				store.set("user-apis", all);
				store.set("active-api-id", userApi.activeId);
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: true, activeId: userApi.activeId }));
			} catch (err) {
				res
					.writeHead(400, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		host.route("POST", "/user-api/import", async (req, res) => {
			try {
				const body = await getRequestBody(req);
				let scriptContent = (body.script || "").trim();
				if (!scriptContent) throw new Error("输入内容不能为空");

				if (/^https?:\/\//i.test(scriptContent)) {
					scriptContent = await fetchRemoteScript(scriptContent);
				}

				const finalId = body.id || `api_${Date.now()}`;
				const result = userApi.importScript(finalId, scriptContent);
				if (!result.ok) throw new Error(result.error);

				const all = store.get("user-apis", []);
				const idx = all.findIndex((x) => x.id === finalId);
				if (idx >= 0) all[idx] = { id: finalId, script: scriptContent, meta: result.meta };
				else all.push({ id: finalId, script: scriptContent, meta: result.meta });
				store.set("user-apis", all);
				store.set("active-api-id", userApi.activeId);

				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, meta: result.meta }));
			} catch (err) {
				res
					.writeHead(400, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		host.route("POST", "/user-api/active", async (req, res) => {
			try {
				const { id } = await getRequestBody(req);
				userApi.setActive(id);
				store.set("active-api-id", id);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, activeId: id }));
			} catch (err) {
				res
					.writeHead(400, { "Content-Type": "application/json" })
					.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		// 10. 注册 AI 点歌工具
		const musicTool = createMusicTool(host, userApi);
		const unregisterTool = host.registerAgentTool(musicTool);

		return () => {
			if (typeof unregisterTool === "function") unregisterTool();
		};
	},
};
