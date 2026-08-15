/**
 * TerminalManager — per-client PTY sessions (node-pty) bridged over the
 * WebSocket protocol, plus the user command list persisted in
 * `<workspaceRoot>/.pi/commands.json`.
 *
 * Each browser client gets its own manager; terminals are shared across that
 * client's tabs (they broadcast through the session's emit). When the last
 * socket for a client detaches, all its PTYs are killed so no orphaned
 * processes survive a closed tab / dropped connection.
 *
 * Commands file format:
 *   { "commands": [ { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" } ] }
 * `${pwd}` inside cwd/command resolves to the agent session's current working
 * directory (the same directory the agent operates in — see set_cwd).
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { CommandDef, ServerMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// .pi/commands.json
// ---------------------------------------------------------------------------

export interface CommandsFile {
	commands: CommandDef[];
}

/** Location of the command list for a project: <workspaceRoot>/.pi/commands.json */
export function commandsFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".pi", "commands.json");
}

/** Expand ${pwd} (and ~) in a cwd/command string against the session's cwd. */
export function expandPwd(input: string, pwd: string): string {
	let out = input.replace(/\$\{pwd\}/g, pwd);
	if (out === "~") return homedir();
	if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	return out;
}

/** Resolve a command's directory: default to the session cwd, expand ${pwd}/~, resolve relative paths. */
export function resolveCommandCwd(
	cwd: string | undefined,
	pwd: string,
): string {
	if (!cwd || cwd.trim() === "") return pwd;
	const expanded = expandPwd(cwd.trim(), pwd);
	return isAbsolute(expanded) ? expanded : resolve(pwd, expanded);
}

/** Read the command list; missing file → empty list; malformed → empty list + warning text. */
export async function loadCommands(
	workspaceRoot: string,
): Promise<{ commands: CommandDef[]; path: string; warning?: string }> {
	const path = commandsFilePath(workspaceRoot);
	const { commands, warning } = await readCommandsFile(path);
	return { commands, path, warning };
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `读取命令文件失败：${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { commands: [], warning: `命令文件不是有效 JSON：${path}` };
	}
	if (Array.isArray(parsed)) {
		// Tolerate a bare array: [{name, command, cwd}]
		return {
			commands: parsed
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) {
		return {
			commands: obj.commands
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	return { commands: [], warning: `命令文件格式不正确：${path}` };
}

/** Persist the command list, creating .pi/ if needed. */
export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
): Promise<{ path: string; error?: string }> {
	const path = commandsFilePath(workspaceRoot);
	try {
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
		return { path };
	} catch (err) {
		return { path, error: `保存命令文件失败：${(err as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

interface TermEntry {
	id: string;
	pty: IPty;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	exited: boolean;
}

const isWindows = process.platform === "win32";

/** `-i` makes bash interactive; cmd.exe / powershell.exe are interactive on their own. */
function bashArgs(shell: string): string[] {
	return /[\\/]bash(\.exe)?$/i.test(shell) ? ["-i"] : [];
}

/**
 * Interactive shell for PTYs.
 * - Windows: prefer bash — it matches the SDK's bash tool, so the agent and
 *   the terminal speak the same shell language (no more PowerShell/bash
 *   混用 that leaves heredocs / `&&` / `<<` hanging or erroring). Order:
 *   1. PI_WEB_SHELL (explicit override)
 *   2. $SHELL when it exists on disk (user launched from a Git Bash session)
 *   3. Git Bash install paths (ProgramFiles / ProgramFiles(x86))
 *   4. busybox-w32 fallback in <home>/.pi-web/bin/bash.exe (ensure-bash.ts
 *      downloads it automatically when 2–3 are absent)
 *   5. $COMSPEC (cmd.exe — always set)
 *   6. powershell.exe (last resort)
 * - POSIX: the user's login shell, falling back to bash.
 * Resolved per terminal spawn (not at module load) so a busybox download that
 * finishes after startup is picked up by the next terminal.
 */
function resolveShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit) return { shell: explicit, args: bashArgs(explicit) };
		const she = process.env.SHELL;
		if (she && existsSync(she)) return { shell: she, args: bashArgs(she) };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: process.env.COMSPEC || "powershell.exe", args: [] };
	}
	return { shell: process.env.SHELL || "bash", args: ["-i"] };
}

/**
 * Environment for spawned shells. System services (launchd/systemd) run with
 * no locale variables, which puts the shell in the C locale: its line editor
 * then renders UTF-8 continuation bytes 0x80–0x9F as C1 control characters
 * (e.g. `�<0091><0098>` for 员), garbling Chinese input in the terminal.
 * Default a UTF-8 locale so multibyte text round-trips.
 */
function shellEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...process.env,
		TERM: "xterm-256color",
	};
	if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
	return env;
}

