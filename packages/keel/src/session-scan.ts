import { createReadStream } from "node:fs";
import { setImmediate } from "node:timers/promises";

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
			if (j > i) out.push(chunk.slice(i, j));
			if (!m) break;
			const ch = chunk[j]!;
			out.push(ch);
			if (ch === "\n") {
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
