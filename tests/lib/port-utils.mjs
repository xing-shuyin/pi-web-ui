import { createConnection } from "node:net";
import { killTree, portHolders } from "./process-cleanup.mjs";

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

/**
 * 把某个端口的监听者杀掉（用例 `finally` 里的清场口）。
 *
 * 实现只有一份：`tests/lib/process-cleanup.mjs`（Windows 必须 `taskkill /T` 连子进程一起，
 * 否则 server 自己 spawn 的子进程会留着继续占端口）。这里保留旧签名，只是转调。
 */
export function freePort(port) {
	for (const pid of portHolders(port)) {
		if (pid !== process.pid) killTree(pid);
	}
}
