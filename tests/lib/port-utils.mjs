import { createConnection } from "node:net";
import { execSync } from "node:child_process";

export function portUp(port, host = "127.0.0.1", timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host });
		const done = (v) => {
			socket.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			done(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			done(false);
		});
	});
}

export function freePort(port) {
	try {
		if (process.platform === "win32") {
			const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr ":${port} "`, {
				stdio: ["ignore", "pipe", "ignore"],
			}).toString();
			const pids = new Set(
				out
					.split("\n")
					.map((line) => line.trim().split(/\s+/).pop())
					.filter((pid) => /^\d+$/.test(pid)),
			);
			for (const pid of pids) {
				if (pid !== String(process.pid)) {
					try {
						execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
					} catch {}
				}
			}
		} else {
			execSync(`lsof -ti :${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
				stdio: "ignore",
				shell: "/bin/bash",
			});
		}
	} catch {}
}
