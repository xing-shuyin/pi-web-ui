import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomicSync } from "./atomic-file.js";

const BUSYBOX_URL = "https://frippery.org/files/busybox/busybox64u.exe";
const MIN_SIZE = 500_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export function windowsBashDir(): string {
	return join(homedir(), ".pi-web", "bin");
}

export function windowsBashPath(): string {
	return join(windowsBashDir(), "bash.exe");
}

export function hasGitBash(): boolean {
	const pf = process.env.ProgramFiles;
	const pf86 = process.env["ProgramFiles(x86)"];
	for (const cand of [
		process.env.PI_WEB_SHELL ?? "",
		process.env.SHELL ?? "",
		pf ? join(pf, "Git", "bin", "bash.exe") : "",
		pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
	]) {
		if (cand && existsSync(cand) && cand.toLowerCase().includes("bash")) return true;
	}
	return false;
}

export async function ensureWindowsBash(): Promise<string | null> {
	if (process.platform !== "win32") return null;
	const target = windowsBashPath();
	if (existsSync(target)) return target;
	if (hasGitBash()) return null;
	const dir = windowsBashDir();
	mkdirSync(dir, { recursive: true });
	try {
		const res = await fetch(BUSYBOX_URL, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length < MIN_SIZE) return null;
		writeAtomicSync(join(dir, "busybox.exe"), buf);
		copyFileSync(join(dir, "busybox.exe"), target);
		return target;
	} catch {
		return null;
	}
}
