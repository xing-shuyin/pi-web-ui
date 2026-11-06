import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ASSETS = {
	win32: { name: "uv-x86_64-pc-windows-msvc.zip", bin: "uv.exe" },
	darwin: { name: "uv-aarch64-apple-darwin.tar.gz", bin: "uv" },
	linux: { name: "uv-x86_64-unknown-linux-gnu.tar.gz", bin: "uv" },
};

export function findSystemUv() {
	try {
		const r = spawnSync("uv", ["--version"], { encoding: "utf8", windowsHide: true });
		if (r.status === 0 && r.stdout) return "uv";
	} catch {}

	if (process.platform === "win32") {
		const candidates = [
			join(homedir(), ".local", "bin", "uv.exe"),
			join(homedir(), ".cargo", "bin", "uv.exe"),
			join(process.env.LOCALAPPDATA || "", "uv", "uv.exe"),
			join(process.env.APPDATA || "", "uv", "uv.exe"),
		];
		for (const c of candidates) {
			if (existsSync(c)) {
				try {
					const r = spawnSync(c, ["--version"], { encoding: "utf8", windowsHide: true });
					if (r.status === 0) return c;
				} catch {}
			}
		}

		try {
			const r = spawnSync("where.exe", ["uv"], { encoding: "utf8", windowsHide: true });
			if (r.status === 0 && r.stdout) {
				const first = r.stdout.split(/\r?\n/)[0]?.trim();
				if (first && existsSync(first)) return first;
			}
		} catch {}
	} else {
		const candidates = [
			join(homedir(), ".local", "bin", "uv"),
			join(homedir(), ".cargo", "bin", "uv"),
			"/usr/local/bin/uv",
			"/usr/bin/uv",
		];
		for (const c of candidates) {
			if (existsSync(c)) {
				try {
					const r = spawnSync(c, ["--version"], { encoding: "utf8" });
					if (r.status === 0) return c;
				} catch {}
			}
		}
	}
	return null;
}

export function findSystemPython() {
	for (const cmd of ["python3", "python", "py"]) {
		try {
			const r = spawnSync(cmd, ["--version"], { encoding: "utf8", windowsHide: true });
			if (r.status === 0) return cmd;
		} catch {}
	}
	return null;
}

function sha256Of(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function findBin(name, dir) {
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			const hit = findBin(name, p);
			if (hit) return hit;
		} else if (e.name === name) return p;
	}
	return null;
}

export function extractArchive(binName, archive, into) {
	mkdirSync(into, { recursive: true });
	const attempts = [
		["tar", ["-xf", archive, "-C", into]],
		["unzip", ["-o", archive, "-d", into]],
	];
	for (const [cmd, args] of attempts) {
		try {
			const r = spawnSync(cmd, args, { stdio: "ignore" });
			if (r.status === 0) {
				const hit = findBin(binName, into);
				if (hit) return hit;
			}
		} catch {}
	}
	return null;
}

export async function ensureUv({ dir, log = () => {} }) {
	const sysUv = findSystemUv();
	if (sysUv) {
		log(`检测到系统已就绪的 uv：${sysUv}`);
		return sysUv;
	}

	const a = ASSETS[process.platform] || ASSETS.linux;
	const target = join(dir, a.bin);
	if (existsSync(target)) {
		log(`使用插件目录已存在的 uv：${target}`);
		return target;
	}

	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, "_tmp");
	mkdirSync(tmp, { recursive: true });

	const asset = `https://github.com/astral-sh/uv/releases/latest/download/${a.name}`;
	const sources = [
		{ label: "GitHub 加速代理 ghproxy.net", url: `https://ghproxy.net/${asset}`, file: join(tmp, a.name) },
		{ label: "GitHub 加速代理 gh-proxy.com", url: `https://gh-proxy.com/${asset}`, file: join(tmp, a.name) },
		{ label: "GitHub 直连", url: asset, file: join(tmp, a.name) },
	];

	if (process.platform === "win32") {
		try {
			const r = await fetch("https://mirrors.aliyun.com/pypi/simple/uv/");
		} catch {}
	}

	for (const s of sources) {
		log(`尝试从 ${s.label} 获取 uv...`);
		try {
			mkdirSync(dirname(s.file), { recursive: true });
			const res = await fetch(s.url, { signal: AbortSignal.timeout(30000) });
			if (!res.ok) {
				log(`  └─ HTTP ${res.status}`);
				continue;
			}
			const out = createWriteStream(s.file);
			await pipeline(Readable.fromWeb(res.body), out);

			const hit = extractArchive(a.bin, s.file, dir);
			if (hit && existsSync(hit)) {
				try {
					rmSync(tmp, { recursive: true, force: true });
				} catch {}
				log(`✅ uv 下载并解压就绪：${hit}`);
				return hit;
			}
		} catch (err) {
			log(`  └─ 获取异常: ${err.message}`);
		}
	}

	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {}
	return null;
}
