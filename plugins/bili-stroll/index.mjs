import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BilibiliApiClient } from "./bilibili-api.mjs?v=2.6.0";
import { BiliCredentialManager } from "./credentials.mjs?v=2.0.1";
import { BiliDutyEngine, todayStr } from "./duty.mjs?v=2.4.0";
import { AskEngine } from "./lib/ask.mjs?v=2.4.0";
import { DeliverySystem } from "./lib/delivery.mjs?v=2.4.0";
import { ContentIndex } from "./lib/indexer.mjs?v=2.4.0";
import { BiliStore } from "./lib/store.mjs?v=2.6.0";
import { TasteEngine } from "./lib/taste.mjs?v=2.4.0";
import { DmService } from "./lib/dm-service.mjs?v=2.4.0";
import { readVideoContent } from "./lib/video-content.mjs";
import { BiliFavOps } from "./lib/favops.mjs?v=2.6.0";
import { resolveUid } from "./lib/uid.mjs?v=2.0.1";
import { ensureUv } from "./lib/uvfetch.mjs?v=2.0.1";
import { describePrompts, validateFixed } from "./lib/prompts.mjs";
import { appendVerifyToReport, verifyRecent } from "./lib/verify.mjs?v=2.0.1";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WINDOWS = {
	noon: { label: "中午 (12:00–14:00)", start: "12:00", end: "14:00" },
	night: { label: "夜间 (00:30–08:30)", start: "00:30", end: "08:30" },
};

function inWindow(now, w) {
	const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	return cur >= w.start && cur <= w.end;
}

