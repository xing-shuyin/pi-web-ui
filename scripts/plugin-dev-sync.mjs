#!/usr/bin/env node
/**
 * plugin-dev-sync — 内置插件开发热同步（文件同步 + 宿主重载）
 *
 * 解决的两件事（缺一不可）：
 *   1. 文件：仓库 plugins/<id> 的改动要落到数据目录 <dataDir>/plugins/<id>（跨盘符时软链不可用，只能复制）；
 *   2. 失效：宿主的插件实例在内存里，客户端模块按 ?e=<epoch> 缓存，
 *      必须让宿主走一次 pluginMgr.reload()（epoch+1）→ 浏览器自动重新 import + remount。
 *      全仓库仅 plugins_reload（设置页「重新加载插件」）会做这件事，此脚本用同一协议触发。
 *
 * 用法：
 *   node scripts/plugin-dev-sync.mjs <pluginId> [选项]
 *   node scripts/plugin-dev-sync.mjs bili-scroll              # 常驻：保存即重载
 *   node scripts/plugin-dev-sync.mjs bili-scroll --once       # 同步一次 + 重载后退出
 *   node scripts/plugin-dev-sync.mjs bili-scroll --no-copy    # 目录已用 npm run plugins:link 链接时
 *
 * 选项：
 *   --port <n>      宿主端口（默认 $PI_WEB_PORT ?? 8787）
 *   --data-dir <p>  数据目录（默认 $PI_WEB_DATA_DIR ?? ~/.pi-web）
 *   --once          只同步并重载一次
 *   --no-copy       只触发重载，不复制文件
 *   --no-reload     只复制文件，不触发重载
 *   --debounce <ms> 去抖窗口（默认 400）
 *   --verbose       打印每次落盘的文件
 *
 * 注意：提交前仍必须递增 manifest.json / package.json 的 version（守卫 plugin-version-bump-guard），
 * 否则别的机器与正式更新拿不到这次改动 —— 本脚本只让「本机运行中的宿主」立即生效。
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { homedir, platform } from "node:os";
import net from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoPluginsDir = join(repoRoot, "plugins");

/** 不参与同步的路径（宿主元数据、构建产物、缓存） */
const SKIP = [
	/(^|\/)node_modules(\/|$)/,
	/(^|\/)\.git(\/|$)/,
	/(^|\/)__pycache__(\/|$)/,
	/(^|\/)\.pi-[^/]+$/,
	/\.(pyc|log)$/,
	/(^|\/)\.DS_Store$/,
	/(^|\/)\.hf-cache(\/|$)/,
	/(^|\/)tmp(\/|$)/,
];

const EXCLUDED = (rel) => SKIP.some((re) => re.test(rel));

function parseArgs(argv) {
	const opts = {
		id: "",
		port: Number(process.env.PI_WEB_PORT) || 8787,
		dataDir: process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web"),
		once: false,
		copy: true,
		reload: true,
		debounce: 400,
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--port") opts.port = Number(next());
		else if (a === "--data-dir") opts.dataDir = resolve(String(next()));
		else if (a === "--once") opts.once = true;
		else if (a === "--no-copy") opts.copy = false;
		else if (a === "--no-reload") opts.reload = false;
		else if (a === "--debounce") opts.debounce = Number(next());
		else if (a === "--verbose") opts.verbose = true;
		else if (a === "-h" || a === "--help") {
			console.log(readme());
			process.exit(0);
		} else if (a.startsWith("-")) {
			console.error(`未知选项: ${a}`);
			process.exit(2);
		} else if (!opts.id) opts.id = a;
	}
	if (!Number.isFinite(opts.port) || opts.port <= 0) {
		console.error("无效端口");
		process.exit(2);
	}
	return opts;
}

function readme() {
	const self = relative(process.cwd(), fileURLToPath(import.meta.url)) || "scripts/plugin-dev-sync.mjs";
	return `用法: node ${self} <pluginId> [--port 8787] [--once] [--no-copy] [--no-reload] [--debounce 400] [--verbose]`;
}

