/**
 * wallpaper-engine 服务端入口 (v0.3.1) —— Steam 探测、壁纸扫描、流式媒体、收藏与外观预设服务。
 *
 * 核心职责：
 * 1. 自动探测 Steam 与 Wallpaper Engine (AppID 431960) 创意工坊安装目录；
 * 2. 解析 libraryfolders.vdf，枚举所有磁盘分区中的 Steam 库；
 * 3. 扫描各壁纸目录下的 project.json，提取元数据并构建壁纸索引库（支持 Video、Scene、Web、Image）；
 * 4. 提供 HTTP 路由 (/plugins-api/wallpaper-engine/api/*)：
 *    - /api/wallpapers: 壁纸列表、分类元数据与收藏集
 *    - /api/rescan: 清除内存缓存并强制重新全量扫描
 *    - /api/preview: 缩略图服务（静态图片缓存）
 *    - /api/media: 视频/图片壁纸流服务（原生支持 HTTP 206 Range 请求，流畅拖动与分片）
 *    - /api/pkg: Scene 壁纸专属 scene.pkg 二进制流服务
 *    - /api/project: 读取特定壁纸的原始 project.json 配置
 *    - /api/web: 网页壁纸（Web Wallpaper）静态资源沙箱服务（防目录遍历）
 *    - /api/favorite: 收藏/取消收藏壁纸 (POST)
 *    - /api/presets: 外观配置预设导出与导入 (GET / POST)
 *    - /api/active: 当前激活壁纸、轮播设置与外观配置 (GET / POST)
 * 5. 用户状态、收藏夹与外观配置落盘至 <dataDir>/wallpaper-engine/store.json。
 */
import { execFile } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

/** Wallpaper Engine App ID */
const WE_APPID = "431960";

/** 扫描缓存 TTL (60 秒) */
const SCAN_CACHE_TTL_MS = 60_000;

/** 常见默认 Steam 安装路径（当注册表未配置时回退探测） */
const COMMON_STEAM_DIRS = [
	"C:\\Program Files (x86)\\Steam",
	"C:\\Program Files\\Steam",
	"D:\\Steam",
	"D:\\SteamLibrary",
	"E:\\Steam",
	"E:\\SteamLibrary",
	"F:\\SteamLibrary",
];

/** Linux / WSL / macOS 路径 */
const UNIX_STEAM_DIRS = [
	"~/.steam/steam",
	"~/.steam/root",
	"~/.local/share/Steam",
	"~/Library/Application Support/Steam",
];

const MIME_MAP = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".ogg": "audio/ogg",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".pkg": "application/octet-stream",
	".frag": "text/plain; charset=utf-8",
	".vert": "text/plain; charset=utf-8",
	".fs": "text/plain; charset=utf-8",
	".vs": "text/plain; charset=utf-8",
	".tex": "application/octet-stream",
	".mdl": "application/octet-stream",
	".bin": "application/octet-stream",
	".tga": "image/x-tga",
	".dds": "image/vnd.ms-dds",
};

