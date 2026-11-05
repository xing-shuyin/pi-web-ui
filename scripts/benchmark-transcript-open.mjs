// 打开历史会话前的转录预处理基准：原流程（链修复 + 悬空检查各自同步整读，悬空检查逐行完整 JSON.parse）
// 对比新流程（一次异步读 + 按需解析）。仅使用合成数据，不读取用户历史、不启动服务。
// 用法：node --import tsx scripts/benchmark-transcript-open.mjs [MB]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairSessionTranscript } from "../server/compaction-markers.ts";
import {
	findDanglingToolCalls,
	healDanglingToolCallsInText,
	tailAssistantToolCallIds,
} from "../server/dangling-tools.ts";
import { prepareTranscriptForOpen } from "../server/transcript-prepare.ts";

const targetMb = Number(process.argv[2] ?? 10);

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

function legacy(file) {
	// 原 repairSessionFile（首次，无缓存）+ 原 healDanglingToolCallFile（无缓存，逐行完整解析）
	const raw1 = readFileSync(file, "utf8");
	repairSessionTranscript(raw1);
	const raw2 = readFileSync(file, "utf8");
	const entries = [];
	let lastId = null;
	for (const line of raw2.split("\n")) {
		if (!line.trim()) continue;
		try {
			const p = JSON.parse(line);
			entries.push(p);
			if (typeof p?.id === "string") lastId = p.id;
		} catch {}
	}
	const tail = tailAssistantToolCallIds(entries, lastId);
	if (tail.size) findDanglingToolCalls(entries);
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

const dir = mkdtempSync(join(tmpdir(), "bench-open-"));
try {
	const file = join(dir, "s.jsonl");
	const text = build();
	writeFileSync(file, text);
	const runs = 7;
	const t = { legacy: [], newCold: [], newWarm: [], healOnly: [], healLegacy: [] };
	for (let k = 0; k < runs; k++) {
		let s = performance.now();
		legacy(file);
		t.legacy.push(performance.now() - s);

		// 冷：每轮改写 mtime 让两份指纹都失效
		writeFileSync(file, text);
		s = performance.now();
		await prepareTranscriptForOpen(file);
		t.newCold.push(performance.now() - s);

		s = performance.now();
		await prepareTranscriptForOpen(file);
		t.newWarm.push(performance.now() - s);

		s = performance.now();
		healDanglingToolCallsInText(file, text);
		t.healOnly.push(performance.now() - s);

		s = performance.now();
		const entries = [];
		let lastId = null;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const p = JSON.parse(line);
				entries.push(p);
				if (typeof p?.id === "string") lastId = p.id;
			} catch {}
		}
		tailAssistantToolCallIds(entries, lastId);
		t.healLegacy.push(performance.now() - s);
	}
	console.log(
		`synthetic transcript: ${(text.length / 1024 / 1024).toFixed(1)} MB, ${text.split("\n").length - 1} lines, node ${process.version}`,
	);
	console.log(`median of ${runs} runs (ms):`);
	console.log(`  dangling check, legacy full parse     ${median(t.healLegacy).toFixed(1)}`);
	console.log(`  dangling check, lazy (new)            ${median(t.healOnly).toFixed(1)}`);
	console.log(`  open pre-check, legacy (2 sync reads) ${median(t.legacy).toFixed(1)}`);
	console.log(`  open pre-check, new cold (1 async)    ${median(t.newCold).toFixed(1)}`);
	console.log(`  open pre-check, new warm (sig hit)    ${median(t.newWarm).toFixed(2)}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
