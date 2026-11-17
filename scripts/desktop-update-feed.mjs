// scripts/desktop-update-feed.mjs
// 对着本地服务器实机测桌面更新：把某个目录当成 GitHub Release 的替代 feed。
//
// 由来：桌面自更新走 electron-updater 读 `latest*.yml`，要验证「检查 → 下载 → 安装」只能真的
// 有个更高版本可下。发真包会污染 Release，所以给一个测试开关（参考 magpie 的
// MAGPIE_UPDATE_FEED）：桌面壳认 `PI_DESKTOP_UPDATE_FEED`，指向这里起的本地 feed；
// `PI_DESKTOP_UPDATE_MODE=auto` 允许在「解压包 / 无 app-update.yml」的拷贝上强行打开自更新。
//
// 用法（服务要长跑，按仓库规矩用后台任务）：
//   node scripts/desktop-update-feed.mjs --dir release --version 0.121.1 --port 8799
//   # 另一个终端：
//   PI_DESKTOP_UPDATE_MODE=auto PI_DESKTOP_UPDATE_FEED=http://127.0.0.1:8799 <桌面可执行文件>
//
// 产物选择：win 取 `*-setup.exe`（没有就取任意 `*.exe`），mac 取 `*.zip`（Squirrel 用 zip，
// 不用 dmg），linux 取 `*.AppImage`。也可以 `--file <文件名>` 指定。
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** feed 文件名：electron-updater 按平台读不同名字。 */
export function manifestName(platform) {
	if (platform === "darwin" || platform === "mac") return "latest-mac.yml";
	if (platform === "linux") return "latest-linux.yml";
	return "latest.yml";
}

/** electron-builder 的 latest*.yml 就这几行；字段名与 electron-updater 的解析一一对应。 */
export function manifestFor({ version, file, sha512, size, releaseDate = new Date(), releaseNotes }) {
	const when = releaseDate instanceof Date ? releaseDate.toISOString() : String(releaseDate);
	const lines = [
		`version: ${version}`,
		"files:",
		`  - url: ${file}`,
		`    sha512: ${sha512}`,
		`    size: ${size}`,
		`path: ${file}`,
		`sha512: ${sha512}`,
		`releaseDate: '${when}'`,
	];
	if (releaseNotes) lines.push(`releaseNotes: ${JSON.stringify(releaseNotes)}`);
	return `${lines.join("\n")}\n`;
}

export function pickArtifact(dir, platform, explicit) {
	if (explicit) {
		const wanted = join(dir, explicit);
		if (!existsSync(wanted)) throw new Error(`找不到指定产物：${wanted}`);
		return wanted;
	}
	const files = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
	const byExtension = (exts) => files.filter((name) => exts.includes(extname(name).toLowerCase()));
	if (platform === "darwin" || platform === "mac") {
		const zips = byExtension([".zip"]);
		if (!zips.length) throw new Error(`${dir} 里没有 macOS 更新用的 .zip`);
		return join(dir, zips[0]);
	}
	if (platform === "linux") {
		const appImages = byExtension([".appimage"]);
		if (!appImages.length) throw new Error(`${dir} 里没有 .AppImage`);
		return join(dir, appImages[0]);
	}
	const exes = byExtension([".exe"]);
	const setup = exes.find((name) => /setup/i.test(name));
	if (!setup && !exes.length) throw new Error(`${dir} 里没有 Windows 安装包 .exe（便携 zip 不能当更新源）`);
	return join(dir, setup ?? exes[0]);
}

export function sha512Of(file) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha512");
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolveHash(hash.digest("base64")));
	});
}

const MIME = { ".yml": "text/yaml", ".yaml": "text/yaml", ".exe": "application/octet-stream" };

function serve(dir, port, log) {
	const server = createServer((req, res) => {
		const name = basename(decodeURIComponent((req.url ?? "/").split("?")[0]));
		const file = join(dir, name);
		if (!name || !existsSync(file) || !statSync(file).isFile()) {
			log(`404 ${req.url}`);
			res.writeHead(404).end("not found");
			return;
		}
		const size = statSync(file).size;
		log(`200 ${name} (${size} B)`);
		res.writeHead(200, {
			"content-length": String(size),
			"content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
			"accept-ranges": "none",
		});
		createReadStream(file).pipe(res);
	});
	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolveServer(server));
	});
}

async function main(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "1";
		args[key] = value;
	}
	const dir = resolve(args.dir ?? join(repoRoot, "release"));
	const platform = args.platform ?? process.platform;
	const version = String(args.version ?? "").replace(/^v/, "");
	if (!version) throw new Error("缺少 --version（要伪装成哪个版本，例如 0.121.1）");
	const port = Number(args.port ?? 8799);
	const artifact = pickArtifact(dir, platform, args.file);
	const size = statSync(artifact).size;
	const sha512 = await sha512Of(artifact);
	const name = manifestName(platform);
	writeFileSync(
		join(dir, name),
		manifestFor({ version, file: basename(artifact), sha512, size, releaseNotes: args.notes || undefined }),
		"utf8",
	);
	console.log(`[feed] ${name} → ${version} (${basename(artifact)}, ${size} B)`);
	console.log(`[feed] serving ${dir} on http://127.0.0.1:${port}`);
	console.log(`[feed] 启动桌面壳时设：`);
	console.log(`         PI_DESKTOP_UPDATE_MODE=auto`);
	console.log(`         PI_DESKTOP_UPDATE_FEED=http://127.0.0.1:${port}`);
	const server = await serve(dir, port, (line) => console.log(`[feed] ${line}`));
	const stop = () => {
		console.log("[feed] stopping");
		server.close(() => process.exit(0));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`[feed] ${error.message}`);
		process.exit(1);
	});
}

export { main, serve };