export default {
	activate(host) {
		const dir = join(host.dataDir, "wallpaper-engine");
		const storeFile = join(dir, "store.json");
		const cacheFile = join(dir, "cache.json");

		// ------------------------------------------------------------ 本地状态与索引落盘
		let store = loadStore();

		function loadStore() {
			try {
				if (existsSync(storeFile)) {
					const data = JSON.parse(readFileSync(storeFile, "utf8"));
					return {
						activeId: typeof data.activeId === "string" ? data.activeId : "",
						activeFolder: typeof data.activeFolder === "string" ? data.activeFolder : "",
						favorites: Array.isArray(data.favorites) ? data.favorites : [],
						settings: {
							glassBlur: Number(data.settings?.glassBlur ?? 0),
							glassOpacity: Number(data.settings?.glassOpacity ?? 40),
							wallpaperTheme: String(data.settings?.wallpaperTheme ?? "obsidian"),
							fpsLimit: String(data.settings?.fpsLimit ?? "0"),
							qualityPreset: String(data.settings?.qualityPreset ?? "performance"),
							antiAliasing: String(data.settings?.antiAliasing ?? "off"),
							interactive: Boolean(data.settings?.interactive ?? false),
							muteAudio: Boolean(data.settings?.muteAudio ?? true),
							pauseOnHidden: Boolean(data.settings?.pauseOnHidden ?? true),
							audioReactive: Boolean(data.settings?.audioReactive ?? false),
							autoRotateMinutes: String(data.settings?.autoRotateMinutes ?? "0"),
							customSteamPath: String(data.settings?.customSteamPath ?? ""),
							lightWallpaperMode: Boolean(data.settings?.lightWallpaperMode ?? false),
						},
					};
				}
			} catch (err) {
				host.log?.("warn", `读取 wallpaper-engine 配置失败，将重置默认：${err?.message || err}`);
			}
			return {
				activeId: "",
				activeFolder: "",
				favorites: [],
				settings: {
					glassBlur: 0,
					glassOpacity: 40,
					wallpaperTheme: "obsidian",
					fpsLimit: "0",
					qualityPreset: "high",
					antiAliasing: "off",
					interactive: false,
					muteAudio: true,
					pauseOnHidden: true,
					audioReactive: false,
					autoRotateMinutes: "0",
					customSteamPath: "",
					lightWallpaperMode: false,
				},
			};
		}

		function persistStore() {
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${storeFile}.tmp.${process.pid}`;
				writeFileSync(tmp, JSON.stringify(store, null, "\t"), "utf8");
				renameSync(tmp, storeFile);
			} catch (err) {
				host.log?.("error", `保存 wallpaper-engine 配置失败：${err?.message || err}`);
			}
		}

		// ------------------------------------------------------------ Steam 路径与库探测及持久化缓存
		let cachedSteamRoot = null;
		let cachedLibraries = [];
		let cachedWallpapers = null;
		let cachedWallpaperMap = new Map();
		let lastScanTime = 0;

		function loadCache() {
			try {
				if (existsSync(cacheFile)) {
					const data = JSON.parse(readFileSync(cacheFile, "utf8"));
					if (Array.isArray(data.wallpapers) && data.wallpapers.length > 0) {
						cachedWallpapers = data.wallpapers;
						cachedWallpaperMap = new Map(data.wallpapers.map((w) => [w.id, w]));
						if (typeof data.steamRoot === "string") cachedSteamRoot = data.steamRoot;
						if (Array.isArray(data.libraries)) cachedLibraries = data.libraries;
						lastScanTime = typeof data.timestamp === "number" ? data.timestamp : 0;
						return true;
					}
				}
			} catch {
				/* ignore cache read error */
			}
			return false;
		}

		function persistCache() {
			if (!cachedWallpapers || !cachedWallpapers.length) return;
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${cacheFile}.tmp.${process.pid}`;
				const data = {
					timestamp: lastScanTime,
					steamRoot: cachedSteamRoot,
					libraries: cachedLibraries,
					wallpapers: cachedWallpapers,
				};
				writeFileSync(tmp, JSON.stringify(data), "utf8");
				renameSync(tmp, cacheFile);
			} catch {
				/* ignore cache write error */
			}
		}

		// 启动时优先恢复磁盘索引缓存（零等待瞬间命中）
		loadCache();

		async function probeSteamFromRegistry() {
			if (process.platform !== "win32") return null;
			const regExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
			if (!existsSync(regExe)) return null;

			return new Promise((resolvePromise) => {
				try {
					execFile(
						regExe,
						["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
						{ encoding: "utf8", windowsHide: true, timeout: 5000 },
						(err, stdout) => {
							if (err) {
								resolvePromise(null);
								return;
							}
							const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || "");
							if (m && m[1]) {
								resolvePromise(normalize(m[1].trim()));
							} else {
								resolvePromise(null);
							}
						},
					);
				} catch {
					resolvePromise(null);
				}
			});
		}

		async function resolveSteamRoot() {
			if (store.settings.customSteamPath && existsSync(store.settings.customSteamPath)) {
				return normalize(store.settings.customSteamPath);
			}

			if (cachedSteamRoot && existsSync(cachedSteamRoot)) {
				return cachedSteamRoot;
			}

			const fromReg = await probeSteamFromRegistry();
			if (fromReg && existsSync(fromReg)) {
				cachedSteamRoot = fromReg;
				return fromReg;
			}

			if (process.platform === "win32") {
				for (const cand of COMMON_STEAM_DIRS) {
					if (existsSync(cand)) {
						cachedSteamRoot = cand;
						return cand;
					}
				}
			}

			const home = homedir();
			for (const cand of UNIX_STEAM_DIRS) {
				const resolvedPath = cand.startsWith("~/") ? join(home, cand.slice(2)) : cand;
				if (existsSync(resolvedPath)) {
					cachedSteamRoot = resolvedPath;
					return resolvedPath;
				}
			}

			return null;
		}

		async function resolveAllSteamLibraries() {
			const steamRoot = await resolveSteamRoot();
			if (!steamRoot) return [];

			const libsMap = new Map();
			function addLib(p) {
				const norm = normalize(p);
				const key = process.platform === "win32" ? norm.toLowerCase() : norm;
				if (!libsMap.has(key)) {
					libsMap.set(key, norm);
				}
			}

			addLib(steamRoot);

			const vdfPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
			if (existsSync(vdfPath)) {
				try {
					const content = readFileSync(vdfPath, "utf8");
					const matches = content.matchAll(/"path"\s+"([^"]+)"/gi);
					for (const match of matches) {
						if (match[1]) {
							const libPath = normalize(match[1].replace(/\\\\/g, "\\"));
							if (existsSync(libPath)) {
								addLib(libPath);
							}
						}
					}
				} catch (err) {
					host.log?.("warn", `解析 libraryfolders.vdf 失败：${err?.message || err}`);
				}
			}

			cachedLibraries = Array.from(libsMap.values());
			return cachedLibraries;
		}

		// ------------------------------------------------------------ 壁纸扫描与索引
		async function scanWallpapers(force = false) {
			const now = Date.now();
			if (!force && cachedWallpapers && now - lastScanTime < SCAN_CACHE_TTL_MS) {
				return cachedWallpapers;
			}

			const libraries = await resolveAllSteamLibraries();
			const list = [];
			const seenIds = new Set();

			for (const lib of libraries) {
				const workshopDir = join(lib, "steamapps", "workshop", "content", WE_APPID);
				if (existsSync(workshopDir)) {
					try {
						const entries = readdirSync(workshopDir, { withFileTypes: true });
						for (const entry of entries) {
							if (!entry.isDirectory()) continue;
							const itemDir = join(workshopDir, entry.name);
							const meta = parseWallpaperProject(itemDir, `workshop_${entry.name}`);
							if (meta && !seenIds.has(meta.id)) {
								seenIds.add(meta.id);
								list.push(meta);
							}
						}
					} catch (err) {
						host.log?.("warn", `扫描创意工坊目录 ${workshopDir} 出错：${err?.message || err}`);
					}
				}

				const defaultProjectsDir = join(lib, "steamapps", "common", "wallpaper_engine", "projects", "defaultprojects");
				if (existsSync(defaultProjectsDir)) {
					try {
						const entries = readdirSync(defaultProjectsDir, { withFileTypes: true });
						for (const entry of entries) {
							if (!entry.isDirectory()) continue;
							const itemDir = join(defaultProjectsDir, entry.name);
							const meta = parseWallpaperProject(itemDir, `default_${entry.name}`);
							if (meta && !seenIds.has(meta.id)) {
								seenIds.add(meta.id);
								list.push(meta);
							}
						}
					} catch (err) {
						host.log?.("warn", `扫描默认壁纸目录 ${defaultProjectsDir} 出错：${err?.message || err}`);
					}
				}
			}

			cachedWallpapers = list;
			cachedWallpaperMap = new Map(list.map((w) => [w.id, w]));
			lastScanTime = now;
			persistCache();
			return list;
		}

		async function getWallpaperById(id) {
			if (!id) return null;
			if (cachedWallpaperMap.has(id)) {
				return cachedWallpaperMap.get(id);
			}
			// 定向极速冷启动：若请求的是当前激活壁纸且记录了有效物理目录，单次读取瞬间命中，无需等待全盘扫描
			if (store.activeId === id && store.activeFolder && existsSync(store.activeFolder)) {
				const single = parseWallpaperProject(store.activeFolder, id);
				if (single) {
					cachedWallpaperMap.set(id, single);
					return single;
				}
			}
			const list = await scanWallpapers(false);
			return cachedWallpaperMap.get(id) || list.find((w) => w.id === id) || null;
		}

		/** 将壁纸包内相对路径解析到包目录内；越出包目录返回 null。 */
		function resolveInsideWallpaper(folderPath, rel) {
			const target = resolve(folderPath, String(rel).replace(/\\/g, "/"));
			const base = resolve(folderPath);
			if (target === base) return target;
			const prefix = base.endsWith(sep) ? base : base + sep;
			return target.startsWith(prefix) ? target : null;
		}

		function parseWallpaperProject(folderPath, id) {
			const projectJson = join(folderPath, "project.json");
			if (!existsSync(projectJson)) return null;

			try {
				const json = JSON.parse(readFileSync(projectJson, "utf8"));
				const title = json.title || basename(folderPath);
				const rawType = (json.type || "").toLowerCase();

				// 一次性读取目录下的所有文件条目名称放入 Set，避免反复多次系统调用
				let dirEntries = null;
				try {
					dirEntries = new Set(readdirSync(folderPath));
				} catch {
					dirEntries = new Set();
				}

				const rawFile = json.file || "";
				const rawFileNorm = rawFile ? rawFile.replace(/\\/g, "/") : "";
				// 含路径的 file 必须解析回包目录内，禁止 ../ 逃逸读取任意文件。
				const rawFileResolved = rawFileNorm.includes("/") ? resolveInsideWallpaper(folderPath, rawFileNorm) : null;
				const hasFile = rawFile
					? rawFileNorm.includes("/")
						? rawFileResolved !== null && existsSync(rawFileResolved)
						: dirEntries.has(rawFile)
					: false;
				const filePath = hasFile ? (rawFileResolved ?? join(folderPath, rawFile)) : "";
				const fileExt = extname(rawFile).toLowerCase();

				const hasScenePkg = (rawFile.endsWith(".pkg") && hasFile) || dirEntries.has("scene.pkg");
				const pkgPath = hasScenePkg
					? rawFile.endsWith(".pkg") && hasFile
						? filePath
						: join(folderPath, "scene.pkg")
					: "";

				const hasSceneJson = (rawFile.endsWith(".json") && hasFile) || dirEntries.has("scene.json");
				const isLooseScene = !hasScenePkg && (rawType === "scene" || Boolean(hasSceneJson));

				const hasWebIndex = (rawFile.endsWith(".html") && hasFile) || dirEntries.has("index.html");
				const webFile = hasWebIndex ? (rawFile.endsWith(".html") ? rawFile : "index.html") : "";

				let type = "unknown";
				if (rawType === "video" || [".mp4", ".webm", ".m4v", ".mov"].includes(fileExt)) {
					type = "video";
				} else if (rawType === "scene" || hasScenePkg || hasSceneJson || [".pkg", ".json"].includes(fileExt)) {
					type = "scene";
				} else if (rawType === "web" || hasWebIndex || [".html", ".htm"].includes(fileExt)) {
					type = "web";
				} else if (rawType === "image" || [".jpg", ".jpeg", ".png", ".webp"].includes(fileExt)) {
					type = "image";
				} else if (rawType === "application") {
					type = "application";
				}

				let previewFile = json.preview || "";
				// preview 同 file：含路径时强制解析回包目录内。
				const previewResolved =
					previewFile && previewFile.includes("/") ? resolveInsideWallpaper(folderPath, previewFile) : null;
				let previewPath = previewFile ? (previewResolved ?? join(folderPath, previewFile)) : "";
				let hasPreview = previewFile
					? previewFile.includes("/")
						? previewResolved !== null && existsSync(previewPath)
						: dirEntries.has(previewFile)
					: false;

				if (!hasPreview) {
					for (const cand of ["preview.jpg", "preview.gif", "preview.png", "preview.webp"]) {
						if (dirEntries.has(cand)) {
							previewFile = cand;
							previewPath = join(folderPath, cand);
							hasPreview = true;
							break;
						}
					}
				}

				return {
					id,
					title,
					type,
					rawType,
					description: json.description || "",
					folder: folderPath,
					file: rawFile,
					filePath,
					pkgPath,
					hasSceneJson: Boolean(hasSceneJson),
					isLooseScene: Boolean(isLooseScene),
					webFile,
					previewFile,
					previewPath: hasPreview ? previewPath : "",
					tags: Array.isArray(json.tags) ? json.tags : [],
					rating: json.contentrating || "Everyone",
					properties: json.general?.properties || null,
				};
			} catch {
				return null;
			}
		}

		// ------------------------------------------------------------ HTTP 路由服务
		const offRoutes = [];

		function registerRoute(method, path, handler) {
			const off = host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					host.log?.("error", `[wallpaper-engine] ${method} ${path} 抛错: ${err?.message || err}`);
					if (!res.headersSent) {
						res.status(500).json({ ok: false, error: err?.message || "Internal error" });
					}
				}
			});
			offRoutes.push(off);
		}

		// 1. GET /api/wallpapers —— 壁纸列表查询
		registerRoute("GET", "/api/wallpapers", async (_req, res) => {
			const steamRoot = await resolveSteamRoot();
			const list = await scanWallpapers(false);
			const playable = list.filter((w) => w.type !== "application");

			res.json({
				ok: true,
				steamFound: Boolean(steamRoot),
				steamPath: steamRoot || "",
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				total: playable.length,
				wallpapers: playable.map((w) => ({
					id: w.id,
					title: w.title,
					type: w.type,
					file: w.file,
					hasVideo: w.type === "video" && Boolean(w.filePath),
					hasScene: w.type === "scene" && (Boolean(w.pkgPath) || Boolean(w.hasSceneJson) || Boolean(w.isLooseScene)),
					hasPkg: Boolean(w.pkgPath),
					isLooseScene: Boolean(w.isLooseScene),
					hasWeb: w.type === "web" && Boolean(w.webFile),
					hasImage: w.type === "image" && Boolean(w.filePath),
					hasPreview: Boolean(w.previewPath),
					isFavorite: store.favorites.includes(w.id),
					tags: w.tags,
					rating: w.rating,
					description: w.description,
				})),
			});
		});

		// 2. GET /api/rescan —— 强制重新扫描
		registerRoute("GET", "/api/rescan", async (_req, res) => {
			cachedSteamRoot = null;
			cachedWallpapers = null;
			const list = await scanWallpapers(true);
			const steamRoot = await resolveSteamRoot();
			const playable = list.filter((w) => w.type !== "application");

			res.json({
				ok: true,
				steamFound: Boolean(steamRoot),
				steamPath: steamRoot || "",
				total: playable.length,
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				wallpapers: playable.map((w) => ({
					id: w.id,
					title: w.title,
					type: w.type,
					file: w.file,
					hasVideo: w.type === "video" && Boolean(w.filePath),
					hasScene: w.type === "scene" && (Boolean(w.pkgPath) || Boolean(w.hasSceneJson) || Boolean(w.isLooseScene)),
					hasPkg: Boolean(w.pkgPath),
					isLooseScene: Boolean(w.isLooseScene),
					hasWeb: w.type === "web" && Boolean(w.webFile),
					hasImage: w.type === "image" && Boolean(w.filePath),
					hasPreview: Boolean(w.previewPath),
					isFavorite: store.favorites.includes(w.id),
					tags: w.tags,
					rating: w.rating,
					description: w.description,
				})),
			});
		});

		// 3. GET /api/preview —— 缩略图服务 (强缓存 + ETag 协商缓存)
		registerRoute("GET", "/api/preview", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.previewPath || !existsSync(item.previewPath)) {
				res.status(404).end("Preview not found");
				return;
			}

			const stat = statSync(item.previewPath);
			const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
			res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
			res.setHeader("ETag", etag);

			if (req.headers["if-none-match"] === etag) {
				res.status(304).end();
				return;
			}

			const ext = extname(item.previewPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			res.setHeader("Content-Type", contentType);
			createReadStream(item.previewPath).pipe(res);
		});

		// 4. GET /api/media —— 壁纸流式播放 (HTTP 206 Partial Content + 强缓存)
		registerRoute("GET", "/api/media", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.filePath || !existsSync(item.filePath)) {
				res.status(404).end("Media file not found");
				return;
			}

			const stat = statSync(item.filePath);
			const fileSize = stat.size;
			const ext = extname(item.filePath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";
			const etag = `W/"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

			res.setHeader("Cache-Control", "public, max-age=604800");
			res.setHeader("ETag", etag);

			const range = req.headers.range;
			if (range) {
				const parts = range.replace(/bytes=/, "").split("-");
				const start = parseInt(parts[0], 10);
				const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

				if (start >= fileSize || end >= fileSize) {
					res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
					return;
				}

				const chunksize = end - start + 1;
				res.writeHead(206, {
					"Content-Range": `bytes ${start}-${end}/${fileSize}`,
					"Accept-Ranges": "bytes",
					"Content-Length": chunksize,
					"Content-Type": contentType,
				});

				const stream = createReadStream(item.filePath, { start, end });
				stream.pipe(res);
			} else {
				if (req.headers["if-none-match"] === etag) {
					res.status(304).end();
					return;
				}
				res.writeHead(200, {
					"Content-Length": fileSize,
					"Accept-Ranges": "bytes",
					"Content-Type": contentType,
				});
				createReadStream(item.filePath).pipe(res);
			}
		});

		// 5. GET /api/pkg —— Scene 壁纸二进制 scene.pkg 数据流 (强缓存 + 协商缓存)
		registerRoute("GET", "/api/pkg", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.pkgPath || !existsSync(item.pkgPath)) {
				res.status(404).end("Scene package file not found");
				return;
			}

			const stat = statSync(item.pkgPath);
			const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
			res.setHeader("Cache-Control", "public, max-age=604800, immutable");
			res.setHeader("ETag", etag);

			if (req.headers["if-none-match"] === etag) {
				res.status(304).end();
				return;
			}

			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Length": stat.size,
			});
			createReadStream(item.pkgPath).pipe(res);
		});

		// 6. GET /api/project —— 读取原始 project.json (强缓存 + 协商缓存)
		registerRoute("GET", "/api/project", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item) {
				res.status(404).end("Wallpaper not found");
				return;
			}

			const projectJsonPath = join(item.folder, "project.json");
			if (!existsSync(projectJsonPath)) {
				res.status(404).end("project.json not found");
				return;
			}

			try {
				const stat = statSync(projectJsonPath);
				const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
				res.setHeader("Cache-Control", "public, max-age=86400");
				res.setHeader("ETag", etag);

				if (req.headers["if-none-match"] === etag) {
					res.status(304).end();
					return;
				}

				const json = JSON.parse(readFileSync(projectJsonPath, "utf8"));
				res.json(json);
			} catch (err) {
				res.status(500).json({ ok: false, error: err.message });
			}
		});

		// 6.5 GET /api/scene-file —— 散装 Scene 场景工程文件安全读取服务 (支持官方内置散装工程与未封包壁纸)
		registerRoute("GET", "/api/scene-file", async (req, res) => {
			const id = String(req.query?.id || "");
			const reqRelFile = String(req.query?.file || "");

			if (!id || !reqRelFile) {
				res.status(400).end("Missing wallpaper id or file");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.folder || !existsSync(item.folder)) {
				res.status(404).end("Wallpaper folder not found");
				return;
			}

			const safeRel = reqRelFile.replace(/\\/g, "/").replace(/^\/+/, "");
			const targetPath = resolve(item.folder, safeRel);
			const normalizedBase = resolve(item.folder);
			const basePrefix = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;

			if ((targetPath !== normalizedBase && !targetPath.startsWith(basePrefix)) || !existsSync(targetPath)) {
				res.status(404).end("File not found in wallpaper directory");
				return;
			}

			const stat = statSync(targetPath);
			if (!stat.isFile()) {
				res.status(403).end("Cannot access directories directly");
				return;
			}

			const ext = extname(targetPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";
			const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

			res.setHeader("Content-Type", contentType);
			res.setHeader("Cache-Control", "public, max-age=604800, immutable");
			res.setHeader("ETag", etag);

			if (req.headers["if-none-match"] === etag) {
				res.status(304).end();
				return;
			}

			createReadStream(targetPath).pipe(res);
		});

		// 7. GET /api/web & GET /api/web/* —— 网页壁纸静态资源沙箱服务
		async function handleWeb(req, res) {
			const pluginPath = String(req.pluginPath || req.path || req.url || "");
			let id = "";
			let reqRelFile = "";

			// 优先从语义化子路径中解析: /api/web/<wallpaperId>/<relativeFilePath>
			const cleanPath = pluginPath.split("?")[0];
			const match = cleanPath.match(/^\/?api\/web\/([^/?#]+)(?:\/(.*))?$/);
			if (match) {
				id = decodeURIComponent(match[1]);
				reqRelFile = match[2] ? decodeURIComponent(match[2]) : "index.html";
			} else {
				id = String(req.query?.id || "");
				reqRelFile = String(req.query?.file || "index.html");
			}

			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.folder || !existsSync(item.folder)) {
				res.status(404).end("Wallpaper folder not found");
				return;
			}

			const safeRel = reqRelFile.replace(/\\/g, "/").replace(/^\/+/, "");
			const targetPath = resolve(item.folder, safeRel);
			const normalizedBase = resolve(item.folder);
			const basePrefix = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;

			if ((targetPath !== normalizedBase && !targetPath.startsWith(basePrefix)) || !existsSync(targetPath)) {
				res.status(404).end("File not found in wallpaper directory");
				return;
			}

			const stat = statSync(targetPath);
			if (!stat.isFile()) {
				res.status(403).end("Cannot access directories directly");
				return;
			}

			const ext = extname(targetPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			if (ext === ".html" || ext === ".htm") {
				let html = readFileSync(targetPath, "utf8");

				// 智能改写 HTML 内部的静态资源相对引用，保证在任意宿主版本与 iframe 模式下均能无缝正确定位
				html = html.replace(/\b(src|href|poster)\s*=\s*(["'])([^"']+)\2/gi, (_match, attr, quote, url) => {
					if (/^(https?:|\/\/|data:|blob:|javascript:|#)/i.test(url.trim())) {
						return _match;
					}
					const cleanRel = url.trim().replace(/^\.?\/+/, "");
					const rewritten = `/plugins-api/wallpaper-engine/api/web?id=${encodeURIComponent(item.id)}&file=${cleanRel}`;
					return `${attr}=${quote}${rewritten}${quote}`;
				});

				// 读取 project.json 中的初始 properties
				let initialProps = {};
				try {
					const pJsonPath = join(item.folder, "project.json");
					if (existsSync(pJsonPath)) {
						const pJson = JSON.parse(readFileSync(pJsonPath, "utf8"));
						if (pJson.general?.properties) {
							for (const [k, v] of Object.entries(pJson.general.properties)) {
								initialProps[k] = { value: v.value };
							}
						}
					}
				} catch {}

				const encodedId = encodeURIComponent(item.id);
				const escapedTitle = (item.title || "Wallpaper Engine").replace(/"/g, '\\"');
				const weShim = `
<base href="/plugins-api/wallpaper-engine/api/web/${encodedId}/" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>
html, body {
	width: 100% !important;
	height: 100% !important;
	margin: 0 !important;
	padding: 0 !important;
	overflow: hidden !important;
	background: #000 !important;
}
canvas, video, img {
	image-rendering: -webkit-optimize-contrast;
	image-rendering: high-quality;
}
</style>
<script>
/* Wallpaper Engine Web API High-Fidelity Runtime Shim */
(function() {
	var initialProps = ${JSON.stringify(initialProps)};
	var wePropListener = window.wallpaperPropertyListener || {};
	var audioCallbacks = [];
	var externalAudioReceived = false;
	var lastExternalAudioTime = 0;

	function dispatchInitialProps(target) {
		if (!target) return;
		try {
			if (typeof target.applyUserProperties === "function") {
				target.applyUserProperties(initialProps);
			}
			if (typeof target.applyGeneralProperties === "function") {
				target.applyGeneralProperties({ fps: 60 });
			}
		} catch (err) {
			console.warn("[wallpaper-engine] dispatch props error:", err);
		}
	}

	Object.defineProperty(window, "wallpaperPropertyListener", {
		configurable: true,
		enumerable: true,
		get: function() {
			return wePropListener;
		},
		set: function(val) {
			wePropListener = val || {};
			if (typeof queueMicrotask === "function") {
				queueMicrotask(function() { dispatchInitialProps(wePropListener); });
			} else {
				setTimeout(function() { dispatchInitialProps(wePropListener); }, 0);
			}
		}
	});

	window.wallpaperRegisterAudioListener = function(cb) {
		if (typeof cb === "function") {
			audioCallbacks.push(cb);
			window.__weAudioCb = cb;
		}
	};

	window.__weReceiveAudio = function(arr) {
		if (!arr || !arr.length) return;
		externalAudioReceived = true;
		lastExternalAudioTime = performance.now();
		for (var i = 0; i < audioCallbacks.length; i++) {
			try { audioCallbacks[i](arr); } catch (e) {}
		}
		if (typeof window.__weAudioCb === "function" && audioCallbacks.indexOf(window.__weAudioCb) === -1) {
			try { window.__weAudioCb(arr); } catch (e) {}
		}
	};

	// 内部自主声学仿真引擎（对齐 Wallpaper Engine / WebWallGL 原生规范：无外源或静音时自动回落平滑声学律动，杜绝静止）
	var simArray = new Array(64);
	var simRaf = null;
	function simTick() {
		var now = performance.now();
		if (!externalAudioReceived || (now - lastExternalAudioTime > 120)) {
			var t = now * 0.0025;
			for (var i = 0; i < 64; i++) {
				var w1 = Math.sin(t * 1.2 + i * 0.28) * 0.5 + 0.5;
				var w2 = Math.cos(t * 0.7 - i * 0.16) * 0.5 + 0.5;
				var w3 = Math.sin(t * 2.1 + i * 0.45) * 0.5 + 0.5;
				var decay = Math.pow(1 - (i / 64), 0.45);
				var val = Math.max(0.01, Math.min(1.0, (w1 * 0.45 + w2 * 0.35 + w3 * 0.2) * decay));
				simArray[i] = val;
			}
			for (var j = 0; j < audioCallbacks.length; j++) {
				try { audioCallbacks[j](simArray); } catch (e) {}
			}
			if (typeof window.__weAudioCb === "function" && audioCallbacks.indexOf(window.__weAudioCb) === -1) {
				try { window.__weAudioCb(simArray); } catch (e) {}
			}
		}
		simRaf = requestAnimationFrame(simTick);
	}
	simRaf = requestAnimationFrame(simTick);

	window.wallpaperRegisterMediaPropertiesListener = window.wallpaperRegisterMediaPropertiesListener || function(cb) {
		try { cb({ title: "${escapedTitle}", artist: "Wallpaper Engine" }); } catch (e) {}
	};
	window.wallpaperRegisterMediaThumbnailListener = window.wallpaperRegisterMediaThumbnailListener || function() {};
	window.wallpaperRegisterMediaPlaybackListener = window.wallpaperRegisterMediaPlaybackListener || function(cb) {
		try { cb({ state: 1 }); } catch (e) {}
	};
	window.wallpaperRegisterMediaTimelineListener = window.wallpaperRegisterMediaTimelineListener || function() {};
	window.wallpaperMediaIntegration = window.wallpaperMediaIntegration || {
		PLAYBACK_PLAYING: 1,
		PLAYBACK_STOPPED: 0,
		PLAYBACK_PAUSED: 2
	};

	window.wallpaperReady = window.wallpaperReady || function() {};

	window.addEventListener("DOMContentLoaded", function() {
		setTimeout(function() {
			dispatchInitialProps(window.wallpaperPropertyListener);
			try { window.wallpaperReady && window.wallpaperReady(); } catch (e) {}
		}, 60);
	});
})();
</script>
`;
				if (html.includes("<head>")) {
					html = html.replace("<head>", `<head>${weShim}`);
				} else {
					html = `${weShim}${html}`;
				}

				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": Buffer.byteLength(html, "utf8"),
					// 网页壁纸以独立沙箱 origin 渲染：禁 same-origin，脚本逃不出 opaque origin，
					// 无法触及应用页面/API/存储；default-src 放开以兼容依赖远程资源的壁纸。
					"Content-Security-Policy":
						"sandbox allow-scripts allow-forms allow-popups allow-modals; " +
						"default-src * data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob: *; " +
						"style-src 'unsafe-inline' *; img-src * data: blob:; media-src * blob:",
				});
				res.end(html);
				return;
			}

			const headers = {
				"Content-Type": contentType,
				"Content-Length": stat.size,
				"Cache-Control": "public, max-age=3600",
			};
			if (ext === ".svg") {
				// SVG 文档形态沙箱化（防内嵌脚本跨站）
				headers["Content-Security-Policy"] = "sandbox";
				headers["X-Content-Type-Options"] = "nosniff";
			}
			res.writeHead(200, headers);
			createReadStream(targetPath).pipe(res);
		}

		registerRoute("GET", "/api/web", handleWeb);
		registerRoute("GET", "/api/web/*", handleWeb);

		// 8. POST /api/favorite —— 切换收藏状态
		registerRoute("POST", "/api/favorite", async (req, res) => {
			const id = String(req.body?.id || "");
			if (!id) {
				res.status(400).json({ ok: false, error: "Missing id" });
				return;
			}

			const idx = store.favorites.indexOf(id);
			if (idx >= 0) {
				store.favorites.splice(idx, 1);
			} else {
				store.favorites.push(id);
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_favorites_updated",
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				id,
				isFavorite: store.favorites.includes(id),
				favorites: store.favorites,
			});
		});

		// 9. GET /api/presets & POST /api/presets —— 预设导出与导入
		registerRoute("GET", "/api/presets", async (_req, res) => {
			res.json({
				ok: true,
				schema: "pi-wallpaper-engine-preset-v1",
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				timestamp: Date.now(),
			});
		});

		registerRoute("POST", "/api/presets", async (req, res) => {
			const preset = req.body || {};
			if (preset.settings && typeof preset.settings === "object") {
				store.settings = {
					...store.settings,
					...preset.settings,
				};
			}
			if (typeof preset.activeId === "string") {
				store.activeId = preset.activeId;
			}
			if (Array.isArray(preset.favorites)) {
				store.favorites = preset.favorites;
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_state_updated",
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});
		});

		// 10. GET /api/active —— 获取当前激活的壁纸与设置 (包含完整直显元数据)
		registerRoute("GET", "/api/active", async (_req, res) => {
			const activeItem = await getWallpaperById(store.activeId);

			res.json({
				ok: true,
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				activeWallpaper: activeItem
					? {
							id: activeItem.id,
							title: activeItem.title,
							type: activeItem.type,
							file: activeItem.file,
							hasVideo: activeItem.type === "video" && Boolean(activeItem.filePath),
							hasScene:
								activeItem.type === "scene" &&
								(Boolean(activeItem.pkgPath) || Boolean(activeItem.hasSceneJson) || Boolean(activeItem.isLooseScene)),
							hasPkg: Boolean(activeItem.pkgPath),
							isLooseScene: Boolean(activeItem.isLooseScene),
							hasWeb: activeItem.type === "web" && Boolean(activeItem.webFile),
							hasImage: activeItem.type === "image" && Boolean(activeItem.filePath),
							hasPreview: Boolean(activeItem.previewPath),
							webFile: activeItem.webFile || "index.html",
						}
					: null,
			});
		});

		// 11. POST /api/active —— 保存激活的壁纸与设置 (记录物理目录以便定点极速冷启动)
		registerRoute("POST", "/api/active", async (req, res) => {
			const body = req.body || {};
			if (typeof body.activeId === "string") {
				store.activeId = body.activeId;
				const matched = cachedWallpaperMap.get(body.activeId);
				if (matched?.folder) {
					store.activeFolder = matched.folder;
				}
			}
			if (Array.isArray(body.favorites)) {
				store.favorites = body.favorites;
			}
			if (body.settings && typeof body.settings === "object") {
				store.settings = {
					...store.settings,
					glassBlur: Number(body.settings.glassBlur ?? store.settings.glassBlur),
					glassOpacity: Number(body.settings.glassOpacity ?? store.settings.glassOpacity),
					wallpaperTheme: String(body.settings.wallpaperTheme ?? store.settings.wallpaperTheme),
					fpsLimit: String(body.settings.fpsLimit ?? store.settings.fpsLimit),
					qualityPreset: String(body.settings.qualityPreset ?? store.settings.qualityPreset),
					antiAliasing: String(body.settings.antiAliasing ?? store.settings.antiAliasing),
					interactive: Boolean(body.settings.interactive ?? store.settings.interactive),
					muteAudio: Boolean(body.settings.muteAudio ?? store.settings.muteAudio),
					pauseOnHidden: Boolean(body.settings.pauseOnHidden ?? store.settings.pauseOnHidden),
					audioReactive: Boolean(body.settings.audioReactive ?? store.settings.audioReactive),
					autoRotateMinutes: String(body.settings.autoRotateMinutes ?? store.settings.autoRotateMinutes),
					customSteamPath: String(body.settings.customSteamPath ?? store.settings.customSteamPath),
					lightWallpaperMode: Boolean(body.settings.lightWallpaperMode ?? store.settings.lightWallpaperMode),
				};
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_state_updated",
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});
		});

		host.log?.("info", "wallpaper-engine 插件服务端 (v0.3.13) 已就绪");

		return () => {
			for (const off of offRoutes) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			offRoutes.length = 0;
		};
	},
};
