import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionListInfo } from "../server/session-list-scan.ts";

const targetMb = Number(process.argv[2] ?? 10);

import { createReadStream } from "node:fs";
class LegacyFilter {
	inString = false;
	escaped = false;
	token = "";
	dataKey = false;
	awaitingValue = false;
	discard = false;
	push(chunk) {
		const output = [];
		for (const char of chunk) {
			if (char === "\n") {
				this.inString = false;
				this.escaped = false;
				this.discard = false;
			}
			if (this.inString) {
				if (!this.discard) output.push(char);
				if (this.escaped) {
					this.escaped = false;
					if (this.token.length < 16) this.token += char;
				} else if (char === "\\") {
					this.escaped = true;
					if (this.token.length < 16) this.token += char;
				} else if (char === '"') {
					this.inString = false;
					if (this.discard) output.push(char);
					try {
						this.dataKey = JSON.parse('"' + this.token + '"') === "data";
					} catch {
						this.dataKey = false;
					}
					this.discard = false;
				} else if (this.token.length < 16) this.token += char;
				continue;
			}
			output.push(char);
			if (char === '"') {
				this.inString = true;
				this.token = "";
				this.discard = this.awaitingValue;
				this.awaitingValue = false;
				this.dataKey = false;
			} else if (!/\s/.test(char)) {
				this.awaitingValue = char === ":" && this.dataKey;
				this.dataKey = false;
			}
			if (char === "\n") {
				this.dataKey = false;
				this.awaitingValue = false;
			}
		}
		return output.join("");
	}
}
async function legacyListParse(file) {
	const input = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
	const filter = new LegacyFilter();
	let pending = "";
	let id = "";
	let first = "";
	let count = 0;
	const onLine = (line) => {
		if (!line.trim()) return;
		if (id && first && line.length > 512 && !line.includes('"session_info"')) {
			if (/"type"\s*:\s*"message"/.test(line.slice(0, 140))) {
				count++;
				/"timestamp"\s*:\s*(\d{10,16})/.exec(line);
			}
			return;
		}
		try {
			const rec = JSON.parse(line);
			if (rec.type === "session") id = rec.id;
			else if (rec.type === "message") {
				count++;
				if (!first && rec.message?.role === "user") first = "x";
			}
		} catch {}
	};
	for await (const chunk of input) {
		const text = filter.push(chunk);
		let start = 0;
		let end;
		while ((end = text.indexOf("\n", start)) !== -1) {
			onLine(pending + text.slice(start, end));
			pending = "";
			start = end + 1;
		}
		pending += text.slice(start);
	}
	if (pending) onLine(pending);
	return count;
}

function turn(i) {
	const call = `call-${i}`;
	return [
		{
			type: "message",
			id: `u${i}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: 1700000000000 + i },
		},
		{
			type: "message",
			id: `a${i}`,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "thinking ".repeat(40) },
					{ type: "toolCall", id: call, name: "bash", arguments: { cmd: "ls" } },
				],
				timestamp: 1700000000001 + i,
			},
		},
		{
			type: "message",
			id: `r${i}`,
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: call,
				toolName: "bash",
				content: [
					{ type: "text", text: "output line\n".repeat(400) },
					...(i % 10 === 0 ? [{ type: "image", mimeType: "image/png", data: "QUJD".repeat(20000) }] : []),
				],
				timestamp: 1700000000002 + i,
			},
		},
	]
		.map((e) => JSON.stringify(e))
		.join("\n");
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

const dir = mkdtempSync(join(tmpdir(), "bench-list-"));
try {
	const file = join(dir, "s.jsonl");
	const parts = [JSON.stringify({ type: "session", id: "bench", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" })];
	let bytes = 0;
	let i = 0;
	while (bytes < targetMb * 1024 * 1024) {
		const t = turn(i++);
		parts.push(t);
		bytes += t.length + 1;
	}
	writeFileSync(file, `${parts.join("\n")}\n`);
	const runs = 5;
	const t = { legacy: [], full: [], inc: [] };
	for (let k = 0; k < runs; k++) {
		let s = performance.now();
		await legacyListParse(file);
		t.legacy.push(performance.now() - s);
		s = performance.now();
		const r = await scanSessionListInfo(file, 0);
		t.full.push(performance.now() - s);
		appendFileSync(file, `${turn(100000 + k)}\n`);
		s = performance.now();
		await scanSessionListInfo(file, 0, r.state);
		t.inc.push(performance.now() - s);
	}
	console.log(`synthetic transcript: ${targetMb} MB, node ${process.version}; median of ${runs} runs (ms):`);
	console.log(`  legacy (char filter + string lines)   ${median(t.legacy).toFixed(1)}`);
	console.log(`  byte-level full scan                  ${median(t.full).toFixed(1)}`);
	console.log(`  incremental after one appended turn   ${median(t.inc).toFixed(2)}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
