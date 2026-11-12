#!/usr/bin/env node
/**
 * 把本地构建产物装进 macOS 的 `/Applications/pi-web-ui-desktop.app`（只给开发者用）。
 *
 *   node scripts/update-local-app.mjs --dry-run     # 只体检：产物在不在、已装的是不是同一份
 *   node scripts/update-local-app.mjs               # 退出 app → 备份 → 替换 → 重新打开
 *   node scripts/update-local-app.mjs --delay 30    # 30 秒后再动手（先把这条命令丢到后台）
 *   node scripts/update-local-app.mjs --no-relaunch # 只换不重启
 *
 * 硬规矩（都是踩过的坑，别改回去）：
 *
 * 1. **自己退出，绝不注册成常驻任务**。曾用 `launchctl submit` 起过一次：launchd 在脚本退出后
 *    会把它再拉起来，于是「等 75s → 退出 app → 替换 → 重新打开」无限循环，用户看到 app 反复重启。
 *    要延后就本进程自己 `--delay` 睡，或由调用方 `nohup … &`，**不要**交给 launchd/守护进程。
 * 2. **日志只追加不截断**。上面那次的日志被脚本自己 `: > log` 截断，只剩一行 `start`，
 *    看起来「没跑过」，实际跑了很多轮，排查方向被带偏。
 * 3. **幂等**：已装包与产物指纹一致 → 直接 exit 0，不碰 app；有锁/有别的实例在跑 → 退出。
 * 4. **失败回滚**：备份只留一份（每次覆盖上一份），替换中途失败就把备份搬回去。
 * 5. **等 app 真的退出再动文件**：正在跑的 Electron 还在映射这些文件，边跑边换会留下半新半旧。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_TARGET = "/Applications/pi-web-ui-desktop.app";
const BACKUP = "/tmp/pi-web-ui-desktop.app.bak";
const LOCK = "/tmp/pi-app-update.lock";
const LOG = "/tmp/pi-app-update.log";
const APP_PROCESS = "pi-web-ui-desktop.app/Contents/MacOS/pi-web-ui-desktop";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};

const dryRun = has("dry-run");
const relaunch = !has("no-relaunch");
const delay = Math.max(0, Number(value("delay", "0")) || 0);
const target = value("target", DEFAULT_TARGET);
const source = value(
	"source",
	join("release", process.arch === "arm64" ? "mac-arm64" : "mac", "pi-web-ui-desktop.app"),
);

/** 追加式日志：截断过一次就再也看不出跑过几轮了。 */
function log(message) {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	try {
		writeFileSync(LOG, line, { flag: "a" });
	} catch {}
	console.log(message);
}

function fail(message, code = 1) {
	log(`FAILED: ${message}`);
	if (!dryRun) console.error(message);
	process.exit(code);
}

function run(command, argv) {
	return new Promise((resolve) => {
		const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.once("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }));
		child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 列出目录下所有文件（相对路径 + 大小），用来算产物指纹。 */
function walk(dir, base = dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, base, out);
		else if (entry.isFile()) {
			try {
				out.push(`${full.slice(base.length + 1)}:${statSync(full).size}`);
			} catch {}
		}
	}
	return out;
}

/** 产物指纹：只关心「哪份代码」，所以取 Resources/app 下全部文件的相对路径与大小。 */
function fingerprint(app) {
	const payload = join(app, "Contents", "Resources", "app");
	if (!existsSync(payload)) return "";
	const hash = createHash("sha256");
	for (const line of walk(payload).sort()) hash.update(`${line}\n`);
	return hash.digest("hex").slice(0, 16);
}

async function version(app) {
	const result = await run("/usr/libexec/PlistBuddy", [
		"-c",
		"Print :CFBundleShortVersionString",
		join(app, "Contents", "Info.plist"),
	]);
	return result.code === 0 ? result.stdout.trim() : "?";
}

/** 正在运行的 app 主进程（不含 Helper 子进程）。 */
async function appPids() {
	const result = await run("/usr/bin/pgrep", ["-f", APP_PROCESS]);
	return result.stdout
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitUntilQuit(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await appPids()).length) return true;
		await sleep(500);
	}
	return !(await appPids()).length;
}

