/**
 * Lightweight bash fallback for Windows.
 *
 * When neither Git Bash nor a bash on PATH exists, download busybox-w32
 * (single self-contained ~1.5MB exe, no installer) into <home>/.pi-web/bin/
 * and expose it as bash.exe — busybox dispatches on argv[0], so `bash.exe`
 * runs its bash (ash) applet. The terminal panel (terminals.ts) and the SDK
 * bash tool (via PATH) then both resolve to it, so the agent never silently
 * falls back to cmd/PowerShell syntax on a bare Windows box.
 *
 * Download is fire-and-forget at server start and never throws: on failure
 * the terminal simply falls back to $COMSPEC (cmd.exe) as before.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Official busybox-w32 64-bit Unicode build (Win10 1903+ / Win11). */
const BUSYBOX_URL = "https://frippery.org/files/busybox/busybox64u.exe";
/** busybox.exe is ~660KB; anything far smaller is an error page, not a binary. */
const MIN_SIZE = 500_000;
/** Download cap — a stalled connection must not block startup forever. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Directory holding the busybox fallback (shared with terminals.ts / PATH). */
export function windowsBashDir(): string {
	return join(homedir(), ".pi-web", "bin");
}

/** bash.exe (busybox bash applet) used by the terminal and the SDK bash tool. */
export function windowsBashPath(): string {
	return join(windowsBashDir(), "bash.exe");
}

/** True when a standard Git Bash install exists (SDK's preferred shell). */
export function hasGitBash(): boolean {
	const pf = process.env.ProgramFiles;
	const pf86 = process.env["ProgramFiles(x86)"];
	for (const cand of [pf ? join(pf, "Git", "bin", "bash.exe") : "", pf86 ? join(pf86, "Git", "bin", "bash.exe") : ""]) {
		if (cand && existsSync(cand)) return true;
	}
	return false;
}

/**
 * Ensure a bash.exe exists on Windows. No-op when Git Bash is already
 * installed (it is strictly preferred) or the fallback is already present.
 * Never throws — failures degrade silently to the previous behaviour.
 *
 * @returns the bash.exe path when ready, null otherwise.
 */
export async function ensureWindowsBash(): Promise<string | null> {
	if (process.platform !== "win32") return null;
	const target = windowsBashPath();
	if (existsSync(target)) return target;
	if (hasGitBash()) return null; // Git Bash preferred — nothing to install.
	const dir = windowsBashDir();
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `busybox-${process.pid}.tmp`);
	try {
		const res = await fetch(BUSYBOX_URL, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length < MIN_SIZE) return null; // error/HTML page, not the exe.
		writeFileSync(tmp, buf);
		renameSync(tmp, join(dir, "busybox.exe"));
		copyFileSync(join(dir, "busybox.exe"), target);
		return target;
	} catch {
		rmSync(tmp, { force: true });
		return null;
	}
}