function log(msg) {
	const t = new Date().toLocaleTimeString();
	console.log(`[${t}] ${msg}`);
}

function toPosix(p) {
	return p.split(sep).join("/");
}

/** 递归列出源目录下的同步范围文件（posix 相对路径） */
function listFiles(root, sub = "") {
	const out = [];
	let entries;
	try {
		entries = readdirSync(join(root, sub), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const rel = sub ? `${sub}/${ent.name}` : ent.name;
		if (EXCLUDED(rel)) continue;
		if (ent.isDirectory()) out.push(...listFiles(root, rel));
		else if (ent.isFile()) out.push(rel);
	}
	return out;
}

function isLinked(dir) {
	try {
		return lstatSync(dir).isSymbolicLink();
	} catch {
		return false;
	}
}

function changed(source, target, rel) {
	try {
		const a = statSync(join(source, rel));
		const b = statSync(join(target, rel));
		return a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) > 1;
	} catch {
		return true;
	}
}

/** 把仓库插件目录按需同步到数据目录，返回落盘的文件数 */
function syncOnce({ source, target, verbose }) {
	if (isLinked(target)) return { copied: 0, linked: true };
	let copied = 0;
	for (const rel of listFiles(source)) {
		if (!changed(source, target, rel)) continue;
		const dest = join(target, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(source, rel), dest);
		copied++;
		if (verbose) log(`  ↳ ${rel}`);
	}
	return { copied, linked: false };
}

/** 数据目录里有、源目录已删除的文件 —— 仅清理同步范围内的（不碰 .pi-* / .hf-cache / 宿主生成的 client/sdk 等） */
function pruneDeleted({ source, target }) {
	let removed = 0;
	for (const rel of listFiles(target)) {
		if (existsSync(join(source, rel))) continue;
		// 只删「源目录里本来就有这个父目录」的文件：数据目录独有的目录（宿主生成物、缓存）一律不碰
		const parent = dirname(rel);
		if (parent !== "." && !existsSync(join(source, parent))) continue;
		rmSync(join(target, rel), { force: true });
		removed++;
	}
	return removed;
}

function controlPath({ dataDir, port }) {
	return platform() === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

/** 通过宿主控制管道取认证令牌（与 CLI /pi-web-ui 命令同一通道） */
function controlStatus({ dataDir, port }) {
	const path = controlPath({ dataDir, port });
	return new Promise((resolvePromise, reject) => {
		const sock = net.createConnection(path);
		let buf = "";
		let settled = false;
		const finish = (err, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			if (err) reject(err);
			else resolvePromise(value);
		};
		const timer = setTimeout(() => finish(new Error("控制管道超时")), 3000);
		sock.on("connect", () => sock.write(JSON.stringify({ cmd: "status" }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				finish(null, JSON.parse(buf.slice(0, nl)));
			} catch (err) {
				finish(err);
			}
		});
		sock.on("error", (err) => finish(err));
	});
}

/** 发 plugins_reload，等同设置页「重新加载插件」：epoch+1 → 浏览器重载插件客户端 */
function triggerReload({ token, port, pluginId }) {
	const WebSocket = require("ws");
	return new Promise((resolvePromise) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
		let baseEpoch = null;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {}
			resolvePromise(result);
		};
		const timer = setTimeout(() => finish({ ok: false, error: "等待宿主重载超时（60s）" }), 60_000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", clientId: `plugin-dev-sync-${process.pid}`, protocolVersion: 1 }));
		});
		ws.on("error", (err) => finish({ ok: false, error: err.message }));
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (msg.type !== "plugins" || !Array.isArray(msg.plugins)) return;
			// 先拿一份「重载前」的完整名单做基准，再发重载：避免 reload 比首次推送还快时基准错位
			if (baseEpoch === null) {
				baseEpoch = msg.epoch;
				try {
					ws.send(JSON.stringify({ type: "plugins_reload" }));
				} catch (err) {
					finish({ ok: false, error: err.message });
				}
				return;
			}
			if (msg.epoch === baseEpoch) return;
			const info = msg.plugins.find((p) => p.id === pluginId);
			// 重载中途可能推一份空名单，等拿到含本插件的那份再报结果
			if (!info) return;
			finish({
				ok: true,
				epoch: msg.epoch,
				version: info.version ?? "?",
				error: info.error ?? null,
			});
		});
	});
}

