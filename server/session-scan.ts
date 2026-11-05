/** Shared streaming transcript reader. Memory scales with textual JSONL records,
 * not the file or embedded binary `data` strings. */
import { createReadStream } from "node:fs";
import { setImmediate } from "node:timers/promises";

/** 字符串内的特殊字符（引号 / 转义 / 换行）与字符串外的「非空白或换行」：sticky 扫描用。 */
const STRING_SPECIAL = /["\\\n]/g;
const NON_WS_OR_NL = /[^\s]|\n/g;

function tokenIsData(token: string): boolean {
	if (token === "data") return true;
	if (token.length < 4 || !token.includes("\\")) return false;
	try {
		return JSON.parse('"' + token + '"') === "data";
	} catch {
		return false;
	}
}

/** Discard JSON string values of `data` properties (embedded image/base64 payloads)
 * before assembling lines. Preserve the empty string so JSON syntax stays valid.
 * Text/content strings remain intact, including escaped quotes and newlines.
 *
 * 状态机与原逐字符实现完全一致（差分测试见 tests/unit/session-scan-filter.test.ts），
 * 但不再逐字符 push + 正则：字符串内用正则跳到下一个引号/转义/换行，字符串外跳到下一个
 * 非空白字符，普通字符整段切片输出。大转录的流式扫描吞吐因此提升一个数量级。 */
export class BinaryStringFilter {
	private inString = false;
	private escaped = false;
	private token = "";
	private dataKey = false;
	private awaitingValue = false;
	private discard = false;

	private addToken(seg: string): void {
		if (this.token.length < 16) this.token += seg.slice(0, 16 - this.token.length);
	}

	push(chunk: string): string {
		const out: string[] = [];
		const n = chunk.length;
		let i = 0;
		while (i < n) {
			if (this.inString) {
				if (this.escaped) {
					const ch = chunk[i]!;
					if (ch === "\n") {
						// 换行重置行内状态，换行符本身按字符串外处理
						this.inString = false;
						this.escaped = false;
						this.discard = false;
						continue;
					}
					if (!this.discard) out.push(ch);
					this.escaped = false;
					this.addToken(ch);
					i++;
					continue;
				}
				STRING_SPECIAL.lastIndex = i;
				const m = STRING_SPECIAL.exec(chunk);
				const j = m ? m.index : n;
				if (j > i) {
					const seg = chunk.slice(i, j);
					if (!this.discard) out.push(seg);
					this.addToken(seg);
				}
				if (!m) break;
				const ch = chunk[j]!;
				if (ch === "\n") {
					this.inString = false;
					this.escaped = false;
					this.discard = false;
					i = j;
					continue;
				}
				if (ch === "\\") {
					if (!this.discard) out.push(ch);
					this.escaped = true;
					this.addToken(ch);
					i = j + 1;
					continue;
				}
				// 收尾引号：无论是否丢弃都输出（保持 JSON 语法完整）
				out.push('"');
				this.inString = false;
				this.dataKey = tokenIsData(this.token);
				this.discard = false;
				i = j + 1;
				continue;
			}
			NON_WS_OR_NL.lastIndex = i;
			const m = NON_WS_OR_NL.exec(chunk);
			const j = m ? m.index : n;
			if (j > i) out.push(chunk.slice(i, j)); // 纯空白：不改变状态
			if (!m) break;
			const ch = chunk[j]!;
			out.push(ch);
			if (ch === "\n") {
				// JSONL records are independent, including after malformed lines.
				this.dataKey = false;
				this.awaitingValue = false;
			} else if (ch === '"') {
				this.inString = true;
				this.token = "";
				this.discard = this.awaitingValue;
				this.awaitingValue = false;
				this.dataKey = false;
			} else {
				this.awaitingValue = ch === ":" && this.dataKey;
				this.dataKey = false;
			}
			i = j + 1;
		}
		return out.join("");
	}
}

/** Early return and errors close the file. Non-binary text records are not capped:
 * an exceptionally large single text message still requires one record in memory. */
export async function* sessionLines(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
	signal?.throwIfAborted();
	const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024, signal });
	const filter = new BinaryStringFilter();
	let pending = "";
	let count = 0;
	try {
		for await (const chunk of input) {
			signal?.throwIfAborted();
			const text = filter.push(chunk as string);
			let start = 0;
			let end: number;
			while ((end = text.indexOf("\n", start)) !== -1) {
				const line = pending + text.slice(start, end);
				pending = "";
				if (++count % 128 === 0) await setImmediate();
				signal?.throwIfAborted();
				yield line.endsWith("\r") ? line.slice(0, -1) : line;
				start = end + 1;
			}
			pending += text.slice(start);
			await setImmediate();
		}
		signal?.throwIfAborted();
		if (pending) yield pending;
		signal?.throwIfAborted();
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		input.destroy();
	}
}

/** Bounded worker pool; results retain input order. No implicit list/result limit. */
export async function mapSessionsConcurrent<T, R>(
	items: readonly T[],
	visit: (item: T, index: number) => Promise<R>,
	concurrency = 4,
	signal?: AbortSignal,
): Promise<R[]> {
	signal?.throwIfAborted();
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
		throw new RangeError("concurrency must be an integer between 1 and 32");
	}
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				signal?.throwIfAborted();
				const index = next++;
				results[index] = await visit(items[index], index);
				signal?.throwIfAborted();
			}
		}),
	);
	signal?.throwIfAborted();
	return results;
}