function acquireLock() {
	try {
		const existing = Number(readFileSync(LOCK, "utf8").trim());
		if (Number.isInteger(existing) && existing > 0) {
			try {
				process.kill(existing, 0);
				return false; // 另一个实例还在跑
			} catch {}
		}
	} catch {}
	try {
		const fd = openSync(LOCK, "w");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function releaseLock() {
	try {
		unlinkSync(LOCK);
	} catch {}
}

async function main() {
	if (process.platform !== "darwin") fail("这个脚本只处理 macOS 的 /Applications 安装包", 2);
	if (!existsSync(source))
		fail(
			`找不到构建产物：${source}（先跑 npm run build && npm run build:desktop && node scripts/run-electron-builder.mjs -c desktop/electron-builder.yml --dir）`,
		);

	const sourceVersion = await version(source);
	const sourceFingerprint = fingerprint(source);
	const installed = existsSync(target);
	const installedVersion = installed ? await version(target) : "-";
	const installedFingerprint = installed ? fingerprint(target) : "";

	log(`来源 ${source}（${sourceVersion} · ${sourceFingerprint}）`);
	log(`已装 ${target}（${installedVersion} · ${installedFingerprint || "缺"}）`);

	if (installed && installedFingerprint === sourceFingerprint) {
		log("已装的就是这份产物，什么都不用做");
		return;
	}
	if (dryRun) {
		log(`dry-run：需要替换（已装 ${installed ? installedVersion : "无"} → ${sourceVersion}），未做任何修改`);
		return;
	}
	if (delay) {
		log(`延后 ${delay}s 执行；这段时间可以先把终端里跑着的命令收尾`);
		await sleep(delay * 1000);
	}
	if (!acquireLock()) fail("已有另一个更新进程在跑（见 " + LOCK + "），本次退出");

	let staging = "";
	let backedUp = false;
	try {
		const pids = await appPids();
		if (pids.length) {
			log(`退出 app（pid ${pids.join(",")}）`);
			await run("/usr/bin/osascript", ["-e", 'tell application "pi-web-ui-desktop" to quit']);
			let quit = await waitUntilQuit(20_000);
			if (!quit) {
				// 拿不到自动化授权时 osascript 会静默失败：退化成 TERM（Electron 收到即正常退出）
				log("osascript 没关掉它，改发 SIGTERM");
				for (const pid of pids) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {}
				}
				quit = await waitUntilQuit(45_000);
			}
			if (!quit) fail("app 一直没退出（可能有未保存的会话），本次不替换");
			log("app 已退出");
		}

		staging = `${target}.new`;
		rmSync(staging, { recursive: true, force: true });
		log("复制新包 → 临时目录");
		const copied = await run("/usr/bin/ditto", [source, staging]);
		if (copied.code !== 0) fail(`ditto 失败：${copied.stderr.trim() || copied.code}`);

		rmSync(BACKUP, { recursive: true, force: true });
		if (existsSync(target)) {
			const backedUpResult = await run("/usr/bin/ditto", [target, BACKUP]);
			if (backedUpResult.code !== 0) fail(`备份失败，不继续替换：${backedUpResult.stderr.trim()}`);
			backedUp = true;
			log(`已备份旧包 → ${BACKUP}`);
		}
		rmSync(target, { recursive: true, force: true });
		const moved = await run("/bin/mv", [staging, target]);
		if (moved.code !== 0) {
			if (backedUp) {
				log("替换失败，回滚备份");
				await run("/usr/bin/ditto", [BACKUP, target]);
			}
			fail(`替换失败：${moved.stderr.trim() || moved.code}`);
		}
		staging = "";
		log(`替换完成（${sourceVersion} · ${sourceFingerprint}）`);
		await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", target]);

		if (relaunch) {
			const opened = await run("/usr/bin/open", ["-a", target]);
			if (opened.code !== 0) fail(`重新打开失败，请手动启动：${opened.stderr.trim()}`);
			log("已重新打开 app");
		}
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		releaseLock();
	}
}

await main();
