import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairSessionTranscript } from "../server/compaction-markers.ts";
import { healDanglingToolCallsInText, probeTailDangling } from "../server/dangling-tools.ts";
import { prepareTranscriptForOpen } from "../server/transcript-prepare.ts";
import { scanTranscriptForRepair } from "../server/transcript-scan.ts";

const targetMb = Number(process.argv[2] ?? 50);

function build() {
	const lines = [JSON.stringify({ type: "session", id: "bench", cwd: "/tmp" })];
	let parent = null;
	let i = 0;
	let bytes = 0;
	while (bytes < targetMb * 1024 * 1024) {
		const call = `call-${i}`;
		const u = {
			type: "message",
			id: `u${i}`,
			parentId: parent,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `question ${i}` }] },
		};
		const a = {
			type: "message",
			id: `a${i}`,
			parentId: u.id,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "thinking ".repeat(40) },
					{ type: "toolCall", id: call, name: "bash", arguments: { cmd: "ls" } },
				],
			},
		};
		const r = {
			type: "message",
			id: `r${i}`,
			parentId: a.id,
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: call,
				toolName: "bash",
				content: [{ type: "text", text: "output line\n".repeat(400) }],
				isError: false,
			},
		};
		const f = {
			type: "message",
			id: `f${i}`,
			parentId: r.id,
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done ".repeat(60) }] },
		};
		for (const e of [u, a, r, f]) {
			const s = JSON.stringify(e);
			lines.push(s);
			bytes += s.length + 1;
		}
		parent = f.id;
		i++;
	}
	return `${lines.join("\n")}\n`;
}

/** 旧冷路径：整份 readFile 一次，修复与悬空检查共用同一份文本 */
function legacyPrepare(file) {
	const raw = readFileSync(file, "utf8");
	if (repairSessionTranscript(raw).changed) return;
	healDanglingToolCallsInText(file, raw);
}

/** 用 1ms 定时器测最长事件循环停顿（同步段无法插入 tick，等效于整段时长） */
async function maxStall(fn) {
	let last = performance.now();
	let max = 0;
	let running = true;
	const tick = () => {
		const now = performance.now();
		max = Math.max(max, now - last);
		last = now;
		if (running) setTimeout(tick, 1);
	};
	const timer = setTimeout(tick, 1);
	await fn();
	running = false;
	clearTimeout(timer);
	return Math.max(max, performance.now() - last);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const heapMb = () => process.memoryUsage().heapUsed / 1048576;

const dir = mkdtempSync(join(tmpdir(), "bench-open-"));
try {
	const file = join(dir, "s.jsonl");
	const text = build();
	writeFileSync(file, text);
	const runs = 7;
	let coldPath = "?";
	const t = {
		legacy: [],
		cold: [],
		warm: [],
		scan: [],
		tail: [],
		heapLegacy: [],
		heapCold: [],
		keepLegacy: [],
		keepCold: [],
		stallLegacy: [],
		stallCold: [],
	};
	for (let k = 0; k < runs; k++) {
		writeFileSync(file, text);
		global.gc?.();
		const h0 = heapMb();
		let s = performance.now();
		t.stallLegacy.push(await maxStall(() => legacyPrepare(file)));
		t.legacy.push(performance.now() - s);
		t.heapLegacy.push(heapMb() - h0);
		global.gc?.();
		t.keepLegacy.push(heapMb() - h0);

		// 每次换文件名，保证走冷路径（进程内健康指纹未命中）
		const coldFile = join(dir, `cold-${k}.jsonl`);
		writeFileSync(coldFile, text);
		global.gc?.();
		const h1 = heapMb();
		s = performance.now();
		t.stallCold.push(
			await maxStall(async () => {
				coldPath = (await prepareTranscriptForOpen(coldFile)).path ?? "?";
			}),
		);
		t.cold.push(performance.now() - s);
		t.heapCold.push(heapMb() - h1);
		global.gc?.();
		t.keepCold.push(heapMb() - h1);

		s = performance.now();
		await prepareTranscriptForOpen(coldFile);
		t.warm.push(performance.now() - s);

		const scanFile = join(dir, `scan-${k}.jsonl`);
		writeFileSync(scanFile, text);
		s = performance.now();
		await scanTranscriptForRepair(scanFile);
		t.scan.push(performance.now() - s);

		s = performance.now();
		await probeTailDangling(scanFile);
		t.tail.push(performance.now() - s);
	}
	console.log(
		`synthetic transcript: ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, ${text.split("\n").length - 1} lines, node ${process.version}`,
	);
	console.log(`median of ${runs} runs:`);
	console.log(
		`  open pre-check, legacy (readFile + repair + heal)  ${median(t.legacy).toFixed(1)} ms, 最长停顿 ${median(t.stallLegacy).toFixed(0)} ms, heap +${median(t.heapLegacy).toFixed(0)} MB`,
	);
	console.log(
		`  open pre-check, new cold (scan + tail, path=${coldPath}) ${median(t.cold).toFixed(1)} ms, 最长停顿 ${median(t.stallCold).toFixed(0)} ms, heap +${median(t.heapCold).toFixed(0)} MB`,
	);
	console.log(`  open pre-check, new warm (sig hit)                 ${median(t.warm).toFixed(2)} ms`);
	console.log(`    ├ 元数据流式扫描                                 ${median(t.scan).toFixed(1)} ms`);
	console.log(`    └ 尾部 256 KB 悬空检查                           ${median(t.tail).toFixed(2)} ms`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
