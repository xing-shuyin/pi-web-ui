import { resolve } from "node:path";

export function parseNetstatListening(stdout: string): Map<number, number> {
	const m = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const p = line.trim().split(/\s+/);
		if (p.length >= 5 && p[0] === "TCP" && p[3] === "LISTENING") {
			const port = Number(p[1].split(":").pop());
			const pid = Number(p[4]);
			if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
		}
	}
	return m;
}

export function parseLsofListening(stdout: string): Map<number, number> {
	const m = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const p = line.trim().split(/\s+/);
		if (p.length < 5) continue;
		const pid = Number(p[1]);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		const port = findListenPort(p.slice(3));
		if (port === null) continue;
		m.set(port, pid);
	}
	return m;
}

function findListenPort(cols: string[]): number | null {
	for (const col of cols) {
		const mm = col.match(/:(\d{1,5})$/);
		if (!mm) continue;
		const port = Number(mm[1]);
		if (port > 0 && port <= 65535) return port;
	}
	return null;
}

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
			return parseNetstatListening(out);
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeout: 8000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		return parseLsofListening(out);
	} catch {}
	return m;
}

export interface ProcessTreeNode {
	ppid: number;
	name?: string;
}

export interface ProcessDetails {
	pid: number;
	ppid?: number;
	name?: string;
	commandLine?: string;
	createdMs?: number;
}

export async function snapshotProcessTree(): Promise<Map<number, ProcessTreeNode> | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		const m = new Map<number, ProcessTreeNode>();
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId):$($_.ParentProcessId):$($_.Name)" }',
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const firstColon = trimmed.indexOf(":");
				const secondColon = trimmed.indexOf(":", firstColon + 1);
				if (firstColon === -1) continue;
				const pid = Number(trimmed.slice(0, firstColon));
				const ppid = Number(
					secondColon === -1 ? trimmed.slice(firstColon + 1) : trimmed.slice(firstColon + 1, secondColon),
				);
				const name = secondColon === -1 ? undefined : trimmed.slice(secondColon + 1).trim() || undefined;
				if (Number.isFinite(pid) && Number.isFinite(ppid)) {
					m.set(pid, { ppid, ...(name ? { name } : {}) });
				}
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("ps", ["-Ao", "pid=,ppid=,comm="], { timeout: 5000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 2) {
					const pid = Number(p[0]);
					const ppid = Number(p[1]);
					const name = p.slice(2).join(" ").trim() || undefined;
					if (Number.isFinite(pid) && Number.isFinite(ppid)) {
						m.set(pid, { ppid, ...(name ? { name } : {}) });
					}
				}
			}
		}
		return m;
	} catch {
		return undefined;
	}
}

export async function snapshotProcessParents(): Promise<Map<number, number> | undefined> {
	const tree = await snapshotProcessTree();
	if (!tree) return undefined;
	const m = new Map<number, number>();
	for (const [pid, node] of tree) {
		m.set(pid, node.ppid);
	}
	return m;
}

export async function lookupProcessDetailsBatch(pids: number[]): Promise<Map<number, ProcessDetails>> {
	const out = new Map<number, ProcessDetails>();
	const validPids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
	if (validPids.length === 0) return out;

	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const filter = validPids.map((p) => `ProcessId=${p}`).join(" or ");
			const command = [
				`$filter = '${filter}';`,
				`Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {`,
				`    $ts = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 };`,
				`    $cmd = if ($_.CommandLine) { $_.CommandLine -replace "\\r?\\n", " " } else { "" };`,
				`    "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.Name)\`t$ts\`t$cmd"`,
				`}`,
			].join(" ");

			const stdout = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-Command", command],
					{ windowsHide: true, timeout: 8000 },
					(err, res) => (err ? reject(err) : resolve(res)),
				),
			);

			for (const line of stdout.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const parts = trimmed.split("\t");
				if (parts.length >= 3) {
					const pid = Number(parts[0]);
					const ppid = Number(parts[1]);
					const name = parts[2] || undefined;
					const ts = Number(parts[3]);
					const cmd = parts.slice(4).join("\t").trim();
					if (Number.isFinite(pid)) {
						out.set(pid, {
							pid,
							...(Number.isFinite(ppid) ? { ppid } : {}),
							...(name ? { name } : {}),
							...(Number.isFinite(ts) && ts > 0 ? { createdMs: ts } : {}),
							...(cmd ? { commandLine: cmd } : {}),
						});
					}
				}
			}
			return out;
		}

		const stdout = await new Promise<string>((resolve, reject) =>
			execFile(
				"ps",
				["-o", "pid=,ppid=,etimes=,comm=,command=", "-p", validPids.join(",")],
				{ timeout: 5000 },
				(err, res) => (err ? reject(err) : resolve(res)),
			),
		);

		const now = Date.now();
		for (const line of stdout.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
			if (match) {
				const pid = Number(match[1]);
				const ppid = Number(match[2]);
				const etimes = Number(match[3]);
				const name = match[4];
				const commandLine = match[5]?.trim();
				const createdMs = Number.isFinite(etimes) ? now - etimes * 1000 : undefined;
				out.set(pid, {
					pid,
					ppid,
					name,
					...(commandLine ? { commandLine } : {}),
					...(createdMs !== undefined ? { createdMs } : {}),
				});
			}
		}
	} catch {}
	return out;
}

export async function killPidTree(pid: number): Promise<void> {
	if (!(pid > 1 && pid !== process.pid)) return;
	try {
		if (process.platform === "win32") {
			const { spawn } = await import("node:child_process");
			await new Promise<void>((resolve) => {
				const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.once("error", () => resolve());
				killer.once("close", () => resolve());
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {}
}

export async function lookupProcessCommandLine(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
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

export function processTreeKillPlan(
	platform: NodeJS.Platform,
	pid: number | undefined,
):
	| { kind: "taskkill"; cmd: string; args: string[] }
	| { kind: "group-signal"; signal: NodeJS.Signals }
	| { kind: "none" } {
	if (!pid || pid <= 0) return { kind: "none" };
	if (platform === "win32") return { kind: "taskkill", cmd: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
	return { kind: "group-signal", signal: "SIGTERM" };
}

export function resolveCwdTarget(
	raw: string,
	sessionCwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const trimmed = String(raw ?? "").trim();
	if (platform === "win32" && /^[A-Za-z]:$/.test(trimmed)) {
		return `${trimmed.toUpperCase()}\\`;
	}
	return resolve(sessionCwd, trimmed);
}
