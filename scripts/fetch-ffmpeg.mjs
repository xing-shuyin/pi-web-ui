// 把 ffmpeg 静态构建放进 bin/ffmpeg/<platform>-<arch>/，供 H.264 桌面通道使用。
//
// 为什么需要它：JPEG 帧在 1080p60 要 ~100 Mbps，2560×1440 要 ~160 Mbps，中继根本喂不起；
// NVENC 硬编码同样的画面只要 9–18 Mbps。发布包必须自带 ffmpeg，不能指望用户 PATH 里有。
//
// 用法：
//   node scripts/fetch-ffmpeg.mjs                    # 当前平台
//   node scripts/fetch-ffmpeg.mjs --url=… --sha256=… # 固定 URL 与哈希（发布前务必固定）
//   node scripts/fetch-ffmpeg.mjs --force            # 已存在也重新下载
//
// 只支持 Windows：macOS/Linux 的桌面采集走各自的系统后端（ScreenCaptureKit / ffmpeg on PATH）。
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const platform = `${process.platform}-${process.arch}`;
const target = join(root, "bin/ffmpeg", platform, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const DEFAULT_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const args = process.argv.slice(2);
const arg = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = arg("url") ?? process.env.PI_FFMPEG_URL ?? DEFAULT_URL;
const sha256 = arg("sha256") ?? process.env.PI_FFMPEG_SHA256 ?? "";
const force = args.includes("--force");

if (process.platform !== "win32") {
	console.log(`[ffmpeg] ${platform} 不需要随包 ffmpeg（桌面通道只在 Windows 使用 NVENC），跳过。`);
	process.exit(0);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

if (!force && (await exists(target))) {
	console.log(`[ffmpeg] 已存在：${target}`);
	process.exit(0);
}

function run(command, argv, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, { cwd, stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
	});
}

const directory = await mkdtemp(join(tmpdir(), "pi-ffmpeg-"));
try {
	const archive = join(directory, "ffmpeg.zip");
	console.log(`[ffmpeg] 下载 ${url}`);
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
	if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (sha256) {
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== sha256) throw new Error(`SHA-256 不匹配：期望 ${sha256}，实际 ${digest}`);
	} else {
		console.warn(
			`[ffmpeg] 未提供 --sha256，本次未校验下载内容（发布前必须固定哈希）。实际：${createHash("sha256").update(bytes).digest("hex")}`,
		);
	}
	await writeFile(archive, bytes);
	// Windows 10+ 与 macOS 都自带 bsdtar，可以解 zip，不必引入第三方解压依赖。
	await run("tar", ["-xf", archive, "-C", directory]);
	const found = await findBinary(directory);
	if (!found) throw new Error("压缩包里没有找到 ffmpeg 可执行文件");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, await readFile(found), { mode: 0o755 });
	console.log(`[ffmpeg] 已就绪：${target}`);
} finally {
	await rm(directory, { recursive: true, force: true, maxRetries: 2 });
}

async function findBinary(directory) {
	const { readdir } = await import("node:fs/promises");
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await findBinary(full);
			if (nested) return nested;
		} else if (entry.name === "ffmpeg.exe") return full;
	}
	return undefined;
}