async function reloadHost(opts) {
	let status;
	try {
		status = await controlStatus(opts);
	} catch (err) {
		log(`✗ 连不上宿主控制管道（${controlPath(opts)}）：${err.message}`);
		log("  宿主没在跑，或用 --port 指定实际端口（PI_WEB_PORT）");
		return false;
	}
	if (!status?.authToken) {
		log("✗ 宿主未返回 authToken（关闭了鉴权？），跳过重载");
		return false;
	}
	const res = await triggerReload({ token: status.authToken, port: opts.port, pluginId: opts.id });
	if (!res.ok) {
		log(`✗ 重载失败：${res.error}`);
		return false;
	}
	if (res.error) {
		log(`⚠ 宿主已重载，但插件报错：${res.error}`);
		return false;
	}
	log(`✓ 宿主已重载：${opts.id} v${res.version} · epoch ${res.epoch}`);
	return true;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.id) {
		console.error(readme());
		process.exit(2);
	}
	const source = join(repoPluginsDir, opts.id);
	const target = join(opts.dataDir, "plugins", opts.id);
	if (!existsSync(source)) {
		console.error(`源插件目录不存在: ${source}`);
		process.exit(2);
	}
	if (opts.copy && !existsSync(target)) {
		console.error(`数据目录里没有 ${opts.id}（${target}）—— 先在界面里安装/启用它，或加 --no-copy`);
		process.exit(2);
	}

	log(`插件 ${opts.id}`);
	log(`  源: ${source}`);
	log(`  目标: ${target}${isLinked(target) ? "（软链，跳过复制）" : ""}`);
	log(`  宿主: http://127.0.0.1:${opts.port}`);

	const apply = async (reason) => {
		const removed = opts.copy ? pruneDeleted({ source, target }) : 0;
		const { copied, linked } = opts.copy ? syncOnce({ source, target, verbose: opts.verbose }) : { copied: 0 };
		if (opts.copy) {
			log(
				`${reason} → 同步 ${copied} 个文件${removed ? `，清理 ${removed} 个已删除文件` : ""}${linked ? "（软链，无需复制）" : ""}`,
			);
		}
		if (!opts.reload) return;
		if (copied === 0 && !linked && !opts.verbose && reason.startsWith("启动")) {
			log("  文件无差异，仅触发热重载");
		}
		await reloadHost(opts);
	};

	await apply("启动");
	if (opts.once) return;

	let timer = null;
	let busy = false;
	let dirty = false;
	const schedule = (file) => {
		dirty = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			timer = null;
			if (busy) return;
			busy = true;
			dirty = false;
			try {
				await apply(file ? `变更 ${file}` : "变更");
			} finally {
				busy = false;
				if (dirty) schedule(null);
			}
		}, opts.debounce);
	};

	let watcher;
	try {
		watcher = watch(source, { recursive: true }, (_evt, file) => {
			const rel = file ? toPosix(String(file)) : "";
			if (rel && EXCLUDED(rel)) return;
			schedule(rel);
		});
	} catch (err) {
		log(`✗ 无法监听目录：${err.message}`);
		process.exit(1);
	}
	watcher.on("error", (err) => log(`✗ watcher 错误：${err.message}`));
	log("监听中 —— 改代码保存即生效（Ctrl+C 退出）");

	const shutdown = () => {
		try {
			watcher.close();
		} catch {}
		log("已退出");
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
