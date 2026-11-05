/** B3：BinaryStringFilter 的跳跃式实现与原逐字符实现逐字节等价（含任意分块边界）。 */
import { describe, expect, it } from "vitest";
import { BinaryStringFilter } from "../../server/session-scan.js";

/** 原实现（逐字符），原样保留作为差分基准。 */
class LegacyBinaryStringFilter {
	private inString = false;
	private escaped = false;
	private token = "";
	private dataKey = false;
	private awaitingValue = false;
	private discard = false;

	push(chunk: string): string {
		const output: string[] = [];
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

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomRecord(r: () => number): string {
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	const text = () =>
		Array.from({ length: Math.floor(r() * 12) }, () =>
			pick(["a", " ", '\\"', "\\\\", "\\n", "data", '"', ":", "中", "😀", "\t", "\\u0064ata", "{", "}"]),
		).join("");
	const value = () =>
		pick([
			() => JSON.stringify(text()),
			() => `"${"QUJD".repeat(Math.floor(r() * 50))}"`,
			() => String(Math.floor(r() * 1e6)),
			() => "null",
			() => `{"data": ${JSON.stringify(text())}}`,
		])();
	const keys = ["data", "text", "type", "d\\u0061ta", "id", "dat", "datas", "x"];
	const fields = Array.from({ length: 1 + Math.floor(r() * 5) }, () => {
		const k = pick(keys);
		const sp = pick(["", " ", "  ", "\t"]);
		return `"${k}"${sp}:${sp}${value()}`;
	});
	let line = `{${fields.join(",")}}`;
	// 偶尔制造畸形行（字符串内换行、未闭合引号）
	if (r() < 0.1) line = line.slice(0, Math.floor(r() * line.length));
	return line;
}

function runFilter(F: new () => { push(s: string): string }, chunks: string[]): string {
	const f = new F();
	return chunks.map((c) => f.push(c)).join("");
}

describe("BinaryStringFilter（跳跃式实现）", () => {
	it("典型输入：丢弃 data 字符串值，保留其余文本", () => {
		const line = '{"type":"image","data":"AAAA\\"BBB","text":"keep \\"data\\": x","nested":{"data":"ZZZ"}}\n';
		expect(new BinaryStringFilter().push(line)).toBe(
			'{"type":"image","data":"","text":"keep \\"data\\": x","nested":{"data":""}}\n',
		);
	});

	it("2000 个随机 JSONL 文本、随机分块：与原逐字符实现输出完全一致", () => {
		let discarded = 0;
		for (let seed = 1; seed <= 2000; seed++) {
			const r = rng(seed);
			const input = Array.from({ length: 1 + Math.floor(r() * 6) }, () => randomRecord(r)).join(
				r() < 0.5 ? "\n" : "\r\n",
			);
			// 随机切块（包括切在转义符、引号、代理对中间）
			const chunks: string[] = [];
			let i = 0;
			while (i < input.length) {
				const len = 1 + Math.floor(r() * 40);
				chunks.push(input.slice(i, i + len));
				i += len;
			}
			const expected = runFilter(LegacyBinaryStringFilter, chunks);
			const got = runFilter(BinaryStringFilter, chunks);
			if (expected.length < input.length) discarded++;
			if (got !== expected) {
				expect({ seed, input, got }).toEqual({ seed, input, got: expected });
			}
		}
		// 样本里必须有大量真正发生丢弃的输入，等价性检验才有意义
		expect(discarded).toBeGreaterThan(500);
	});
});