export default {
	activate(host) {
		const storageDir = join(host.dataDir, "bili-stroll");
		const outDir = join(storageDir, "out");
		const reportsDir = join(storageDir, "reports");
		const digestDir = join(storageDir, "digest");
		const logFile = join(storageDir, "duty.log");
		const installLogFile = join(storageDir, "install.log");
		const asrLogFile = join(storageDir, "asr-install.log");
		const seenFile = join(storageDir, "seen.md");

		mkdirSync(storageDir, { recursive: true });
		mkdirSync(outDir, { recursive: true });
		mkdirSync(reportsDir, { recursive: true });
		mkdirSync(digestDir, { recursive: true });

		const credManager = new BiliCredentialManager(storageDir);
		const apiClient = new BilibiliApiClient(credManager);
		const favOps = new BiliFavOps(storageDir);

		// 智能层：状态库 + 品味账本 + 内容索引 + 意图问答 + 投递协议。
		// 任何一步初始化失败都只降级、不影响插件主流程。
		let intel = null;
		try {
			const store = new BiliStore(join(storageDir, "db"));
			const taste = new TasteEngine({ store, log: (lvl, msg) => host.log?.(lvl, msg) });
			const contentIndex = new ContentIndex({ store, api: apiClient, log: (m) => host.log?.("warn", m) });
			const settingsFn = () => loadLocalCfg();
			const ask = new AskEngine({
				store,
				api: apiClient,
				host,
				taste,
				index: contentIndex,
				settings: settingsFn,
				readVideoContent: (bvid, options = {}) =>
					readVideoContent({ api: apiClient, host, storageDir, bvid, settings: loadLocalCfg(), ...options }),
				log: (lvl, msg) => host.log?.(lvl, msg),
			});
			const delivery = new DeliverySystem({
				store,
				api: apiClient,
				favOps,
				taste,
				ask,
				index: contentIndex,
				settings: settingsFn,
				log: (msg) => host.log?.("warn", msg),
			});
			intel = { store, taste, index: contentIndex, ask, delivery };
			try {
				const imported = store.importSeenMd(seenFile);
				if (imported) host.log?.("info", `[bili-stroll] 已把 seen.md 的 ${imported} 条判重记录并入状态库`);
			} catch {}
			try {
				store.prune();
			} catch {}
			host.log?.("info", `[bili-stroll] 状态库就绪 ${JSON.stringify(store.stats())}`);
		} catch (err) {
			host.log?.("warn", `[bili-stroll] 智能层初始化失败，降级为旧管线：${err.message}`);
			intel = null;
		}

		const dutyEngine = new BiliDutyEngine({
			storageDir,
			apiClient,
			host,
			intel,
			log: (lvl, msg) => host.log?.(lvl, msg),
		});

		const unregisterFns = [];

		const cfgFile = join(storageDir, "config.json");
		// 配置单源：host.getSettings() 是底座，config.json 只存显式改过的 patch，合并时文件优先。
		const readFileCfg = () => {
			try {
				if (existsSync(cfgFile)) return JSON.parse(readFileSync(cfgFile, "utf8")) || {};
			} catch {}
			return {};
		};
		const loadLocalCfg = () => {
			const s = host.getSettings?.() || {};
			return { ...s, ...readFileCfg() };
		};
		const NUM_KEYS = new Set([
			"perDay",
			"dmUid",
			"favFolderId",
			"dmWatchMinutes",
			"dmReplyPerDay",
			"commentPerRound",
			"replyPerRound",
		]);
		const BOOL_KEYS = new Set([
			"peakValley",
			"noon",
			"night",
			"dmWatch",
			"dmAutoReply",
			"autoComment",
			"replyToComments",
			"transcribe",
			"humanFunnel",
			"memoryEnabled",
			"crowdDigest",
		]);
		const normalizeCfgPatch = (patch) => {
			const out = {};
			for (const [k, v] of Object.entries(patch || {})) {
				if (v === undefined) continue;
				if (NUM_KEYS.has(k)) {
					const n = Number(v);
					if (Number.isFinite(n)) out[k] = n;
					continue;
				}
				if (BOOL_KEYS.has(k)) {
					out[k] = v === true || v === "true" || v === 1 || v === "1";
					continue;
				}
				out[k] = v;
			}
			return out;
		};
		// 固定追加保存前先过格式校验：缺契约键或删掉不可信条款直接拒绝，不落盘
		const FIXED_KEY_KINDS = {
			analyzeFixed: "analyze",
			impressionFixed: "impression",
			previewFixed: "preview",
			crowdFixed: "crowd",
			dmFixed: "dm",
		};
		const checkFixedPatch = (patch) => {
			for (const [key, kind] of Object.entries(FIXED_KEY_KINDS)) {
				if (!(key in (patch || {}))) continue;
				const text = String(patch[key] ?? "").trim();
				if (!text) {
					patch[key] = "";
					continue;
				}
				const r = validateFixed(kind, text);
				if (!r.ok) return r.error;
				patch[key] = r.fixed;
			}
			return null;
		};
		const saveLocalCfg = (patch) => {
			try {
				const normalized = normalizeCfgPatch(patch);
				const fileOnly = readFileCfg();
				const nextFile = { ...fileOnly, ...normalized };
				writeFileSync(cfgFile, JSON.stringify(nextFile, null, 2), "utf8");
				return loadLocalCfg();
			} catch {
				return loadLocalCfg();
			}
		};
		let restartDmWatcher = () => {};

		const venvDir = join(storageDir, ".venv");
		const venvPython = () =>
			process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");

		const asrDir = join(storageDir, ".venv-asr");
		const asrPython = () =>
			process.platform === "win32" ? join(asrDir, "Scripts", "python.exe") : join(asrDir, "bin", "python");

		const hasPkg = (vRoot, prefix) => {
			const win = join(vRoot, "Lib", "site-packages");
			const posix = join(vRoot, "lib");
			for (const p of [win, posix]) {
				if (existsSync(p)) {
					try {
						const entries = readdirSync(p);
						if (entries.some((e) => e.toLowerCase().startsWith(prefix.toLowerCase()))) return true;
					} catch {}
				}
			}
			return false;
		};

		const missingVenvDeps = () => {
			if (!existsSync(venvPython())) return ["python", "bilibili_api", "mcp", "qrcode"];
			const deps = ["bilibili_api", "mcp", "qrcode"];
			return deps.filter((d) => !hasPkg(venvDir, d));
		};

		const venvReadyNow = () => existsSync(venvPython()) && missingVenvDeps().length === 0;
		const asrReadyNow = () => existsSync(asrPython()) && hasPkg(asrDir, "faster_whisper");

		const route = (method, path, handler) => {
			if (typeof host.route === "function") {
				const off = host.route(method, path, async (req, res) => {
					try {
						await handler(req, res);
					} catch (err) {
						host.log?.("error", `[bili-stroll] http ${method} ${path} error: ${err.message}`);
						if (!res.headersSent) {
							res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
						}
					}
				});
				if (typeof off === "function") unregisterFns.push(off);
			}
		};

		let installing = false;
		const appendInstall = (s) => {
			try {
				appendFileSync(installLogFile, s, "utf8");
			} catch {}
		};

		const runInstall = () => {
			if (installing) {
				return { ok: true, busy: true, log: installLogFile, hint: "正在安装主依赖，请勿重复点击" };
			}
			installing = true;
			appendInstall(`\n=== ${new Date().toISOString()} 开始安装主依赖环境 ===\n`);

			(async () => {
				try {
					const mirrors = [
						"https://mirrors.aliyun.com/pypi/simple/",
						"https://pypi.tuna.tsinghua.edu.cn/simple/",
						"https://mirrors.ustc.edu.cn/pypi/simple/",
					];
					const uvCmd = await ensureUv({ dir: join(storageDir, "bin"), log: appendInstall });
					const py = venvPython();

					if (!existsSync(py)) {
						if (uvCmd) {
							appendInstall(`使用 uv 创建独立虚拟环境: ${venvDir}\n`);
							const code = await new Promise((resolve) => {
								const c = spawn(uvCmd, ["venv", "--seed", venvDir], { cwd: storageDir, windowsHide: true });
								c.stdout?.on("data", (d) => appendInstall(String(d)));
								c.stderr?.on("data", (d) => appendInstall(String(d)));
								c.on("exit", resolve);
								c.on("error", () => resolve(1));
							});
							if (code !== 0) appendInstall("uv 创建虚拟环境未成功，尝试直接安装\n");
						}
					} else {
						appendInstall(`检测到已存在的虚拟环境: ${venvDir}\n`);
					}

					const reqPkgs = ["bilibili-api-python", "mcp<2", "qrcode", "aiohttp"];
					const venvPy = venvPython();
					let installCode = 1;

					for (const mirror of mirrors) {
						if (installCode === 0) break;
						appendInstall(`\n尝试从镜像源安装依赖: ${mirror}...\n`);

						if (uvCmd && existsSync(venvPy)) {
							installCode = await new Promise((resolve) => {
								const c = spawn(uvCmd, ["pip", "install", "--python", venvPy, "-i", mirror, ...reqPkgs], {
									cwd: storageDir,
									windowsHide: true,
								});
								c.stdout?.on("data", (d) => appendInstall(String(d)));
								c.stderr?.on("data", (d) => appendInstall(String(d)));
								c.on("exit", resolve);
								c.on("error", () => resolve(1));
							});
						}

						if (installCode !== 0 && existsSync(venvPy)) {
							appendInstall(`使用 python -m pip 从 ${mirror} 重试...\n`);
							installCode = await new Promise((resolve) => {
								const c = spawn(venvPy, ["-m", "pip", "install", "-i", mirror, ...reqPkgs], {
									cwd: storageDir,
									windowsHide: true,
								});
								c.stdout?.on("data", (d) => appendInstall(String(d)));
								c.stderr?.on("data", (d) => appendInstall(String(d)));
								c.on("exit", resolve);
								c.on("error", () => resolve(1));
							});
						}
					}

					if (installCode === 0 && existsSync(venvPy)) {
						saveLocalCfg({ pythonPath: venvPy });
						appendInstall(`✅ 依赖安装圆满完成！已设置 pythonPath 为 ${venvPy}\n`);
					} else {
						appendInstall(`依赖安装结束 (exit code ${installCode})\n`);
					}
				} catch (err) {
					appendInstall(`安装过程异常: ${err.message}\n`);
				} finally {
					installing = false;
				}
			})();

			return { ok: true, started: true, log: installLogFile, hint: "正在后台安装环境，通常需数十秒" };
		};

		let installingAsr = false;
		const appendAsr = (s) => {
			try {
				appendFileSync(asrLogFile, s, "utf8");
			} catch {}
		};

		const runAsrInstall = () => {
			if (installingAsr) {
				return { ok: true, busy: true, log: asrLogFile, hint: "正在安装转写依赖，请勿重复点击" };
			}
			installingAsr = true;
			appendAsr(`\n=== ${new Date().toISOString()} 开始安装本地 Whisper 转写依赖 ===\n`);

			(async () => {
				try {
					const mirrors = [
						"https://mirrors.aliyun.com/pypi/simple/",
						"https://pypi.tuna.tsinghua.edu.cn/simple/",
						"https://mirrors.ustc.edu.cn/pypi/simple/",
					];
					const uvCmd = await ensureUv({ dir: join(storageDir, "bin"), log: appendAsr });
					const py = asrPython();

					if (!existsSync(py) && uvCmd) {
						appendAsr(`创建转写虚拟环境: ${asrDir}\n`);
						await new Promise((resolve) => {
							const c = spawn(uvCmd, ["venv", "--seed", asrDir], { cwd: storageDir, windowsHide: true });
							c.stdout?.on("data", (d) => appendAsr(String(d)));
							c.stderr?.on("data", (d) => appendAsr(String(d)));
							c.on("exit", resolve);
							c.on("error", () => resolve(1));
						});
					} else if (existsSync(py)) {
						appendAsr(`检测到已存在的转写环境: ${asrDir}\n`);
					}

					const asrPkgs = ["faster-whisper", "yt-dlp", "av==12.3.0", "Pillow", "rapidocr-onnxruntime"];
					const asrPy = asrPython();
					let code = 1;

					for (const mirror of mirrors) {
						if (code === 0) break;
						appendAsr(`\n尝试从镜像源安装转写依赖: ${mirror}...\n`);

						if (uvCmd && existsSync(asrPy)) {
							code = await new Promise((resolve) => {
								const c = spawn(uvCmd, ["pip", "install", "--python", asrPy, "-i", mirror, ...asrPkgs], {
									cwd: storageDir,
									windowsHide: true,
								});
								c.stdout?.on("data", (d) => appendAsr(String(d)));
								c.stderr?.on("data", (d) => appendAsr(String(d)));
								c.on("exit", resolve);
								c.on("error", () => resolve(1));
							});
						}

						if (code !== 0 && existsSync(asrPy)) {
							code = await new Promise((resolve) => {
								const c = spawn(asrPy, ["-m", "pip", "install", "-i", mirror, ...asrPkgs], {
									cwd: storageDir,
									windowsHide: true,
								});
								c.stdout?.on("data", (d) => appendAsr(String(d)));
								c.stderr?.on("data", (d) => appendAsr(String(d)));
								c.on("exit", resolve);
								c.on("error", () => resolve(1));
							});
						}
					}

					if (code === 0) {
						appendAsr("✅ 转写依赖安装成功！已具备无字幕视频本地 Whisper 转写能力。\n");
					} else {
						appendAsr(`转写依赖安装结束 (exit code ${code})\n`);
					}
				} catch (err) {
					appendAsr(`转写依赖安装异常: ${err.message}\n`);
				} finally {
					installingAsr = false;
				}
			})();

			return { ok: true, started: true, log: asrLogFile, hint: "正在后台安装转写依赖，请观察日志" };
		};

		const parseSeenTable = () => {
			if (!existsSync(seenFile)) return [];
			let text = "";
			try {
				text = readFileSync(seenFile, "utf8");
			} catch {
				return [];
			}

			const out = [];
			const seen = new Set();
			const deliveredBvs = new Set();

			for (const raw of text.split(/\r?\n/)) {
				const hit = /\|\s*(BV[0-9A-Za-z]{10})\s*\|\s*(\d{6,})\s*\|/.exec(raw);
				if (hit) deliveredBvs.add(hit[1]);
			}

			for (const raw of text.split(/\r?\n/)) {
				const line = raw.trim();
				if (!line.startsWith("|")) continue;
				const cells = line.split("|").map((s) => s.trim());
				const c = cells.slice(1, cells.length - 1);
				if (c.length < 3) continue;

				const bvIdx = c.findIndex((x) => /^BV[0-9A-Za-z]{10}$/.test(x));
				if (bvIdx < 0) continue;
				const bvid = c[bvIdx];
				const dayRaw = bvIdx > 0 ? c[bvIdx - 1] : c[0];
				const dm = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(dayRaw);
				if (!dm) continue;
				const day = dm[1];
				const title = c[bvIdx + 1] || "";
				const up = c[bvIdx + 2] || "";
				const status = c[c.length - 1] || "";
				const key = `${bvid}@${day}`;
				if (seen.has(key)) continue;
				seen.add(key);

				const skipped = /跳过|跳了|没挑/.test(status);
				const picked = !skipped && /挑|收|选|值得看|可以看/.test(status);
				const commented = /评论/.test(status);
				const delivered = /评论|私信|已发|发给/.test(status) || deliveredBvs.has(bvid);

				out.push({
					day,
					bvid,
					title,
					up,
					status,
					picked,
					commented,
					delivered,
					url: `https://www.bilibili.com/video/${bvid}`,
				});
			}

			out.sort((a, b) => (a.day === b.day ? (a.picked === b.picked ? 0 : a.picked ? -1 : 1) : a.day < b.day ? 1 : -1));
			return out;
		};

		const reportMeta = () => {
			const map = new Map();
			let files = [];
			try {
				files = readdirSync(outDir)
					.filter((f) => f.endsWith(".md"))
					.sort()
					.reverse();
			} catch {
				return map;
			}

			for (const f of files) {
				let text = "";
				try {
					text = readFileSync(join(outDir, f), "utf8");
				} catch {
					continue;
				}
				const blocks = text.split(/\n(?=###\s*BV)/);
				for (const b of blocks) {
					const m = b.match(/^###\s*(BV[0-9A-Za-z]+)/);
					if (!m) continue;
					const bvid = m[1];
					const tierM = b.match(/\*\*档位\*\*\s*[：:]\s*(值得看|可以看|不值当)/);
					const whyM = b.match(/\*\*为什么值得\*\*\s*[：:]\s*([\s\S]*?)(?=\n\s*\*\*|$)/);
					if (!map.has(bvid)) {
						map.set(bvid, {
							tier: tierM ? tierM[1] : "",
							why: whyM ? whyM[1].trim().replace(/\n+/g, " ") : "",
						});
					}
				}
			}
			return map;
		};

		const buildStatusPayload = async () => {
			const user = await credManager.verify();
			const state = dutyEngine.getState();
			const cfg = loadLocalCfg();
			const today = todayStr();
			dutyEngine.syncSingleNotes(today);

			const notesSet = (() => {
				try {
					return new Set(readdirSync(reportsDir).map((f) => f.split("-")[0]));
				} catch {
					return new Set();
				}
			})();

			const personaFromWs = (() => {
				if (String(cfg.personaPrompt || "").trim()) return "";
				const hostCwd = typeof host.cwd === "string" ? host.cwd : process.cwd();
				const f = join(hostCwd, "AGENTS.md");
				try {
					return existsSync(f) ? readFileSync(f, "utf8").slice(0, 4000) : "";
				} catch {
					return "";
				}
			})();

			let resolvedUid = Number(cfg.dmUid) || 0;
			if (!resolvedUid && cfg.mentionName) {
				try {
					const cache = JSON.parse(readFileSync(join(storageDir, "uid-cache.json"), "utf8")) || {};
					const name = String(cfg.mentionName).replace(/^@/, "").trim();
					if (cache[name]) resolvedUid = Number(cache[name]);
				} catch {}
			}

			const reports = dutyEngine.listReports();

			return {
				ok: true,
				home: storageDir,
				config: cfg,
				user,
				state,
				windows: DEFAULT_WINDOWS,
				today,
				ranToday: state.count || 0,
				pickedToday: state.picked || 0,
				lastRunAt: state.lastRun || null,
				loggedIn: Boolean(user?.loggedIn),
				venvReady: venvReadyNow(),
				missingDeps: missingVenvDeps(),
				dmUidResolved: resolvedUid,
				personaFromWs,
				asrReady: asrReadyNow(),
				asrModelReady: existsSync(join(storageDir, ".hf-cache")),
				asrInstalling: installingAsr,
				installing,
				asrTail: (() => {
					try {
						return readFileSync(asrLogFile, "utf8").slice(-1200);
					} catch {
						return "";
					}
				})(),
				installTail: (() => {
					try {
						return readFileSync(installLogFile, "utf8").slice(-1200);
					} catch {
						return "";
					}
				})(),
				report: dutyEngine.getReportPath(today),
				log: logFile,
				reportsCount: reports.length,
				latestReport: reports[0] || null,
				reports,
				notesCount: notesSet.size,
				intel: (() => {
					if (!intel) return null;
					try {
						return {
							store: intel.store.stats(),
							taste: intel.taste.summary(),
							delivery: intel.delivery.status(),
						};
					} catch (err) {
						return { error: String(err?.message || err) };
					}
				})(),
			};
		};

		route("GET", "/status", async (_req, res) => {
			const payload = await buildStatusPayload();
			res.json(payload);
		});

		route("GET", "/config", (_req, res) => {
			res.json({ ok: true, config: loadLocalCfg(), home: storageDir });
		});

		route("POST", "/config", (req, res) => {
			const patch = req.body || {};
			const fixedErr = checkFixedPatch(patch);
			if (fixedErr) {
				res.json({ ok: false, error: fixedErr });
				return;
			}
			const next = saveLocalCfg(patch);
			try {
				restartDmWatcher();
			} catch {}
			dutyEngine.appendLog(`配置已更新: ${JSON.stringify(patch)}`);
			res.json({ ok: true, config: next });
		});

		route("GET", "/intel", (_req, res) => {
			res.json({
				ok: Boolean(intel),
				intel: intel
					? {
							store: intel.store.stats(),
							taste: intel.taste.summary(),
							delivery: intel.delivery.status(),
							latestAsk: (() => {
								const a = intel.store.latestAsk();
								return a ? { id: a.id, intent: a.intent, at: new Date(a.ts).toISOString() } : null;
							})(),
						}
					: null,
			});
		});

		route("POST", "/intel/signal", (req, res) => {
			if (!intel) {
				res.status(503).json({ ok: false, error: "状态库不可用" });
				return;
			}
			const body = req.body || {};
			const kind = String(body.kind || "");
			if (!["pin", "like", "fav", "deep", "ignore", "ban", "ask"].includes(kind)) {
				res.status(400).json({ ok: false, error: "不支持的信号类型" });
				return;
			}
			const r = intel.taste.signal(kind, {
				topic: body.topic,
				bvid: body.bvid,
				mid: body.mid,
				reason: body.reason,
				origin: "http",
			});
			res.json({ ok: true, signal: r, summary: intel.taste.summary() });
		});

		route("POST", "/intel/ask", async (req, res) => {
			if (!intel) {
				res.status(503).json({ ok: false, error: "状态库不可用" });
				return;
			}
			const body = req.body || {};
			const r = await intel.ask.run(String(body.intent || ""), { maxEvidence: body.maxEvidence });
			res.json(r);
		});

		route("POST", "/duty/run", async (_req, res) => {
			const result = await dutyEngine.runCuration({ force: true, trigger: "http_ui" });
			res.json(result);
		});

		route("POST", "/install", (_req, res) => {
			res.json(runInstall());
		});

		route("POST", "/install-asr", (_req, res) => {
			res.json(runAsrInstall());
		});

		route("GET", "/fav-folders", async (_req, res) => {
			const r = await favOps.getFolders();
			res.json(r);
		});

		route("POST", "/fav-today", async (_req, res) => {
			const cfg = loadLocalCfg();
			const fid = Number(cfg.favFolderId) || 0;
			if (!fid) {
				res.json({ ok: false, error: "未设置目标收藏夹 fid，请先在偏好页选择" });
				return;
			}
			const today = todayStr();
			const reportPath = dutyEngine.getReportPath(today);
			if (!existsSync(reportPath)) {
				res.json({ ok: false, error: "今日尚无精选报告" });
				return;
			}
			const text = readFileSync(reportPath, "utf8").replace(/```[\s\S]*?```/g, "");
			const ids = [...new Set([...text.matchAll(/^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm)].map((m) => m[1]))];
			if (!ids.length) {
				res.json({ ok: false, error: "今日报告中没有挑中的视频" });
				return;
			}
			let added = 0;
			for (const bv of ids) {
				const r = await favOps.addVideo(bv, fid);
				if (r && r.ok) added++;
			}
			res.json({ ok: true, added, total: ids.length });
		});

		// v2.6 手动收藏兑底：偏好页没选目标收藏夹时，落到账号默认收藏夹（第一个），不影响自动收藏的显式配置语义。
		let favFallbackCache = null;
		const resolveFavFolderId = async (cfgFid) => {
			if (cfgFid > 0) return cfgFid;
			if (favFallbackCache && Date.now() - favFallbackCache.at < 10 * 60_000) return favFallbackCache.fid;
			const folders = await favOps.getFolders();
			const first = (folders && folders.ok && folders.folders?.[0]) || null;
			if (!first) return 0;
			favFallbackCache = { fid: Number(first.id) || 0, at: Date.now() };
			return favFallbackCache.fid;
		};

		route("POST", "/fav-add", async (req, res) => {
			const bvid = String(req.body?.bvid || "").trim();
			if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
				res.json({ ok: false, error: "bvid 非法" });
				return;
			}
			const cfg = loadLocalCfg();
			const fid = await resolveFavFolderId(Number(cfg.favFolderId) || 0);
			if (!fid) {
				res.json({ ok: false, error: "未登录或收藏夹列表拉不到（先扫码登录），或未设置目标收藏夹" });
				return;
			}
			const r = await favOps.addVideo(bvid, fid);
			if (r && r.ok) res.json({ ok: true, already: !!r.already });
			else res.json({ ok: false, error: (r && r.error) || "收藏失败" });
		});

		// v2.6 手动点赞（公开社交动作，仅详情弹窗显式触发；AI 巡检不自动点赞）
		route("POST", "/like-add", async (req, res) => {
			const bvid = String(req.body?.bvid || "").trim();
			if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
				res.json({ ok: false, error: "bvid 非法" });
				return;
			}
			const r = await favOps.likeVideo(bvid);
			if (r && r.ok) res.json({ ok: true, already: !!r.already });
			else res.json({ ok: false, error: (r && r.error) || "点赞失败" });
		});

		const videoStatCache = new Map();
		route("GET", "/video-stat", async (req, res) => {
			const bvid = String(req.query?.bvid || "").trim();
			if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
				res.json({ ok: false, error: "bvid 非法" });
				return;
			}
			const hit = videoStatCache.get(bvid);
			if (hit && Date.now() - hit.at < 600000) {
				res.json({ ok: true, cached: true, stat: hit.stat });
				return;
			}
			try {
				const info = await apiClient.getVideoInfo(bvid);
				if (!info) {
					res.json({ ok: false, error: "获取失败" });
					return;
				}
				const stat = {
					view: info.stat?.view ?? null,
					danmaku: info.stat?.danmaku ?? null,
					reply: info.stat?.reply ?? null,
					like: info.stat?.like ?? null,
					favorite: info.stat?.favorite ?? null,
					coin: info.stat?.coin ?? null,
					duration: info.durationStr || "",
					up: info.owner?.name || "",
				};
				videoStatCache.set(bvid, { at: Date.now(), stat });
				res.json({ ok: true, stat });
			} catch (e) {
				res.json({ ok: false, error: String(e?.message || e) });
			}
		});

		route("GET", "/watched", (req, res) => {
			dutyEngine.syncSingleNotes(todayStr());
			const all = parseSeenTable();
			const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 60));
			const offset = Math.max(0, Number(req.query?.offset) || 0);
			const meta = reportMeta();
			const notesSet = (() => {
				try {
					return new Set(readdirSync(reportsDir).map((f) => f.split("-")[0]));
				} catch {
					return new Set();
				}
			})();

			const allRows = all.map((x) => {
				const m = meta.get(x.bvid) || {};
				return {
					...x,
					tier: m.tier || "",
					why: m.why || "",
					note: notesSet.has(x.bvid),
				};
			});

			const onlyPicked = req.query?.picked === "1";
			const tier = String(req.query?.tier || "");
			const state = String(req.query?.state || "");

			let rows = onlyPicked ? allRows.filter((x) => x.picked) : allRows;
			if (tier) rows = rows.filter((x) => x.tier === tier);
			if (state === "picked") rows = rows.filter((x) => x.picked);
			if (state === "skipped") rows = rows.filter((x) => !x.picked);
			if (state === "commented") rows = rows.filter((x) => x.delivered || x.commented);
			const day = String(req.query?.day || "");
			if (/^\d{4}-\d{2}-\d{2}$/.test(day)) rows = rows.filter((x) => x.day === day);
			const from = String(req.query?.from || "");
			if (/^\d{4}-\d{2}-\d{2}$/.test(from)) rows = rows.filter((x) => x.day >= from);
			const to = String(req.query?.to || "");
			if (/^\d{4}-\d{2}-\d{2}$/.test(to)) rows = rows.filter((x) => x.day <= to);
			const days = [...new Set(allRows.map((x) => x.day))].sort().reverse();

			res.json({
				ok: true,
				total: rows.length,
				offset,
				limit,
				days,
				rows: rows.slice(offset, offset + limit),
			});
		});

		route("GET", "/cover", async (req, res) => {
			const bv = String(req.query?.bv || "");
			const cover = await apiClient.getCoverProxy(bv);
			if (!cover) {
				res.status(404).end("Cover not found");
				return;
			}
			res.setHeader("Content-Type", cover.type);
			res.setHeader("Cache-Control", "public, max-age=86400");
			res.end(cover.buf);
		});

		route("POST", "/verify", async (_req, res) => {
			const result = await verifyRecent(storageDir, { log: (m) => dutyEngine.appendLog(m) });
			if (result.ok && result.text) {
				appendVerifyToReport(storageDir, result.text);
			}
			res.json(result);
		});

		route("GET", "/related", async (req, res) => {
			const bvid = String(req.query?.bvid || "");
			const list = await apiClient.getRelatedVideos(bvid);
			res.json({ ok: true, count: list.length, list });
		});

		route("GET", "/report", (req, res) => {
			const day = String(req.query?.day || todayStr()).replace(/[^0-9-]/g, "") || todayStr();
			const content = dutyEngine.readReport(day);
			if (content === null) {
				res.json({ ok: true, day, exists: false, text: "今天还没有报告，跑一轮之后就有了。" });
				return;
			}
			res.json({ ok: true, day, exists: true, text: content });
		});

		route("GET", "/note", (req, res) => {
			const bvid = String(req.query?.bvid || "");
			const day = String(req.query?.day || todayStr()).replace(/[^0-9-]/g, "");
			const p = join(reportsDir, `${bvid}-${day}.md`);
			if (existsSync(p)) {
				res.json({ ok: true, bvid, day, text: readFileSync(p, "utf8") });
			} else {
				res.status(404).json({ ok: false, error: "Note not found" });
			}
		});

		// 详情弹窗「本账号动作台账」：点赞/收藏用只读查询，评论/私信用 deliveries 状态库。
		// 查不到的一律 null，前端按「未能查询」展示，不编造。
		route("GET", "/account-actions", async (req, res) => {
			const bvid = String(req.query?.bvid || "").trim();
			if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
				res.json({ ok: false, error: "bvid 非法" });
				return;
			}
			const out = { ok: true, like: null, fav: null, favPartial: false, comment: null, dm: null };
			try {
				const sent = store.deliveriesForVideo(bvid).filter((r) => r.state && r.state !== "drafted");
				if (sent.length) {
					const c = sent[0];
					out.comment = {
						text: c.text || "",
						state: c.state || "",
						rpid: c.rpid || 0,
						day: c.day || "",
						at: c.updated_at || c.created_at || 0,
						error: c.error || "",
					};
				}
				const dms = store.dmDigestsMentioning(bvid);
				if (dms.length) {
					const d = dms[0];
					out.dm = { day: d.day || "", state: d.state || "", at: d.updated_at || d.created_at || 0, id: d.id || "" };
				}
			} catch {}
			try {
				out.like = await apiClient.hasLike(bvid);
			} catch {}
			try {
				const fid = await resolveFavFolderId(Number(loadLocalCfg().favFolderId) || 0);
				if (fid) {
					out.favFolderId = fid;
					const r = await favOps.isInFolder(bvid, fid);
					if (r && r.ok) {
						out.fav = r.value;
						out.favPartial = Boolean(r.partial);
					}
				}
			} catch {}
			res.json(out);
		});

		route("POST", "/open", (req, res) => {
			const body = req.body || {};
			const what = String(body.what || "out");
			if (what === "url") {
				const u = String(body.u || "").trim();
				let validUrl = false;
				try {
					const parsed = new URL(u);
					if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !/[\s"&|^%<>]/.test(u)) {
						validUrl = true;
					}
				} catch {}
				if (!validUrl) {
					res.json({ ok: false, error: "只允许打开合法的 http/https 链接" });
					return;
				}
				if (process.platform === "win32") {
					spawn("explorer.exe", [u], { detached: true, stdio: "ignore" });
				} else {
					const opener = process.platform === "darwin" ? "open" : "xdg-open";
					spawn(opener, [u], { detached: true, stdio: "ignore" });
				}
				res.json({ ok: true });
				return;
			}

			const targetDir = what === "home" ? storageDir : outDir;
			if (process.platform === "win32") {
				spawn("explorer.exe", [targetDir], { detached: true, stdio: "ignore" });
			} else {
				const opener = process.platform === "darwin" ? "open" : "xdg-open";
				spawn(opener, [targetDir], { detached: true, stdio: "ignore" });
			}
			res.json({ ok: true, opened: targetDir });
		});

		route("GET", "/diagnose", async (_req, res) => {
			const payload = await buildStatusPayload();
			const tail = dutyEngine.getRecentLog(60);
			const lines = [
				"=== 刷B站 (bili-stroll) 诊断信息 ===",
				`版本：2.0.0`,
				`平台：${process.platform} ${process.arch} · node ${process.versions.node}`,
				`家目录：${storageDir}`,
				`B站登录：${payload.loggedIn ? "已登录 (UID: " + (payload.user?.mid || "-") + ")" : "未登录"}`,
				`Python环境：${payload.venvReady ? "就绪" : "未就绪"} (${payload.missingDeps.join(" / ") || "无缺失"})`,
				`转写环境：${payload.asrReady ? "就绪" : "未就绪"}`,
				`投递模式：${payload.config.dmMode || "only"} (UID: ${payload.dmUidResolved || "自动解析"})`,
				`今日进度：挑中 ${payload.pickedToday}/${payload.config.perDay || 5} 条 (巡检 ${payload.ranToday} 轮)`,
				"",
				"--- 配置清单 (脱敏) ---",
				JSON.stringify(payload.config, null, 2),
				"",
				"--- duty.log 末尾 ---",
				tail || "(暂无日志)",
			];
			res.json({ ok: true, text: lines.join("\n") });
		});

		route("GET", "/selfcheck", async (_req, res) => {
			const items = [];
			const put = (name, ok, detail, fix) => items.push({ name, ok, detail: detail || "", fix: ok ? "" : fix || "" });

			let writable = true;
			try {
				const t = join(storageDir, ".diag-write-test");
				writeFileSync(t, "x");
				rmSync(t);
			} catch {
				writable = false;
			}
			put(
				"家目录可读写",
				writable,
				writable ? storageDir : "无法写入",
				"请检查杀毒软件防护规则或权限，确保数据目录可写",
			);

			const hasCred = credManager.hasCredential();
			put("B站已登录", hasCred, hasCred ? "凭证文件存在" : "未登录", "点击高级页「扫码登录」进行扫码绑定");

			let reach = false;
			let reachDetail = "";
			try {
				const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: credManager.getHeaders() });
				reach = r.ok;
				reachDetail = `HTTP ${r.status}`;
			} catch (err) {
				reachDetail = err.message;
			}
			put("B站接口连通性", reach, reachDetail, "检查网络连接或网络代理是否畅通");

			const cfg = loadLocalCfg();
			const dmOk = true;
			put(
				"投递目标确定",
				dmOk,
				Number(cfg.dmUid) > 0 ? `速报投递至 UID ${cfg.dmUid}` : "使用当前登录账号；速报默认保存在本地，无需主人 UID",
				"可选配置速报收件人；私信查询和自动回复直接使用当前账号",
			);

			put(
				"Python 独立运行环境",
				venvReadyNow(),
				missingVenvDeps().length ? `缺依赖: ${missingVenvDeps().join(", ")}` : "就绪",
				"在高级页点击「装主依赖」自动安装",
			);

			res.json({ ok: items.every((i) => i.ok), items });
		});

		route("GET", "/update", (_req, res) => {
			res.json({
				ok: true,
				current: "2.0.0",
				latest: "2.0.0",
				hasNew: false,
			});
		});

		route("POST", "/login/start", async (_req, res) => {
			const r = await apiClient.startLogin();
			res.json({ ok: true, ...r });
		});

		route("POST", "/login/poll", async (req, res) => {
			const key = String(req.body?.key || "");
			if (!key) {
				res.status(400).json({ ok: false, error: "Missing qrcode key" });
				return;
			}
			const r = await apiClient.pollLogin(key);
			res.json({ ok: true, ...r });
		});

		route("POST", "/login/logout", async (_req, res) => {
			credManager.clear();
			res.json({ ok: true, message: "已退出登录并清除凭证" });
		});

		route("GET", "/reports", (_req, res) => {
			res.json({ ok: true, reports: dutyEngine.listReports() });
		});

		// 提示词可看可改：默认、改写、生效、固定追加四份文本一起给客户端，避免界面显示与实际发送不一致。
		route("GET", "/prompts", (_req, res) => {
			res.json({ ok: true, ...describePrompts(loadLocalCfg()) });
		});

		route("GET", "/log", (_req, res) => {
			res.json({ ok: true, log: dutyEngine.getRecentLog(100) });
		});

		route("GET", "/runs", (req, res) => {
			const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 30));
			res.json({ ok: true, runs: dutyEngine.listRuns(limit), total: dutyEngine.countRuns() });
		});

		route("GET", "/run", (req, res) => {
			const r = dutyEngine.getRun(String(req.query?.id || ""));
			if (!r) {
				res.json({ ok: false, error: "找不到该轮记录" });
				return;
			}
			res.json({ ok: true, run: r });
		});

		if (typeof host.onClientMessage === "function") {
			const offMsg = host.onClientMessage(async (msg, replyRaw) => {
				const __rid = msg && msg.__rid;
				const reply = (payload) =>
					__rid === undefined
						? replyRaw(payload)
						: replyRaw(
								payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, __rid } : payload,
							);
				const type = msg?.type;
				try {
					if (type === "bili:get-status") {
						const payload = await buildStatusPayload();
						reply(payload);
					} else if (type === "bili:save-config") {
						const patch = msg.patch || {};
						const fixedErr = checkFixedPatch(patch);
						if (fixedErr) {
							reply({ ok: false, error: fixedErr });
							return;
						}
						const next = saveLocalCfg(patch);
						try {
							restartDmWatcher();
						} catch {}
						reply({ ok: true, config: next });
					} else if (type === "bili:login-start") {
						const r = await apiClient.startLogin();
						reply({ ok: true, ...r });
					} else if (type === "bili:login-poll") {
						const r = await apiClient.pollLogin(String(msg.key || ""));
						reply({ ok: true, ...r });
					} else if (type === "bili:logout") {
						credManager.clear();
						reply({ ok: true });
					} else if (type === "bili:duty-run") {
						const r = await dutyEngine.runCuration({ force: true, trigger: "client_ui" });
						reply(r);
					} else if (type === "bili:install") {
						reply(runInstall());
					} else if (type === "bili:install-asr") {
						reply(runAsrInstall());
					} else if (type === "bili:fav-folders") {
						reply(await favOps.getFolders());
					} else if (type === "bili:watched") {
						dutyEngine.syncSingleNotes(todayStr());
						const all = parseSeenTable();
						const meta = reportMeta();
						const notesSet = (() => {
							try {
								return new Set(readdirSync(reportsDir).map((f) => f.split("-")[0]));
							} catch {
								return new Set();
							}
						})();
						const allRows = all.map((x) => {
							const m = meta.get(x.bvid) || {};
							return {
								...x,
								tier: m.tier || "",
								why: m.why || "",
								note: notesSet.has(x.bvid),
							};
						});
						reply({ ok: true, rows: allRows });
					} else if (type === "bili:verify") {
						const r = await verifyRecent(storageDir, { log: (m) => dutyEngine.appendLog(m) });
						if (r.ok && r.text) appendVerifyToReport(storageDir, r.text);
						reply(r);
					} else if (type === "bili:get-runs") {
						reply({ ok: true, runs: dutyEngine.listRuns(Number(msg.limit) || 30), total: dutyEngine.countRuns() });
					} else if (type === "bili:get-run") {
						const r = dutyEngine.getRun(String(msg.id || ""));
						reply(r ? { ok: true, run: r } : { ok: false, error: "找不到该轮记录" });
					} else if (type === "bili:get-report") {
						const content = dutyEngine.readReport(String(msg.day || todayStr()));
						reply({ ok: true, text: content });
					} else if (type === "bili:search") {
						const list = await apiClient.searchVideos(msg.keyword, {
							pageSize: msg.pageSize || 10,
							order: msg.order || "totalrank",
						});
						reply({ ok: true, list });
					} else if (type === "bili:get-subtitle") {
						const r = await apiClient.getVideoSubtitle(msg.bvid);
						reply(r);
					} else if (type === "bili:dm-sessions") {
						reply({
							ok: true,
							...(await dmService.list({ cursor: msg.cursor, size: msg.size, signal: lifetime.signal })),
						});
					} else if (type === "bili:dm-messages") {
						reply({
							ok: true,
							...(await dmService.read(msg.uid, { cursor: msg.cursor, size: msg.size, signal: lifetime.signal })),
						});
					} else if (type === "bili:dm-send") {
						reply(await dmService.send(msg.uid, msg.text, { signal: lifetime.signal }));
					} else if (type === "bili:get-log") {
						reply({ ok: true, log: dutyEngine.getRecentLog(100) });
					}
				} catch (err) {
					reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
				}
			});
			if (typeof offMsg === "function") unregisterFns.push(offMsg);
		}

		const dmService = new DmService({
			api: apiClient,
			host,
			storageDir,
			loadConfig: () => ({ dmWatch: true, dmAutoReply: true, ...loadLocalCfg() }),
			readVideoContent: (bvid, options = {}) =>
				readVideoContent({ api: apiClient, host, storageDir, bvid, settings: loadLocalCfg(), ...options }),
			onFresh: async ({ uid, fresh }) => {
				if (!intel) return false;
				try {
					const r = await intel.delivery.handleIncoming({ uid, messages: fresh });
					if (r.handled) dutyEngine.appendLog(`私信回执 ${r.action || ""}（UID ${uid}）已处理`);
					return Boolean(r.handled);
				} catch (err) {
					dutyEngine.appendLog(`回执处理失败: ${err.message}`);
					return false;
				}
			},
		});
		const lifetime = new AbortController();
		let dmTimer = null;
		const dmTick = async () => {
			try {
				await dmService.tick({ signal: lifetime.signal });
			} catch (err) {
				if (!lifetime.signal.aborted) dutyEngine.appendLog("私信监听异常: " + err.message);
			}
		};
		const startDmWatcher = () => {
			if (dmTimer) clearInterval(dmTimer);
			const cfg = loadLocalCfg();
			if (cfg.dmWatch === false) {
				dmTimer = null;
				return;
			}
			const mins = Math.max(1, Number(cfg.dmWatchMinutes) || 1);
			dmTimer = setInterval(() => void dmTick(), mins * 60000);
			dmTimer.unref?.();
		};
		startDmWatcher();
		restartDmWatcher = () => {
			try {
				startDmWatcher();
			} catch {}
		};
		void dmTick();

		const tickSchedule = () => {
			const cfg = loadLocalCfg();
			if (!cfg.peakValley) return;
			const now = new Date();
			const today = todayStr(now);
			const quota = Number(cfg.perDay) || 5;
			if (dutyEngine.countPickedToday(today) >= quota) return;

			for (const [key, w] of Object.entries(DEFAULT_WINDOWS)) {
				if (cfg[key] === false) continue;
				if (inWindow(now, w)) {
					const state = dutyEngine.getState();
					const windowTag = `${today}:${key}`;
					if (state.lastWhy === windowTag) continue;
					dutyEngine.saveState({ ...state, lastWhy: windowTag });
					dutyEngine.runCuration({ force: false, trigger: `window_${key}` }).catch(() => {});
					break;
				}
			}
		};

		const schedTimer = setInterval(tickSchedule, 60000);
		if (typeof schedTimer?.unref === "function") schedTimer.unref();
		try {
			tickSchedule();
		} catch {}

		const registerTool = (spec) => {
			const originalExec = spec.execute;
			const adaptedSpec = {
				...spec,
				execute: async (toolCallIdOrArgs, paramsMaybe, signal, onUpdate) => {
					const args =
						paramsMaybe && typeof paramsMaybe === "object" && !Array.isArray(paramsMaybe)
							? paramsMaybe
							: toolCallIdOrArgs && typeof toolCallIdOrArgs === "object" && !Array.isArray(toolCallIdOrArgs)
								? toolCallIdOrArgs
								: {};
					return await originalExec.call(spec, args, toolCallIdOrArgs, signal, onUpdate);
				},
			};
			if (typeof host.registerAgentTool === "function") {
				const off = host.registerAgentTool(adaptedSpec);
				if (typeof off === "function") unregisterFns.push(off);
			} else if (typeof host.registerTool === "function") {
				const off = host.registerTool(adaptedSpec);
				if (typeof off === "function") unregisterFns.push(off);
			}
		};

		registerTool({
			name: "stroll_whoami",
			label: "B站身份状态",
			description: "Inspect current Bilibili login state, username, mid, and credential validity.",
			promptSnippet: "checking Bilibili login credentials and current user info",
			promptGuidelines: [
				"Call this tool to verify whether the user has logged into Bilibili before performing account-required actions.",
			],
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const user = await credManager.verify();
				return { ok: true, user };
			},
		});

		registerTool({
			name: "stroll_login_start",
			label: "B站登录扫码出码",
			description: "Generate a Bilibili QR code url and session key for mobile app login.",
			promptSnippet: "starting Bilibili QR code login process",
			promptGuidelines: [
				"Display or return the generated QR code URL and key to the user, then call bili_login_poll to wait for completion.",
			],
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const r = await apiClient.startLogin();
				return {
					ok: true,
					key: r.key,
					url: r.url,
					hint: "Please scan the QR code with Bilibili mobile app and confirm login.",
				};
			},
		});

		registerTool({
			name: "stroll_login_poll",
			label: "B站扫码结果轮询",
			description: "Poll QR code login state and automatically save credentials upon success.",
			promptSnippet: "checking status of pending Bilibili QR code login",
			promptGuidelines: ["Provide the key obtained from bili_login_start. Returns waiting, scanned, ok, or expired."],
			parameters: {
				type: "object",
				properties: {
					key: { type: "string", description: "QR code session key from bili_login_start" },
				},
				required: ["key"],
			},
			async execute(args) {
				const r = await apiClient.pollLogin(String(args.key || ""));
				return { ok: true, ...r };
			},
		});

		registerTool({
			name: "stroll_search",
			label: "搜索B站视频",
			description: "Search Bilibili videos with keyword, sorting order, and pagination.",
			promptSnippet: "searching Bilibili videos by keyword and sorting order",
			promptGuidelines: [
				"Use order totalrank for relevance, click for views, pubdate for newest, or dm for danmaku count.",
				"After searching, inspect subtitles with bili_subtitle for deep content evaluation.",
			],
			parameters: {
				type: "object",
				properties: {
					keyword: { type: "string", description: "Search query text" },
					num: { type: "number", description: "Search results limit (default 10, max 30)" },
					order: {
						type: "string",
						enum: ["totalrank", "click", "pubdate", "dm"],
						description: "Sorting rule",
					},
				},
				required: ["keyword"],
			},
			async execute(args) {
				const list = await apiClient.searchVideos(args.keyword, {
					pageSize: args.num || 10,
					order: args.order || "totalrank",
				});
				return { ok: true, count: list.length, list };
			},
		});

		registerTool({
			name: "stroll_video_info",
			label: "B站视频详情",
			description: "Fetch comprehensive metadata, stats, UP owner info, and parts of a Bilibili video.",
			promptSnippet: "querying metadata, statistics, and parts of a specific video",
			promptGuidelines: ["Provide the bvid string (e.g. BV1xx411c7mD)."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Bilibili video BV identifier" },
				},
				required: ["bvid"],
			},
			async execute(args) {
				const info = await apiClient.getVideoInfo(String(args.bvid || ""));
				return { ok: true, video: info };
			},
		});

		registerTool({
			name: "stroll_subtitle",
			label: "获取B站视频字幕全文",
			description: "Extract subtitle transcripts or AI summary for deep content verification.",
			promptSnippet: "extracting speech-to-text subtitles or AI summary of a video",
			promptGuidelines: ["Always read subtitle transcripts to judge video substance and avoid clickbait fluff."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Bilibili video BV identifier" },
				},
				required: ["bvid"],
			},
			async execute(args) {
				return await apiClient.getVideoSubtitle(String(args.bvid || ""));
			},
		});

		registerTool({
			name: "stroll_hot_videos",
			label: "B站热门综合视频",
			description: "Fetch current trending and popular videos on Bilibili.",
			promptSnippet: "fetching trending and popular videos from Bilibili front page",
			promptGuidelines: ["Use to discover what is currently trending across Bilibili."],
			parameters: {
				type: "object",
				properties: {
					num: { type: "number", description: "Trending batch size (default 15, max 30)" },
				},
			},
			async execute(args) {
				const list = await apiClient.getPopularVideos({ ps: args?.num || 15 });
				return { ok: true, count: list.length, list };
			},
		});

		registerTool({
			name: "stroll_rank",
			label: "B站分区排行榜",
			description: "Retrieve Bilibili leaderboard rankings across categories.",
			promptSnippet: "inspecting leaderboard rankings of specific Bilibili categories",
			promptGuidelines: ["Category rid 0 represents all-station overall leaderboard."],
			parameters: {
				type: "object",
				properties: {
					rid: { type: "number", description: "Category partition ID (0 for all-station)" },
					type: { type: "string", description: "Ranking type (default all)" },
				},
			},
			async execute(args) {
				const list = await apiClient.getRankVideos({ rid: args?.rid || 0, type: args?.type || "all" });
				return { ok: true, count: list.length, list };
			},
		});

		registerTool({
			name: "stroll_comments",
			label: "获取视频评论",
			description: "Retrieve top or newest comments and discussions of a video.",
			promptSnippet: "reading audience discussions and top comments of a video",
			promptGuidelines: ["Use to analyze user reactions, sentiment, and additional context provided by viewers."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Bilibili video BV identifier" },
					num: { type: "number", description: "Number of comments to return (default 20)" },
				},
				required: ["bvid"],
			},
			async execute(args) {
				const comments = await apiClient.getVideoComments(String(args.bvid || ""), {
					pageSize: args.num || 20,
				});
				return { ok: true, count: comments.length, comments };
			},
		});

		registerTool({
			name: "stroll_reply",
			label: "发布B站评论",
			description: "Post a comment or reply to a video under strict safety gate control.",
			promptSnippet: "posting a public comment or reply under a video",
			promptGuidelines: ["Requires autoComment enabled in settings or explicit user confirmation with force true."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Target video BV identifier" },
					text: { type: "string", description: "Comment text content" },
					rpid: { type: "number", description: "Target comment ID if replying to someone (default 0)" },
					force: { type: "boolean", description: "Set true when explicitly instructed by user" },
				},
				required: ["bvid", "text"],
			},
			async execute(args) {
				const s = loadLocalCfg();
				const isAllowed = Boolean(s.autoComment && s.dmMode !== "only") || Boolean(args.force);
				if (!isAllowed) {
					return {
						ok: false,
						blocked: true,
						hint: "Auto-reply is disabled or dmMode is 'only'. Pass force: true if explicitly requested.",
					};
				}
				const r = await apiClient.replyVideo(args.bvid, args.text, { rpid: args.rpid || 0 });
				if (r.rpid) {
					dutyEngine.markCommentRecord(args.bvid, r.rpid, args.rpid || 0, args.text);
				}
				return r;
			},
		});

		registerTool({
			name: "stroll_send_message",
			label: "发送B站私信",
			description: "Send a direct private message to a specific Bilibili user UID under 500 chars.",
			promptSnippet: "sending a direct private message to a user",
			promptGuidelines: ["Keep message length under 500 characters to prevent API rejection error 21007."],
			parameters: {
				type: "object",
				properties: {
					receiver_uid: { type: "number", description: "Target recipient UID" },
					text: { type: "string", description: "Message text under 500 characters" },
				},
				required: ["receiver_uid", "text"],
			},
			async execute(args, _id, signal) {
				return await dmService.send(args.receiver_uid, args.text, {
					signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
				});
			},
		});

		registerTool({
			name: "stroll_status",
			label: "B站巡检速报状态",
			description: "Inspect daily curation status, picked videos count, and report file path.",
			promptSnippet: "checking today's curation quota, rounds, and digest report path",
			promptGuidelines: ["Use to verify how many videos have been curated today and read report path."],
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const st = dutyEngine.getState();
				const s = loadLocalCfg();
				return {
					ok: true,
					today: st.day,
					rounds: st.count,
					picked: st.picked,
					quota: s.perDay || 5,
					reportPath: dutyEngine.getReportPath(),
					intel: (() => {
						if (!intel) return null;
						try {
							return {
								store: intel.store.stats(),
								taste: intel.taste.summary({ top: 5 }),
								delivery: intel.delivery.status(),
							};
						} catch (err) {
							return { error: String(err?.message || err) };
						}
					})(),
				};
			},
		});

		registerTool({
			name: "stroll_duty_run",
			label: "立即刷一轮B站",
			description: "Trigger an automated curation round to scan videos, read subtitles, and build a digest.",
			promptSnippet: "running a curation round to discover videos and generate daily report",
			promptGuidelines: ["Use when the user asks to scan Bilibili right now or generate a fresh digest report."],
			parameters: {
				type: "object",
				properties: {
					force: { type: "boolean", description: "Force scan even if daily quota is reached" },
				},
			},
			async execute(args) {
				return await dutyEngine.runCuration({ force: Boolean(args?.force), trigger: "agent_tool" });
			},
		});

		registerTool({
			name: "stroll_resolve_uid",
			label: "查询B站用户UID",
			description: "Lookup a user's Bilibili UID by username with automatic caching.",
			promptSnippet: "resolving a Bilibili user's UID from their nickname",
			promptGuidelines: ["Use when you have a username and need their numeric UID for direct messaging."],
			parameters: {
				type: "object",
				properties: {
					username: { type: "string", description: "Bilibili nickname or username" },
				},
				required: ["username"],
			},
			async execute(args) {
				const uid = await resolveUid(storageDir, args.username);
				return { ok: uid > 0, uid, username: args.username };
			},
		});

		registerTool({
			name: "stroll_fav_folders",
			label: "获取B站收藏夹列表",
			description: "List all video favorite folders created by the logged-in user.",
			promptSnippet: "querying favorite folders of the logged-in account",
			promptGuidelines: ["Call before adding videos to favorites to identify valid folder IDs."],
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				return await favOps.getFolders();
			},
		});

		registerTool({
			name: "stroll_fav_add",
			label: "添加到B站收藏夹",
			description: "Add a video to a specific user favorite folder by fid.",
			promptSnippet: "saving a video into a specific favorite folder",
			promptGuidelines: ["Provide the bvid string and target folder fid."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Bilibili video BV identifier" },
					fid: { type: "number", description: "Target favorite folder ID" },
				},
				required: ["bvid", "fid"],
			},
			async execute(args) {
				return await favOps.addVideo(args.bvid, args.fid);
			},
		});

		registerTool({
			name: "stroll_related",
			label: "获取B站相关推荐视频",
			description: "Fetch algorithmically related and recommended videos for autonomous browsing.",
			promptSnippet: "fetching related recommended videos to roam through Bilibili",
			promptGuidelines: ["Use to discover downstream relevant videos when a quality video is found."],
			parameters: {
				type: "object",
				properties: {
					bvid: { type: "string", description: "Bilibili video BV identifier" },
				},
				required: ["bvid"],
			},
			async execute(args) {
				const list = await apiClient.getRelatedVideos(args.bvid);
				return { ok: true, count: list.length, list };
			},
		});

		registerTool({
			name: "stroll_up_videos",
			label: "获取UP主近期投稿",
			description: "Retrieve recently uploaded videos by a specific UP creator.",
			promptSnippet: "querying recent video uploads of a specific creator",
			promptGuidelines: ["Use to explore other technical videos from a trusted high quality creator."],
			parameters: {
				type: "object",
				properties: {
					mid: { type: "number", description: "Bilibili creator numeric mid" },
					num: { type: "number", description: "Number of videos to fetch (default 10)" },
				},
				required: ["mid"],
			},
			async execute(args) {
				const list = await apiClient.getUpVideos(args.mid, args.num || 10);
				return { ok: true, count: list.length, list };
			},
		});

		host.log?.("info", `[bili-stroll] 插件激活成功，存储目录: ${storageDir}`);

		registerTool({
			name: "stroll_video_content",
			label: "B站视频内容",
			description:
				"Read actual video evidence from subtitles, audio transcription and sampled frames. Reports sources and coverage limits.",
			promptSnippet: "understanding the spoken and visual content of a Bilibili video",
			promptGuidelines: [
				"Use evidence coverage when describing a video; never claim full viewing from a description or summary.",
			],
			parameters: { type: "object", properties: { bvid: { type: "string" } }, required: ["bvid"] },
			async execute(args, _id, signal) {
				return await readVideoContent({
					api: apiClient,
					host,
					storageDir,
					bvid: args.bvid,
					settings: loadLocalCfg(),
					signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
				});
			},
		});
		registerTool({
			name: "stroll_dm_sessions",
			label: "B站私信列表",
			description: "List the logged-in account's private-message conversations with unread counts and pagination.",
			promptSnippet: "checking the current Bilibili account inbox",
			parameters: { type: "object", properties: { cursor: { type: "string" }, size: { type: "number" } } },
			async execute(args, _id, signal) {
				return {
					ok: true,
					...(await dmService.list({
						...args,
						signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
					})),
				};
			},
		});
		registerTool({
			name: "stroll_dm_messages",
			label: "B站私信历史",
			description: "Read a conversation from the logged-in Bilibili account, including older messages using a cursor.",
			promptSnippet: "reading Bilibili private-message history",
			parameters: {
				type: "object",
				properties: { uid: { type: "number" }, cursor: { type: "string" }, size: { type: "number" } },
				required: ["uid"],
			},
			async execute(args, _id, signal) {
				return {
					ok: true,
					...(await dmService.read(args.uid, {
						...args,
						signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
					})),
				};
			},
		});

		registerTool({
			name: "stroll_ask",
			label: "按目标找片（意图检索）",
			description:
				"Turn a natural-language goal into an evidence-backed Bilibili shortlist: compile a retrieval plan, search multiple sources, rank with the interest ledger, fetch real subtitle evidence with timestamps, and abstain when nothing is good enough.",
			promptSnippet: "finding videos that match the user's goal, with real evidence and timestamps",
			promptGuidelines: [
				"Prefer this over keyword search when the user states a goal, a constraint (duration, recency) or asks what is worth watching.",
				"Each item carries evidence.source/chars/limitations; never claim a video was fully watched.",
				"Cite the returned quotes with their timestamps and links; when abstained=true, say so instead of padding the list.",
			],
			parameters: {
				type: "object",
				properties: {
					intent: {
						type: "string",
						description:
							"Natural-language goal, e.g. plugin tutorials you can start within 10 minutes, skip pure theory",
					},
					maxEvidence: { type: "number", description: "How many videos to fetch real evidence for (1-8)" },
				},
				required: ["intent"],
			},
			async execute(args, _id, signal) {
				if (!intel) return { ok: false, error: "状态库不可用，插件已降级为旧管线" };
				const sig = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				return await intel.ask.run(String(args.intent || ""), { maxEvidence: args.maxEvidence, signal: sig });
			},
		});

		registerTool({
			name: "stroll_deepen",
			label: "深读一条（章节 + 引用）",
			description:
				"Expand one video from the last shortlist (or a given bvid) into 2-minute chapters and timestamped quotes taken from the indexed subtitle text.",
			promptSnippet: "expanding a chosen video into timestamped chapters and quotes",
			promptGuidelines: [
				"Use after bili_ask when the user wants detail on one item; pass index (1-based) instead of re-searching.",
				"Quotes are verbatim subtitle/ASR segments; if untimed=true, say the transcript has no timestamps.",
			],
			parameters: {
				type: "object",
				properties: {
					askId: { type: "string", description: "Ask id returned by bili_ask (defaults to the latest ask)" },
					index: { type: "number", description: "1-based position in that shortlist" },
					bvid: { type: "string", description: "Direct video id instead of a shortlist position" },
				},
			},
			async execute(args, _id, signal) {
				if (!intel) return { ok: false, error: "状态库不可用" };
				const sig = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				return await intel.ask.deepen({ askId: args.askId, index: args.index, bvid: args.bvid, signal: sig });
			},
		});

		registerTool({
			name: "stroll_taste",
			label: "兴趣账本",
			description:
				"Read or update the interest ledger: weighted topics and creators built from explicit signals, with decay and reasons. Negative signals (ban/ignore) down-rank matching candidates.",
			promptSnippet: "reading or updating the user's Bilibili interest ledger",
			promptGuidelines: [
				"Call with action=list before explaining recommendations, then cite the concrete weights it returns.",
				"pin/ban/ignore require a topic (or a bvid whose pick topic is known); always pass a short reason.",
			],
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "pin", "like", "ban", "ignore"] },
					topic: { type: "string", description: "Topic keyword, e.g. 大模型 / DSH / 剪辑" },
					bvid: { type: "string", description: "Optional video the signal refers to" },
					mid: { type: "number", description: "Optional creator mid" },
					reason: { type: "string", description: "Short reason stored with the signal" },
				},
				required: ["action"],
			},
			async execute(args) {
				if (!intel) return { ok: false, error: "状态库不可用" };
				const action = String(args.action || "list");
				if (action === "list") {
					return {
						ok: true,
						summary: intel.taste.summary({ top: 10 }),
						recent: intel.store.recentSignals({ sinceMs: 14 * 86_400_000, limit: 15 }).map((s) => ({
							kind: s.kind,
							topic: s.topic,
							bvid: s.bvid,
							weight: s.weight,
							reason: s.reason,
							at: new Date(s.ts).toISOString().slice(0, 10),
						})),
					};
				}
				const kind = action === "pin" ? "pin" : action === "like" ? "like" : action === "ban" ? "ban" : "ignore";
				let topic = String(args.topic || "");
				const bvid = /^BV[0-9A-Za-z]{10}$/.test(String(args.bvid || "")) ? args.bvid : "";
				if (!topic && bvid) {
					const pick = intel.store
						.picksSince(Date.now() - 30 * 86_400_000, { limit: 300 })
						.find((p) => p.bvid === bvid);
					topic = pick?.topic || "";
				}
				if (!topic && !args.mid) return { ok: false, error: "需要 topic（或能给到已知 topic 的 bvid / mid）" };
				const r = intel.taste.signal(kind, { topic, bvid, mid: args.mid, reason: args.reason, origin: "chat" });
				return { ok: true, signal: r, summary: intel.taste.summary() };
			},
		});

		registerTool({
			name: "stroll_index",
			label: "内容索引",
			description:
				"Local content index of subtitle/ASR segments with timestamps: build it for a video, search it for exact moments, build a topic timeline, or cluster near-duplicate videos.",
			promptSnippet: "searching indexed subtitle segments for exact moments and quotes",
			promptGuidelines: [
				"Use action=search to find where a topic is actually discussed, then quote the returned at/url.",
				"Only subtitle tracks and ASR count as evidence; ai_conclusion/description entries are excluded from search results.",
			],
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["search", "ingest", "timeline", "clusters", "stats"] },
					query: { type: "string" },
					bvid: { type: "string" },
					bvids: { type: "array", items: { type: "string" } },
					days: { type: "number" },
					limit: { type: "number" },
				},
				required: ["action"],
			},
			async execute(args, _id, signal) {
				if (!intel) return { ok: false, error: "状态库不可用" };
				const action = String(args.action || "stats");
				const sig = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				if (action === "search") {
					const hits = intel.index.search(String(args.query || ""), {
						limit: args.limit || 8,
						bvid: args.bvid || null,
					});
					return { ok: true, count: hits.length, hits };
				}
				if (action === "ingest") {
					if (!args.bvid) return { ok: false, error: "需要 bvid" };
					const r = await intel.index.ingest(args.bvid, { signal: sig, force: true });
					return { ok: r.ok, ...r, text: undefined };
				}
				if (action === "timeline") {
					return {
						ok: true,
						days: args.days || 30,
						items: intel.index.timeline(String(args.query || ""), { days: args.days || 30, limit: args.limit || 20 }),
					};
				}
				if (action === "clusters") {
					const list = (args.bvids || []).map((bvid) => {
						const meta = intel.store.getVideo(bvid) || { bvid };
						return { ...meta, bvid, score: 0 };
					});
					const groups = intel.index.cluster(list);
					return {
						ok: true,
						groups: groups.map((g) => ({
							representative: { bvid: g.representative.bvid, title: g.representative.title },
							others: g.others.map((o) => ({ bvid: o.bvid, title: o.title, similarity: o._sim })),
						})),
					};
				}
				return { ok: true, stats: intel.store.stats() };
			},
		});

		registerTool({
			name: "stroll_delivery",
			label: "投递状态与回执",
			description:
				"Inspect the outbound delivery state machine (drafted/sent/acted), the daily DM budget, why a video was recommended, or send one tracked message within budget.",
			promptSnippet: "checking delivery states, daily DM budget and recommendation reasons",
			promptGuidelines: [
				"Use action=explain before defending a recommendation; it only replays reasons stored at pick time.",
				"Sending is budgeted per day and idempotent; do not retry a failed send with a new message id.",
			],
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["status", "explain", "send"] },
					bvid: { type: "string" },
					uid: { type: "number" },
					text: { type: "string" },
				},
				required: ["action"],
			},
			async execute(args) {
				if (!intel) return { ok: false, error: "状态库不可用" };
				const action = String(args.action || "status");
				if (action === "explain") return { ok: true, reasons: intel.delivery.explain({ bvid: args.bvid }) };
				if (action === "send") {
					const uid = Number(args.uid) || 0;
					if (!uid) return { ok: false, error: "需要 uid" };
					const b = intel.delivery.budget();
					if (!b.allowed) return { ok: false, error: "今日私信额度已用尽", budget: b };
					const id = `dm:manual:${Date.now().toString(36)}`;
					intel.store.createDelivery({ id, kind: "dm_manual", uid, text: String(args.text || "") });
					try {
						await apiClient.sendMessage(uid, String(args.text || "").slice(0, 500));
						intel.store.updateDelivery(id, { state: "sent" });
						return { ok: true, id, budget: intel.delivery.budget() };
					} catch (err) {
						intel.store.updateDelivery(id, { state: "failed", error: err.message, attempts: 1 });
						return { ok: false, error: err.message };
					}
				}
				return { ok: true, ...intel.delivery.status() };
			},
		});

		return () => {
			lifetime.abort();
			dmService.dispose();
			dutyEngine.dispose();
			try {
				intel?.store?.close();
			} catch {}
			if (dmTimer) clearInterval(dmTimer);
			if (schedTimer) clearInterval(schedTimer);
			for (const unreg of unregisterFns) {
				try {
					unreg();
				} catch {}
			}
			host.log?.("info", "[bili-stroll] 插件已卸载");
		};
	},
};
