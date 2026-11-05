// 打开历史会话的事件循环阻塞基准：SDK SessionManager.open（同步读 + 同步全量解析）对比
// openSessionManagerAsync（异步读 + 分时片解析）。指标是「解析期间事件循环最长停顿」——
// 也就是其他客户端的 WebSocket 消息最多要等多久——以及总耗时。仅使用合成数据。
// 用法：node --import tsx scripts/benchmark-session-open.mjs [MB]
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openSessionManagerAsync } from "../server/session-open.ts";

const targetMb = Number(process.argv[2] ?? 50);

function build() {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "0191a07a-32d0-7208-b133-cf7870ab850e",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		}),
	];
	let parent = null;
	let bytes = 0;
	for (let i = 0; bytes < targetMb * 1024 * 1024; i++) {
		const e = {
			type: "message",
			id: `m${i}`,
			parentId: parent,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: i % 2 ? "assistant" : "user",
				content: [{ type: "text", text: "lorem ipsum ".repeat(150) }],
				timestamp: i,
			},
		};
		const s = JSON.stringify(e);
		lines.push(s);
		bytes += s.length + 1;
		parent = e.id;
	}
	return `${lines.join("\n")}\n`;
}

/** 在 fn 运行期间用 setImmediate 链测量事件循环最长停顿。 */
async function measure(fn) {
	let maxGap = 0;
	let last = performance.now();
	let running = true;
	const tick = () => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	await new Promise((r) => setImmediate(r));
	const start = performance.now();
	last = start;
	await fn();
	const total = performance.now() - start;
	// 同步阻塞的 fn 结束后，停顿要等下一次 tick 才被观测到
	await new Promise((r) => setImmediate(r));
	running = false;
	return { total, maxGap };
}

const dir = mkdtempSync(join(tmpdir(), "bench-open-sdk-"));
try {
	const src = join(dir, "src.jsonl");
	writeFileSync(src, build());
	const res = { sync: [], async: [] };
	for (let k = 0; k < 3; k++) {
		const a = join(dir, `a${k}.jsonl`);
		const b = join(dir, `b${k}.jsonl`);
		copyFileSync(src, a);
		copyFileSync(src, b);
		res.sync.push(await measure(async () => SessionManager.open(a)));
		res.async.push(await measure(() => openSessionManagerAsync(b)));
	}
	const med = (xs, k) => [...xs].map((x) => x[k]).sort((p, q) => p - q)[Math.floor(xs.length / 2)];
	console.log(`synthetic transcript: ${targetMb} MB, node ${process.version}; median of 3 runs (ms):`);
	console.log(
		`  SessionManager.open       total ${med(res.sync, "total").toFixed(0)}  longest event-loop stall ${med(res.sync, "maxGap").toFixed(0)}`,
	);
	console.log(
		`  openSessionManagerAsync   total ${med(res.async, "total").toFixed(0)}  longest event-loop stall ${med(res.async, "maxGap").toFixed(0)}`,
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
