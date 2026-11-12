import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * macOS capture goes through the native interactive `screencapture` tool: the overlay lets the user drag a
 * region (or press space for a single window) and Esc cancels without writing an output file.
 */
export const MAC_SCREENCAPTURE = "/usr/sbin/screencapture";
export const MAC_OSASCRIPT = "/usr/bin/osascript";

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 150_000;
const SCRIPT_TIMEOUT_MS = 10_000;
const HIDE_SETTLE_MS = 400;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function macScreenshotArgs(file: string): string[] {
	return ["-i", "-x", "-t", "png", file];
}

/**
 * Reads the frontmost app, its pid and its front window title.
 * 两个信号任一命中就允许隐藏：窗口标题里的 nonce（浏览器会把 document.title 写进窗口标题），
 * 或者前台应用就是承载本服务端的宿主进程（桌面端 Electron / dev 模式的终端，
 * 它们的窗口标题不跟随 document.title，例如桌面端内嵌浏览器的固定标题）。
 * 窗口标题需要辅助功能授权；读不到时退回「不验证标题、只靠 pid 判定」，两者都不行才报 window-not-focused。
 */
export const MAC_FRONT_APP_SCRIPT = `on run argv
	tell application "System Events"
		set frontProcess to first application process whose frontmost is true
		set processName to name of frontProcess
		set processId to unix id of frontProcess
		set windowTitle to ""
		try
			set windowTitle to name of front window of frontProcess
		end try
	end tell
	return processName & "\\n" & processId & "\\n" & windowTitle
end run`;

export const MAC_PS = "/bin/ps";

/**
 * 从 `ps` 的父子关系表里向上走，得到本服务端进程的所有祖先 pid。
 * 桌面端：Electron 主进程是祖先；dev 模式：终端 App 是祖先。
 */
export async function ancestorPids(signal: AbortSignal): Promise<Set<number>> {
	const result = await runCommand(MAC_PS, ["-A", "-o", "pid=,ppid="], SCRIPT_TIMEOUT_MS, signal).catch(() => null);
	const parents = new Map<number, number>();
	for (const line of (result?.stdout ?? "").split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
	}
	const chain = new Set<number>();
	let current = process.pid;
	for (let depth = 0; depth < 64; depth++) {
		chain.add(current);
		const parent = parents.get(current);
		if (!parent || parent <= 1 || chain.has(parent)) break;
		current = parent;
	}
	return chain;
}

export function macVisibilityScript(visible: boolean): string {
	const action = visible
		? "\t\tset visible of targetProcess to true\n\t\tset frontmost of targetProcess to true"
		: "\t\tset visible of targetProcess to false";
	return `on run argv
	tell application "System Events"
		set targetProcess to application process (item 1 of argv)
${action}
	end tell
end run`;
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };

function runCommand(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			resolve(result);
		};
		const cancel = () => {
			child.kill("SIGTERM");
			finish({ code: null, stdout, stderr, timedOut, aborted: true });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			finish({ code: null, stdout, stderr, timedOut, aborted: false });
		}, timeoutMs);
		signal.addEventListener("abort", cancel, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < 8192) stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-8192);
		});
		child.once("error", (error) => {
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reject(error);
		});
		child.once("close", (code) => finish({ code, stdout, stderr, timedOut, aborted: signal.aborted }));
	});
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hides the frontmost app only when it is provably the app the user is looking at: its front window title
 * carries the nonce the client just set (browsers), or it is the host process that runs this server
 * (desktop Electron / dev terminal, whose window titles do not follow document.title).
 * A focus change during capture can therefore never hide an unrelated application.
 * Returns the app name to restore afterwards.
 */
async function hideFrontmostApp(token: string, signal: AbortSignal): Promise<string | null> {
	const probe = await runCommand(MAC_OSASCRIPT, ["-e", MAC_FRONT_APP_SCRIPT], SCRIPT_TIMEOUT_MS, signal).catch(
		() => null,
	);
	// No Automation/Accessibility approval: keep capturing without hiding instead of failing the request.
	if (!probe || probe.code !== 0) return null;
	const [appName = "", pidLine = "", ...titleLines] = probe.stdout.trim().split("\n");
	if (!appName.trim()) return null;
	const titled = titleLines.join("\n").includes(token);
	if (!titled) {
		const frontPid = Number(pidLine.trim());
		const hosted = Number.isInteger(frontPid) && frontPid > 0 && (await ancestorPids(signal)).has(frontPid);
		if (!hosted) throw new Error("window-not-focused");
	}
	const hide = await runCommand(
		MAC_OSASCRIPT,
		["-e", macVisibilityScript(false), appName],
		SCRIPT_TIMEOUT_MS,
		signal,
	).catch(() => null);
	if (!hide || hide.code !== 0) return null;
	await delay(HIDE_SETTLE_MS);
	return appName;
}

async function restoreApp(appName: string): Promise<void> {
	await runCommand(
		MAC_OSASCRIPT,
		["-e", macVisibilityScript(true), appName],
		SCRIPT_TIMEOUT_MS,
		new AbortController().signal,
	).catch(() => undefined);
}

async function readCapture(file: string): Promise<Buffer | null> {
	const data = await readFile(file).catch(() => null);
	if (!data || data.length === 0 || data.length > MAX_IMAGE_BYTES) return null;
	if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("capture-failed");
	return data;
}

export async function captureMacScreenshot(
	token: string,
	_locale: "zh" | "en",
	signal: AbortSignal,
	hideWindow = true,
): Promise<string | null> {
	if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("invalid screenshot token");
	if (signal.aborted) return null;
	let hiddenApp: string | null = null;
	if (hideWindow) hiddenApp = await hideFrontmostApp(token, signal);
	const dir = await mkdtemp(join(tmpdir(), "pi-web-ui-shot-"));
	const file = join(dir, "capture.png");
	try {
		const result = await runCommand(MAC_SCREENCAPTURE, macScreenshotArgs(file), CAPTURE_TIMEOUT_MS, signal);
		if (result.timedOut) throw new Error("screenshot-timeout");
		if (result.aborted) return null;
		const png = await readCapture(file);
		return png ? `data:image/png;base64,${png.toString("base64")}` : null;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		if (hiddenApp) await restoreApp(hiddenApp);
	}
}
