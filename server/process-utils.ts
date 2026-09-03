/**
 * process-utils — 跨平台进程工具：监听端口快照、进程树查杀、进程名查询。
 * 后台任务面板（bgServers）用它们检测/停止 agent 在后台拉起的服务。
 * 从 agent-service.ts 抽出，行为保持不变。全平台 best-effort：失败静默。
 */

/**
 * Snapshot currently LISTENING TCP ports → owning pid. Windows: netstat;
 * POSIX: lsof. Used to detect servers the agent started in the background
 * (the bash tool itself exits, leaving e.g. `npm run dev &` listening).
 */
export async function snapshotListeningPorts(): Promise<Map<number, number>> {
	const m = new Map<number, number>();
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 8000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				// TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 12345
				if (p.length >= 5 && p[0] === "TCP" && p[3] === "LISTENING") {
					const port = Number(p[1].split(":").pop());
					const pid = Number(p[4]);
					if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
				}
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeout: 8000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/).slice(1)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 9) {
					// NAME column tail: "*:5173 (LISTEN)" or "[::1]:5173 (LISTEN)"
					const mm = (p[p.length - 1] ?? "").match(/(\d+)\)?\s*$/);
					const port = mm ? Number(mm[1]) : NaN;
					const pid = Number(p[1]);
					if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
				}
			}
		}
	} catch {
		// best effort — snapshot failure just means no tracking this round
	}
	return m;
}

/** Kill a pid and its whole process tree (cross-platform). */
export function killPidTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			void import("node:child_process").then(({ spawn }) => {
				spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				}).unref();
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
}

/** Best-effort full command line of a pid (PowerShell CIM on win32 — wmic is
 *  gone on recent Win11 builds; ps -o command= on POSIX). Returns undefined
 *  when the process is gone or the lookup fails. */
export async function lookupProcessCommandLine(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			// CIM query is slower (~1s) than tasklist but this is a one-shot
			// best-effort probe fired once per detected background server.
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			const line = out.trim();
			return line || undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const line = out.trim();
		return line || undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort process name for a pid (tasklist on win32, ps on POSIX).
 *  Returns undefined when the process is gone or the lookup fails. */
export async function lookupProcessName(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"tasklist",
					["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
					{ windowsHide: true, timeout: 4000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			// CSV: "node.exe","12345",...
			const m = out.match(/"([^"]+)"/);
			return m ? m[1] : undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const name = out.trim();
		return name || undefined;
	} catch {
		return undefined;
	}
}
