import { execFile, spawn } from "node:child_process";
import { runMac } from "./mac-backend.mjs";
import { finitePoint, screenshotPoint, matchOcr, parseShortcut, scrollInput, tapKeys } from "./actions.mjs";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PS_DIR = join(PLUGIN_DIR, "ps");
const UIA_PS1 = join(PS_DIR, "uia.ps1");
const INPUT_PS1 = join(PS_DIR, "input.ps1");
const SHOT_PS1 = join(PS_DIR, "screenshot.ps1");

const DEPS = ["@nut-tree-fork/nut-js@^4.2.6"];
const INSTALL_LOCK = ".pi-deps-lock";
const LOCK_STALE_MS = 15 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const UIA_TIMEOUT_MS = 45_000;
const INPUT_TIMEOUT_MS = 20_000;
const DUMP_TTL_MS = 90_000;
const LIST_TEXT_CAP = 150;

function decode(buf) {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("gbk").decode(bytes);
		} catch {
			return bytes.toString("latin1");
		}
	}
}

function runPs(script, args = [], { timeout = UIA_TIMEOUT_MS, signal } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
			{ encoding: "buffer", timeout, windowsHide: true, signal },
			(err, stdout, stderr) => {
				if (err) {
					const tail = decode(stderr).trim().slice(-500);
					reject(
						new Error(`powershell ${script.split(/[\\/]/).pop()} 失败：${err.message}${tail ? `（${tail}）` : ""}`),
					);
					return;
				}
				const text = decode(stdout);
				const start = text.indexOf("{");
				if (start < 0) {
					reject(new Error(`powershell 无 JSON 输出：${text.slice(0, 300)}`));
					return;
				}
				try {
					resolve(JSON.parse(text.slice(start)));
				} catch (e) {
					reject(new Error(`powershell 输出不是合法 JSON：${e.message}`));
				}
			},
		);
	});
}

function psArgs(obj) {
	const out = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === "") continue;
		out.push(`-${k}`, String(v));
	}
	return out;
}

function buildNutKeyMap(Key) {
	const names = Object.keys(Key ?? {});
	const find = (...cands) => {
		for (const c of cands) {
			const hit = names.find((n) => n.toLowerCase() === c);
			if (hit) return Key[hit];
		}
		return undefined;
	};
	return {
		enter: find("enter", "return"),
		tab: find("tab"),
		esc: find("escape", "esc"),
		space: find("space"),
		backspace: find("backspace"),
		delete: find("delete"),
		up: find("up", "arrowup"),
		down: find("down", "arrowdown"),
		left: find("left", "arrowleft"),
		right: find("right", "arrowright"),
		home: find("home"),
		end: find("end"),
		pgup: find("pageup", "pgup"),
		pgdn: find("pagedown", "pgdn"),
		insert: find("insert"),
		ctrl: find("leftcontrol", "control", "ctrl", "leftctrl"),
		alt: find("leftalt", "alt"),
		shift: find("leftshift", "shift"),
		win: find("leftwin", "leftsuper", "leftmeta", "win", "super", "meta", "command"),
		f: (n) => find(`f${n}`),
		letter: (ch) => find(ch.toLowerCase(), ch.toUpperCase()),
		digit: (ch) => find(ch),
	};
}