// ---------------------------------------------------------------------------
// spawn-helper permission repair (node-pty macOS prebuilds)
// ---------------------------------------------------------------------------
// node-pty 1.1.0 publishes its macOS prebuilds with `spawn-helper` lacking the
// execute bit (mode 0644 in the npm tarball), so posix_spawn fails with EACCES
// and node-pty throws the generic "posix_spawnp failed". Locally-built
// copies (build/Release) are fine; every `npm install` that picks the prebuild
// — e.g. `npm i -g pi-web-ui`, which is what system-service installs run — is
// broken until the bit is restored. Self-heal at startup AND lazily before
// every spawn (an `npm i -g` while the server is running replaces the helper
// under the running process, so the startup-only repair misses it).
// Best-effort: a read-only node_modules just keeps the old failure.

const require = createRequire(import.meta.url);

/** Absolute paths of every node-pty spawn-helper this install can exec. */
function spawnHelperPaths(): string[] {
	try {
		// require.resolve("node-pty") → <pkg>/lib/index.js → package root is two up.
		const pkgDir = dirname(dirname(require.resolve("node-pty")));
		const out: string[] = [];
		const built = join(pkgDir, "build", "Release", "spawn-helper");
		if (existsSync(built)) out.push(built);
		const prebuildsDir = join(pkgDir, "prebuilds");
		if (existsSync(prebuildsDir)) {
			for (const entry of readdirSync(prebuildsDir)) {
				const p = join(prebuildsDir, entry, "spawn-helper");
				if (existsSync(p)) out.push(p);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Restore the +x bit on node-pty's spawn-helper binaries (idempotent). */
function repairSpawnHelperPermissions(): void {
	if (isWindows) return;
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
		} catch {
			// best-effort; a read-only node_modules just keeps the old failure
		}
	}
}
repairSpawnHelperPermissions();

/** Path of a still-broken helper, for the error hint ("" when none). */
function brokenSpawnHelper(): string {
	if (isWindows) return "";
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) return p;
		} catch {
			// ignore
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// macOS TCC camera/mic warning (launchd-spawned servers)
// ---------------------------------------------------------------------------
// TCC attributes camera/mic access to the process chain's "responsible
// process". When pi-web-ui runs as a launchd LaunchAgent (node ← launchd),
// the responsible process is node itself — a bare CLI binary with no app
// bundle / Info.plist / NSCameraUsageDescription — so TCC silently denies
// camera access (no prompt, nothing to tick in System Settings) and
// ffmpeg-style grabbers hang on frame capture. The identical command works
// from a terminal app that already holds the camera grant. Detect the
// "no GUI ancestor" case (ppid === 1 on macOS) and warn in the terminal.
const TCC_HINT = [
	"\x1b[33m[提示] 本终端由后台服务（launchd）启动，macOS 隐私权限（相机/麦克风/屏幕录制等）对此类进程不可用。\x1b[0m",
	"\x1b[90m  · 需要隐私权限的命令会被系统静默拒绝：不弹授权窗，系统设置里也无法勾选，表现多为卡死或无输出。",
	"  · 这类任务请在你自己已授权的前台终端里运行。",
	"  · 本终端内可运行不需要隐私权限的命令（如文件处理、网络请求、远程设备流）。",
	"  · 若改在前台终端里运行 pi-web-ui，本提示即不再出现。\x1b[0m",
].join("\r\n") + "\r\n";

/** True when this server was spawned by launchd (or orphaned) on macOS — no GUI app in the ancestry, so camera/mic TCC grants are unavailable. */
function launchdSpawnedOnMac(): boolean {
	return process.platform === "darwin" && process.ppid === 1;
}

/**
 * Owns one or more PTYs for a client. All output is forwarded as
 * `terminal_output` messages through the provided emit (broadcast to every
 * socket of the client). Returns false from create/runCommand when the spawn
 * failed (an error notice + terminal_exit are emitted instead).
 */
export class TerminalManager {
	private terms = new Map<string, TermEntry>();
	private seq = 0;
	private tccHintShown = false;

	constructor(private emit: (msg: ServerMessage) => void) {}

	/** Start a plain interactive shell in the given directory. */
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
	): void {
		if (this.terms.has(id)) return;
		if (this.spawnShell(id, cwd || fallbackCwd, cols, rows, `终端 ${++this.seq}`)) {
			this.maybeEmitTccHint(id);
		}
	}

	/** Warn about unavailable camera/mic TCC grants in a fresh terminal, once per client. */
	private maybeEmitTccHint(id: string): void {
		if (this.tccHintShown || !launchdSpawnedOnMac()) return;
		this.tccHintShown = true;
		this.writeOut(id, TCC_HINT);
	}

	/**
	 * Start a shell in the command's directory and run the command in it.
	 *
	 * If a terminal with this id already exists it is RESTARTED in place: the
	 * running process is killed and a fresh shell runs the command again in the
	 * same terminal (used when re-running a command by clicking its entry).
	 */
	runCommand(
		id: string,
		def: CommandDef,
		cols: number,
		rows: number,
		pwd: string,
	): void {
		const dir = resolveCommandCwd(def.cwd, pwd);
		const command = expandPwd(def.command.trim(), pwd);
		const title = def.name || command || `终端 ${++this.seq}`;

		const existing = this.terms.get(id);
		if (existing) {
			// Re-run in place: interrupt the current process (kill the PTY's
			// process group) and start a fresh shell with the same id. Keep the
			// last known size so the replacement matches the xterm's dimensions.
			if (!existing.exited) {
				existing.exited = true;
				try {
					existing.pty.kill();
				} catch {
					// already dead
				}
			}
			cols = existing.cols || cols;
			rows = existing.rows || rows;
			this.terms.delete(id);
		}

		const ok = this.spawnShell(id, dir, cols, rows, title);
		if (!ok) return;
		// Clear the previous run's output, then show a banner and run the command
		// (the PTY input buffer holds it until the shell is ready).
		this.writeOut(id, "\x1b[2J\x1b[3J\x1b[H");
		this.writeOut(
			id,
			`\x1b[90m> ${command}\x1b[0m  \x1b[90m(${dir})\x1b[0m\r\n`,
		);
		this.maybeEmitTccHint(id);
		if (command) this.input(id, command + "\r");
	}

	/** Spawn the user's shell as a PTY. Returns false when the spawn failed. */
	private spawnShell(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
	): boolean {
		let abs = cwd;
		if (!abs) abs = homedir();
		else if (!isAbsolute(abs)) abs = resolve(abs);
		if (!existsSync(abs)) {
			this.fail(id, `目录不存在：${abs}`);
			return false;
		}
		// node-pty's spawn-helper may have lost its +x bit since the last repair
		// (e.g. a global npm install replaced the helper while this server runs).
		repairSpawnHelperPermissions();
		let pty: IPty;
		try {
			const { shell, args } = resolveShell();
			pty = spawn(shell, args, {
				name: "xterm-256color",
				cols: Math.max(2, Math.floor(cols) || 80),
				rows: Math.max(2, Math.floor(rows) || 24),
				cwd: abs,
				env: shellEnv(),
			});
		} catch (err) {
			const helper = brokenSpawnHelper();
			this.fail(
				id,
				helper
					? `启动终端失败：${(err as Error).message}（node-pty 的 spawn-helper 缺少执行权限，请运行：chmod +x "${helper}"）`
					: `启动终端失败：${(err as Error).message}`,
			);
			return false;
		}
		const entry: TermEntry = {
			id,
			pty,
			title,
			cwd: abs,
			cols: Math.max(2, Math.floor(cols) || 80),
			rows: Math.max(2, Math.floor(rows) || 24),
			exited: false,
		};
		this.terms.set(id, entry);
		// The closures capture `entry`: after a restart the map points at the
		// replacement, so a late event from the OLD pty must be ignored.
		pty.onData((data) => {
			if (this.terms.get(id) !== entry) return;
			this.writeOut(id, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry) return;
			this.exit(id, exitCode);
		});
		return true;
	}

	private writeOut(id: string, data: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	/** Emit a terminal failure (bad cwd, spawn error) and mark the terminal dead. */
	private fail(id: string, text: string): void {
		this.emit({ type: "notice", level: "error", text });
		this.emit({
			type: "terminal_output",
			terminalId: id,
			data: `\x1b[91m${text}\x1b[0m\r\n`,
		});
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}

	private exit(id: string, exitCode: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.exited = true;
		this.writeOut(
			id,
			`\r\n\x1b[90m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`,
		);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode });
	}

	input(id: string, data: string): void {
		const entry = this.terms.get(id);
		if (entry && !entry.exited) entry.pty.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		try {
			entry.pty.resize(
				Math.max(2, Math.floor(cols) || 80),
				Math.max(2, Math.floor(rows) || 24),
			);
			// Remember the size so an in-place restart spawns at the same dims.
			entry.cols = Math.max(2, Math.floor(cols) || 80);
			entry.rows = Math.max(2, Math.floor(rows) || 24);
		} catch {
			// PTY already gone — nothing to do.
		}
	}

	/** Kill one terminal (tab closed). The exit event is emitted by node-pty. */
	kill(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.exited = true;
		try {
			entry.pty.kill();
		} catch {
			// already dead
		}
		this.terms.delete(id);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}

	/** Kill every terminal of this client (disconnect / dispose). */
	killAll(): void {
		for (const entry of this.terms.values()) {
			if (entry.exited) continue;
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
		}
		this.terms.clear();
	}
}