export default {
	activate(host) {
		const st = {
			dead: false,
			nut: null,
			depsOk: false,
			depsInstalling: false,
			depsFailed: "",
			probeError: "",
			lastProbeAt: 0,
			installer: null,
			dumps: new Map(),
			shotSeq: 0,
			shots: new Map(),
			dumpSeq: 0,
			offs: [],
		};
		const isWin = process.platform === "win32";
		const isMac = process.platform === "darwin";

		const requireWin = () => {
			if (!isWin && !isMac) throw new Error("desktop-use supports Windows and macOS only.");
		};
		const runDesktop = (script, fields, options = {}) =>
			isMac
				? runMac(script === UIA_PS1 ? "elements" : script === SHOT_PS1 ? "screenshot" : fields.Op, fields, options)
				: runPs(script, psArgs(fields), options);

		const req = createRequire(join(PLUGIN_DIR, "index.mjs"));

		async function probeNut() {
			st.lastProbeAt = Date.now();
			try {
				const mod = await import("@nut-tree-fork/nut-js");
				if (!mod?.mouse || !mod?.keyboard) {
					st.probeError = "模块缺 mouse/keyboard 导出";
					st.nut = null;
					return false;
				}
				st.nut = {
					mouse: mod.mouse,
					keyboard: mod.keyboard,
					Button: mod.Button,
					Point: mod.Point,
					keyMap: buildNutKeyMap(mod.Key),
				};
				return true;
			} catch (e) {
				st.probeError = String(e?.message ?? e).slice(0, 300);
				st.nut = null;
				return false;
			}
		}

		function installLocked() {
			try {
				const meta = JSON.parse(readFileSync(join(host.dir, INSTALL_LOCK), "utf8")) ?? {};
				const at = Number(meta.at ?? 0);
				if (!Number.isFinite(at) || Date.now() - at >= LOCK_STALE_MS) return false;
				const pid = Number(meta.pid ?? 0);
				if (Number.isFinite(pid) && pid > 0) {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						try {
							rmSync(join(host.dir, INSTALL_LOCK), { force: true });
						} catch {}
						host.log("info", "desktop-use: 回收 stale 安装锁（持有进程已死）");
						return false;
					}
				}
				return true;
			} catch {
				return false;
			}
		}

		function resolveNpmCli() {
			try {
				return req.resolve("npm/bin/npm-cli.js");
			} catch {}
			try {
				const cands = [
					join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
					join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
				];
				for (const c of cands) if (existsSync(c)) return c;
			} catch {}
			return null;
		}

		function ensureDeps(auto = true) {
			if (!isWin || st.depsOk || st.depsInstalling || st.installer) return;
			if (installLocked()) {
				host.log("info", "desktop-use: 另有安装任务持有锁，跳过本次自安装");
				return;
			}
			st.depsInstalling = true;
			host.log("info", `desktop-use: 安装输入依赖 ${DEPS.join(" ")}${auto ? "（自动）" : ""}`);
			host.notify("info", "🖱️ 桌面控制：正在安装输入依赖（首次约需 1～3 分钟）…");
			try {
				writeFileSync(join(host.dir, INSTALL_LOCK), JSON.stringify({ at: Date.now(), pid: process.pid }));
			} catch {}
			const finish = async (ok, why) => {
				try {
					rmSync(join(host.dir, INSTALL_LOCK), { force: true });
				} catch {}
				if (st.dead) return;
				if (ok) {
					st.depsOk = await probeNut();
					for (const wait of [3000, 8000]) {
						if (st.depsOk || st.dead) break;
						await new Promise((r) => setTimeout(r, wait));
						if (!st.dead) st.depsOk = await probeNut();
					}
					if (!st.depsOk) {
						ok = false;
						why = `npm 安装成功，但加载验证失败（${st.probeError || "未知原因"}）`;
					}
				}
				st.depsInstalling = false;
				st.installer = null;
				host.notify(
					ok ? "success" : "error",
					ok
						? "🖱️ 桌面控制输入依赖安装完成（nut-js 主用 + PowerShell 兜底）"
						: `🖱️ 桌面控制输入依赖安装失败（${why}）——已自动降级为 PowerShell 兜底输入；也可手动在插件目录执行：npm install ${DEPS.join(" ")}`,
				);
				if (!ok) st.depsFailed = String(why || "unknown");
			};
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", ...DEPS, "--omit=dev", "--no-audit", "--no-fund"];
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
				: spawn("npm", args, { stdio: ["ignore", "ignore", "pipe"], shell: true });
			st.installer = child;
			const timer = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
				}, 5000).unref?.();
				finish(false, "安装超时");
			}, INSTALL_TIMEOUT_MS);
			timer.unref?.();
			let errTail = "";
			child.stderr?.on("data", (d) => {
				errTail = (errTail + d.toString()).slice(-800);
			});
			let done = false;
			const once = (ok, why) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				const lastErr = errTail.split(/\r?\n/).filter(Boolean).pop() ?? "";
				finish(ok, why + (lastErr ? `：${lastErr}` : ""));
			};
			child.on("error", (err) => once(false, err.message));
			child.on("exit", (code, signal) => once(code === 0, signal ? `npm 被终止（${signal}）` : `npm exit ${code}`));
		}

		const needWinPs = () => {
			requireWin();
			if (isWin && (!existsSync(UIA_PS1) || !existsSync(INPUT_PS1))) {
				throw new Error("桌面控制的 PowerShell 脚本缺失（ps/*.ps1），请重装插件。");
			}
		};

		function nutReadyOrThrow() {
			if (isMac) return false;
			if (st.nut) return true;
			if (st.depsInstalling) {
				throw new Error("输入依赖正在安装（约 1～3 分钟），稍后重试；只读的元素查询（desktop_elements）不受影响。");
			}
			if (!st.depsOk && Date.now() - st.lastProbeAt > 60_000) {
				probeNut().then((ok2) => {
					if (ok2 && !st.dead) {
						st.depsOk = true;
						st.depsFailed = "";
						host.log("info", "desktop-use: 后台重探成功，nut-js 已就绪");
						host.notify("success", "🖱️ 桌面控制输入依赖已就绪（后台重探成功）");
					}
				});
			}
			return false;
		}

		async function psInput(op, fields = {}, signal) {
			needWinPs();
			const r = await runDesktop(
				INPUT_PS1,
				{ Op: op, ...fields },
				{
					timeout: INPUT_TIMEOUT_MS,
					signal,
				},
			);
			if (!r?.ok) throw new Error(`输入兜底失败：${r?.error ?? "unknown"}`);
			return r;
		}

		async function doClick(x, y, { button = "left", double = false } = {}, signal) {
			signal?.throwIfAborted();
			if (nutReadyOrThrow() && st.nut) {
				const { mouse, Button, Point } = st.nut;
				try {
					if (Point) await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
					else if (mouse.move) await mouse.move({ x, y });
					const b =
						String(button) === "right" ? Button?.RIGHT : String(button) === "middle" ? Button?.MIDDLE : Button?.LEFT;
					if (double && typeof mouse.doubleClick === "function") {
						await mouse.doubleClick(b);
					} else if (typeof mouse.click === "function") {
						await mouse.click(b);
						if (double) await mouse.click(b);
					} else if (String(button) === "right" && typeof mouse.rightClick === "function") {
						await mouse.rightClick();
						if (double) await mouse.rightClick();
					} else if (typeof mouse.leftClick === "function") {
						await mouse.leftClick();
						if (double) await mouse.leftClick();
					} else {
						throw new Error("nut mouse 无可用点击方法");
					}
					return { backend: "nut", x: Math.round(x), y: Math.round(y), button, double };
				} catch (e) {
					host.log("warn", `desktop-use: nut 点击失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			await psInput("click", { X: Math.round(x), Y: Math.round(y), Button: button, Double: double ? 1 : 0 }, signal);
			return { backend: isMac ? "macos-native" : "powershell", x: Math.round(x), y: Math.round(y), button, double };
		}

		function parseKeys(input) {
			return parseShortcut(Array.isArray(input) ? input.join("+") : input);
		}

		async function doKey(parts, signal) {
			if (nutReadyOrThrow() && st.nut) {
				const { keyboard, keyMap } = st.nut;
				let injected = false;
				try {
					if (typeof keyboard.releaseKey !== "function") throw new Error("nut 无 releaseKey 方法");
					const mods = [];
					let main = null;
					for (const p of parts) {
						if (["ctrl", "alt", "shift", "win"].includes(p)) {
							const k = keyMap[p];
							if (k === undefined) throw new Error(`nut 无 ${p} 键`);
							mods.push(k);
						} else main = p;
					}
					const toKey = (p) => {
						if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) return keyMap.f(Number(p.slice(1)));
						if (p.length === 1) return /^[a-z]$/.test(p) ? keyMap.letter(p) : keyMap.digit(p);
						return keyMap[p];
					};
					const keys = [...mods];
					if (main !== null) {
						const k = toKey(main);
						if (k === undefined) throw new Error(`nut 无 ${main} 键`);
						keys.push(k);
					}
					signal?.throwIfAborted();
					injected = true;
					await tapKeys(keyboard, keys);
					return { backend: "nut", keys: parts.join("+") };
				} catch (e) {
					if (injected || signal?.aborted) throw e;
					host.log("warn", `desktop-use: nut 按键失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			signal?.throwIfAborted();
			await psInput("key", { Keys: parts.join("+") }, signal);
			return { backend: isMac ? "macos-native" : "powershell", keys: parts.join("+") };
		}

		const isAscii = (s) => /^[\x20-\x7E\r\n\t]*$/.test(s ?? "");

		async function doType(text, signal) {
			signal?.throwIfAborted();
			if (typeof text !== "string" || text.length === 0) throw new Error("text 为空。");
			if (text.length > 2000) throw new Error("单次输入限 2000 字符（分多次调）。");
			if (isMac) {
				await psInput("paste", { Text: text }, signal);
				return { backend: "macos-native-unicode", chars: text.length };
			}
			if (!isAscii(text)) {
				await psInput("paste", { Text: text }, signal);
				return { backend: "powershell-paste", chars: text.length };
			}
			if (nutReadyOrThrow() && st.nut) {
				try {
					await st.nut.keyboard.type(text);
					return { backend: "nut", chars: text.length };
				} catch (e) {
					host.log("warn", `desktop-use: nut 输入失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			await psInput("paste", { Text: text }, signal);
			return { backend: "powershell-paste", chars: text.length };
		}

		function rememberShot(info) {
			const key = `s${++st.shotSeq}`;
			st.shots.set(key, { at: Date.now(), ...info });
			if (st.shots.size > 8) st.shots.delete(st.shots.keys().next().value);
			return key;
		}
		function rememberDump(nodes) {
			const key = `d${++st.dumpSeq}`;
			const byId = new Map();
			for (const n of nodes) {
				if (n?.id && n?.rect) {
					const rec = {
						x: n.rect.x + n.rect.w / 2,
						y: n.rect.y + n.rect.h / 2,
						name: n.name ?? "",
					};
					if (n.hwnd) rec.hwnd = n.hwnd;
					byId.set(n.id, rec);
				}
			}
			st.dumps.set(key, { at: Date.now(), byId });
			if (st.dumps.size > 8) {
				const first = st.dumps.keys().next().value;
				st.dumps.delete(first);
			}
			return key;
		}

		function resolvePoint({ dump, id, x, y, shot, text, occurrence }) {
			if (shot !== undefined && shot !== null && String(shot) !== "") {
				const s = st.shots.get(String(shot));
				if (!s) throw new Error("没有这张截图：先调 desktop_screenshot，再用它返回的 shot + 图内坐标或文字点。");
				if (Date.now() - s.at > DUMP_TTL_MS) throw new Error("截图已过期（>90s，窗口可能挪走）：重截一张再点。");

				let imgX = x;
				let imgY = y;
				let viaText = "";

				if (text !== undefined && text !== null && String(text).trim() !== "") {
					const q = String(text).trim();
					const ocrList = s.ocr ?? [];
					if (ocrList.length === 0) {
						throw new Error(`截图 ${shot} 中未识别到文字或 OCR 未启用，请改传图内像素坐标 x+y。`);
					}
					const hit = matchOcr(ocrList, q, occurrence);
					imgX = hit.cx;
					imgY = hit.cy;
					viaText = `OCR文字「${hit.text}」中心(${hit.cx},${hit.cy}) `;
				}

				if (typeof imgX !== "number" || typeof imgY !== "number") {
					throw new Error("shot 模式要给图内像素坐标 x+y，或传 text 按文字定位（左上角为原点）。");
				}
				const { x: sx, y: sy } = screenshotPoint(s, imgX, imgY);
				return { x: sx, y: sy, via: `截图 ${shot} ${viaText}图内(${imgX},${imgY})→屏幕(${sx},${sy})` };
			}
			if (id !== undefined && id !== null && String(id) !== "") {
				const d = dump ? st.dumps.get(String(dump)) : [...st.dumps.values()].pop();
				if (!d) throw new Error("没有可用的元素快照：先调 desktop_elements 查一遍，再用它返回的 dump+id 点。");
				if (Date.now() - d.at > DUMP_TTL_MS) {
					throw new Error("元素快照已过期（>90s，窗口可能挪走/重绘）：重调 desktop_elements 再点。");
				}
				const hit = d.byId.get(String(id));
				if (!hit) throw new Error(`快照里没有 id=${id}：用 desktop_elements 返回的 id，不要猜。`);
				return { x: hit.x, y: hit.y, via: `id ${id}（${hit.name || "未命名"}）` };
			}
			if (typeof x === "number" && typeof y === "number") {
				return { ...finitePoint(x, y), via: "raw 屏幕坐标（非快照元素，点错风险自负）" };
			}
			throw new Error("给 shot+x+y（截图点，自绘界面用）或 dump+id（UIA 元素）或 x+y 屏幕坐标。");
		}

		const fmtNodes = (nodes) =>
			nodes
				.slice(0, LIST_TEXT_CAP)
				.map((n) => {
					const r = n.rect;
					const label = n.name ? `「${n.name}」` : "(未命名)";
					const owner = n.proc ? ` <${n.proc}${n.cls ? `:${n.cls}` : ""}>` : "";
					return `- id=${n.id} [${n.type}] ${label}${owner} @(${r.x},${r.y},${r.w}x${r.h})`;
				})
				.join("\n");

		const POINT_PROPS = {
			x: { type: "number", description: "in-image X with shot, else screen X" },
			y: { type: "number", description: "in-image Y with shot, else screen Y" },
		};

		const GUIDELINES = [
			"Query with desktop_elements first, then click/type using the returned dump+id: never guess coordinates, never reuse ids older than 90 seconds",
			"Self-drawn UIs (WeChat/QQ/games: elements returns empty shells) use the screenshot flow: desktop_screenshot auto-OCRs text with exact coords — pass text='...' or (cx, cy) to desktop_click, no coordinate guessing",
			"Typing into self-drawn UIs: WeChat/QQ input boxes are focused when the window is active — prefer desktop_window(focus) + desktop_type(text) (clipboard paste); to click-focus the input, pass shot+click_text or shot+x+y+text in one call",
			"Across turns / after user confirmation the foreground always switches to the browser: before any key/type, first desktop_window(action='focus') to bring the target app forward (e.g. before Enter to send)",
			"For irreversible actions (close/delete/submit/pay/send message), confirm the target with the user in one sentence before acting",
			"Click one element at a time; verify with desktop_elements or desktop_screenshot after each click, no rapid-fire; see docs/app-playbook.md for common app patterns",
		];

		const tools = [
			{
				name: "desktop_elements",
				label: "查桌面元素",
				description:
					"List Windows controls without screenshots (UI Automation): returns element id/type/name/rect along with the dump key and element id.",
				promptSnippet: "list desktop controls (no screenshot needed)",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						scope: {
							type: "string",
							enum: ["foreground", "desktop", "window"],
							description:
								"foreground = current foreground window (default); desktop = whole desktop (top-level windows only); window = find by title/process.",
						},
						title: {
							type: "string",
							description:
								"Window title substring when scope=window (unreliable for apps with volatile titles; prefer process).",
						},
						process: {
							type: "string",
							description:
								"Process name substring when scope=window (e.g. Weixin / WeChat / chrome). Use this for apps whose title changes every launch (e.g. WeChat).",
						},
						query: { type: "string", description: "Filter by name/type/AutomationId (e.g. the address bar)." },
						max_nodes: { type: "number", description: "Max nodes returned (default 200, cap 800)." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					const scope = ["foreground", "desktop", "window"].includes(p.scope) ? p.scope : "foreground";
					const maxNodes = Math.min(800, Math.max(10, Math.floor(Number(p.max_nodes) || 200)));
					const r = await runDesktop(
						UIA_PS1,
						{
							Scope: scope,
							Title: p.title ?? "",
							Process: p.process ?? "",
							Query: p.query ?? "",
							MaxNodes: maxNodes,
							MaxDepth: scope === "desktop" ? 1 : 8,
						},
						{ signal },
					);
					if (!r?.ok) throw new Error(`元素枚举失败：${r?.error ?? "unknown"}`);
					const dump = rememberDump(r.nodes ?? []);
					const head =
						`快照 ${dump}（${r.count} 个元素${r.truncated ? "，已截断" : ""}，90 秒内有效，root=${r.root ?? "?"}）：\n` +
						fmtNodes(r.nodes ?? []);
					return {
						content: [{ type: "text", text: head }],
						details: { dump, count: r.count, truncated: !!r.truncated },
					};
				},
			},
			{
				name: "desktop_click",
				label: "点桌面元素",
				description:
					"Click: (1) screenshot flow for self-drawn UIs — pass shot + in-image pixel x/y, or shot + text to click by recognized OCR text (auto-centered); (2) dump+id (UIA element center); (3) raw screen x/y (discouraged).",
				promptSnippet: "click by screenshot coords/text or element id",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						shot: {
							type: "string",
							description: "Screenshot key returned by desktop_screenshot (screenshot flow; use with x+y or text).",
						},
						text: {
							type: "string",
							description:
								"Optional: click by text on the screenshot (requires shot; ambiguous matches require occurrence).",
						},
						occurrence: { type: "integer", minimum: 1, description: "1-based OCR match index in returned OCR order." },
						dump: { type: "string", description: "Snapshot key returned by desktop_elements." },
						id: { type: "string", description: "Element id (e.g. 0.2.1)." },
						...POINT_PROPS,
						button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left." },
						double: { type: "boolean", description: "Double-click, default false." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					const pt = resolvePoint(p);
					const r = await doClick(pt.x, pt.y, { button: p.button ?? "left", double: p.double === true }, signal);
					return `已点击 ${pt.via} @(${r.x},${r.y}) [${r.backend}]。`;
				},
			},
			{
				name: "desktop_screenshot",
				label: "窗口截图",
				description:
					"Capture a window using native Windows/macOS APIs, with screen coordinates, scale and optional offline OCR. macOS needs Screen Recording permission; Windows can overlay the cursor.",
				promptSnippet: "screenshot a window with OCR text and mouse position",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						dump: {
							type: "string",
							description: "Optional: desktop_elements snapshot key (with id to target that exact window).",
						},
						id: { type: "string", description: "Optional: window id from the snapshot (the type=Window entry)." },
						title: {
							type: "string",
							description: "Window title substring (unreliable for volatile titles; prefer process or dump+id).",
						},
						process: { type: "string", description: "Process name substring (e.g. Weixin / msedge)." },
						max_width: {
							type: "number",
							description: "Max delivered image width in px (default 1280; smaller saves tokens, coords still scale).",
						},
						ocr: {
							type: "boolean",
							description:
								"Auto OCR of in-image text and coords (default true); returns precise pixel coords and center for each text.",
						},
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					let hwnd = 0;
					if (p.id !== undefined && String(p.id) !== "") {
						const d = p.dump ? st.dumps.get(String(p.dump)) : [...st.dumps.values()].pop();
						const hit = d?.byId.get(String(p.id));
						if (hit?.hwnd) hwnd = hit.hwnd;
						else
							throw new Error(
								"该 id 没有窗口句柄（只有 type=Window 的节点能截图）：用窗口那条的 id，或改传 process/title。",
							);
					}
					const maxWidth = Math.min(1920, Math.max(320, Math.floor(Number(p.max_width) || 1280)));
					const ocrEnabled = p.ocr !== false ? 1 : 0;
					const outFile = join(tmpdir(), `desktop-use-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
					const args = hwnd
						? { Hwnd: hwnd, MaxWidth: maxWidth, Out: outFile, Ocr: ocrEnabled }
						: { Title: p.title ?? "", Process: p.process ?? "", MaxWidth: maxWidth, Out: outFile, Ocr: ocrEnabled };
					let r;
					try {
						r = await runDesktop(SHOT_PS1, args, { timeout: 60000, signal });
					} finally {
						if (!r?.out) {
							try {
								rmSync(outFile, { force: true });
							} catch {}
						}
					}
					if (!r?.ok) throw new Error(`截图失败：${r?.error ?? "unknown"}`);
					if (r.blank)
						throw new Error(
							`截出来是空白（窗口最小化/被保护？）：先 desktop_window focus 到前台再截。窗口左上角=(${r.x},${r.y})，${r.hint ?? ""}`,
						);
					let png;
					try {
						png = readFileSync(r.out);
					} finally {
						try {
							rmSync(r.out, { force: true });
						} catch {}
					}
					if (!png || png.length < 1000) throw new Error("截图文件异常（太小），重试一次。");
					const ocrList = Array.isArray(r.ocr) ? r.ocr : [];
					const key = rememberShot({
						winX: r.x,
						winY: r.y,
						winW: r.w,
						winH: r.h,
						imgW: r.imgW,
						imgH: r.imgH,
						ocr: ocrList,
					});
					let cursorLine = "鼠标光标在窗口外（cursor outside window），图里看不到指针。";
					if (r.cursorInWin) {
						const drawNote = r.cursorDrawn
							? "已画进图里"
							: r.cursorMarker
								? "指针正隐藏（打字中），已用红圈标记位置"
								: "在窗口内但绘制失败，以坐标为准";
						cursorLine = `鼠标光标（${drawNote}）：图内坐标=(${r.cursorImgX},${r.cursorImgY})，屏幕坐标=(${r.cursorX},${r.cursorY})——可据此确认上次点击落点；文本插入符（输入框竖线）是闪烁的，截图时可能正好熄灭，以鼠标位置+输入框聚焦态为准。`;
					}
					let ocrSection = "";
					if (ocrList.length > 0) {
						const showCount = 80;
						const lines = ocrList
							.slice(0, showCount)
							.map(
								(item) =>
									`- 「${item.text}」 @(${item.x},${item.y},${item.w}x${item.h}) → 中心 (${item.cx},${item.cy})`,
							);
						const more =
							ocrList.length > showCount
								? `\n...（还有 ${ocrList.length - showCount} 处文字省略，完整见 details.ocr）`
								: "";
						ocrSection = `\n图内文字定位（OCR，共 ${ocrList.length} 处）：\n${lines.join("\n")}${more}\n`;
					}
					const caption =
						`窗口截图 ${key}（${r.method}）：窗口左上角屏幕坐标=(${r.x},${r.y})，窗口${r.w}x${r.h}，下发图${r.imgW}x${r.imgH}。\n` +
						`Screenshot ${key} (${r.method}): window top-left=(${r.x},${r.y}), window ${r.w}x${r.h}, image ${r.imgW}x${r.imgH}.\n` +
						`${cursorLine}\n` +
						`${ocrSection}` +
						`在图里找目标，把图内像素坐标 {x,y} 传给 desktop_click（shot=${key}），换算：屏幕=( ${r.x}+x*${r.w}/${r.imgW}, ${r.y}+y*${r.h}/${r.imgH} )。\n` +
						`也可直接按文字点击：desktop_click 传 shot=${key} + text="文字内容"（自动对齐 OCR 中心点，无需猜坐标）。截图 90 秒内有效。`;
					return {
						content: [
							{ type: "text", text: caption },
							{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
						],
						details: {
							shot: key,
							x: r.x,
							y: r.y,
							w: r.w,
							h: r.h,
							imgW: r.imgW,
							imgH: r.imgH,
							method: r.method,
							cursorDrawn: !!r.cursorDrawn,
							cursorMarker: !!r.cursorMarker,
							cursorInWin: !!r.cursorInWin,
							cursorX: r.cursorX,
							cursorY: r.cursorY,
							cursorImgX: r.cursorImgX,
							cursorImgY: r.cursorImgY,
							ocr: ocrList,
						},
					};
				},
			},
			{
				name: "desktop_type",
				label: "向桌面输入",
				description:
					"Type into an input: English via keyboard, Chinese/emoji via clipboard paste. 2000 chars max per call.",
				promptSnippet: "type or paste text into an input",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "Text to type." },
						occurrence: { type: "integer", minimum: 1, description: "1-based OCR match index for click_text." },
						click_text: {
							type: "string",
							description:
								"Optional: first click-focus by text on the screenshot (requires shot; auto-matches the OCR text center).",
						},
						shot: {
							type: "string",
							description:
								"Optional: screenshot key from desktop_screenshot (recommended for self-drawn UIs; use with x+y or click_text to click-focus first).",
						},
						dump: { type: "string", description: "Optional: snapshot key to click an id first for focus." },
						id: { type: "string", description: "Optional: element id (clicked first, then types)." },
						...POINT_PROPS,
					},
					required: ["text"],
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					let via = "";
					if (
						p.shot !== undefined ||
						p.id !== undefined ||
						(typeof p.x === "number" && typeof p.y === "number") ||
						p.click_text !== undefined
					) {
						const pt = resolvePoint({ ...p, text: p.click_text });
						via = `，已先聚焦 ${pt.via}`;
						await doClick(pt.x, pt.y, {}, signal);
						await new Promise((r) => setTimeout(r, 250));
					}
					const r = await doType(String(p.text ?? ""), signal);
					return `已输入 ${r.chars} 字 [${r.backend}]${via}。`;
				},
			},
			{
				name: "desktop_key",
				label: "按键/快捷键",
				description: 'Press a key or combo: "enter" / "esc" / "tab" / "ctrl+c" / "alt+F4" / "win+r" / "F5".',
				promptSnippet: "press keys or shortcuts",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						keys: { type: "string", description: 'Keys, e.g. "enter" / "ctrl+c" / "alt+F4".' },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					const parts = parseKeys(params?.keys);
					const r = await doKey(parts, signal);
					return `已按键 ${r.keys} [${r.backend}]。`;
				},
			},
			{
				name: "desktop_scroll",
				label: "滚动桌面",
				description:
					"Scroll vertically or horizontally at a target from a fresh screenshot or element snapshot. Amount is wheel notches (1–100).",
				promptSnippet: "scroll a desktop panel at a known target",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						shot: { type: "string", description: "Screenshot key." },
						text: { type: "string", description: "OCR text to locate the scroll target." },
						occurrence: { type: "integer", minimum: 1, description: "1-based OCR match index." },
						dump: { type: "string", description: "Element snapshot key." },
						id: { type: "string", description: "Element id to scroll over." },
						...POINT_PROPS,
						direction: { type: "string", enum: ["up", "down", "left", "right"] },
						amount: { type: "integer", minimum: 1, maximum: 100, description: "Wheel notches; default 3." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					const wheel = scrollInput(p.direction, p.amount);
					const pt = resolvePoint(p);
					signal?.throwIfAborted();
					await psInput("scroll", { X: pt.x, Y: pt.y, ...wheel }, signal);
					return `已滚动 ${p.direction ?? "down"} ${p.amount ?? 3} 格，目标 ${pt.via}。请重新查询目标区域。`;
				},
			},
			{
				name: "desktop_drag",
				label: "拖拽桌面",
				description:
					"Drag the left mouse button between two in-image points from one fresh screenshot. Releases the button before reporting completion or cancellation.",
				promptSnippet: "drag between two points in a fresh desktop screenshot",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						shot: { type: "string", description: "Fresh screenshot key; all coordinates are image pixels." },
						x: { type: "number", description: "Start image X." },
						y: { type: "number", description: "Start image Y." },
						to_x: { type: "number", description: "End image X." },
						to_y: { type: "number", description: "End image Y." },
						duration_ms: { type: "integer", minimum: 100, maximum: 2000, description: "Drag duration; default 500ms." },
					},
					required: ["shot", "x", "y", "to_x", "to_y"],
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					if (!p.shot) throw new Error("拖拽需要新截图 shot。");
					const duration = p.duration_ms ?? 500;
					if (!Number.isInteger(duration) || duration < 100 || duration > 2000)
						throw new Error("duration_ms 必须在 100–2000 之间。");
					const start = resolvePoint({ shot: p.shot, x: p.x, y: p.y });
					const end = resolvePoint({ shot: p.shot, x: p.to_x, y: p.to_y });
					signal?.throwIfAborted();
					await psInput("drag", { X: start.x, Y: start.y, ToX: end.x, ToY: end.y, Duration: duration });
					signal?.throwIfAborted();
					return `已拖拽 (${start.x},${start.y}) → (${end.x},${end.y})。请重新截图验证。`;
				},
			},
			{
				name: "desktop_window",
				label: "窗口列表/聚焦",
				description:
					"List top-level windows (action=list) or bring one to the foreground (action=focus + title substring).",
				promptSnippet: "list or focus a desktop window",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						action: { type: "string", enum: ["list", "focus"], description: "list or focus." },
						title: { type: "string", description: "Window title substring for focus." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					if (p.action === "focus") {
						if (!p.title) throw new Error("focus 需要 title（窗口标题子串）。");
						const r = await runDesktop(
							INPUT_PS1,
							{ Op: "focus", Title: p.title },
							{
								timeout: INPUT_TIMEOUT_MS,
								signal,
							},
						);
						if (!r?.ok) throw new Error(`聚焦失败：${r?.error ?? "unknown"}`);
						await new Promise((r2) => setTimeout(r2, 400));
						return `已聚焦：${r.title}`;
					}
					const r = await runDesktop(UIA_PS1, { Scope: "desktop", MaxNodes: 120, MaxDepth: 1 }, { signal });
					if (!r?.ok) throw new Error(`窗口枚举失败：${r?.error ?? "unknown"}`);
					const wins = (r.nodes ?? []).filter((n) => n.type === "Window" && n.name);
					if (wins.length === 0) return "没有可见顶层窗口。";
					return (
						`顶层窗口（${wins.length}，标题易变的认进程名）：\n` +
						wins
							.map(
								(w) =>
									`- 「${w.name}」${w.proc ? ` (${w.proc}${isWin ? ".exe" : ""}${w.cls ? ` / ${w.cls}` : ""})` : ""}`,
							)
							.join("\n")
					);
				},
			},
		];

		for (const t of tools) {
			try {
				const off = host.registerAgentTool(t);
				st.offs.push(off);
			} catch (e) {
				host.log("error", `desktop-use: 注册工具 ${t.name} 失败：${e?.message ?? e}`);
			}
		}

		if (isWin)
			probeNut().then((ok) => {
				if (st.dead) return;
				if (ok) {
					st.depsOk = true;
					host.log("info", "desktop-use: 输入依赖就绪（nut-js）");
				} else {
					ensureDeps(true);
				}
			});

		return {
			deactivate() {
				st.dead = true;
				st.dumps.clear();
				st.shots.clear();
				try {
					st.installer?.kill("SIGTERM");
				} catch {}
				for (const off of st.offs) {
					try {
						off?.();
					} catch {}
				}
			},
		};
	},
};
