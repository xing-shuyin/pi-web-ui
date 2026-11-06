import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../web/src/components/TermXterm.tsx", import.meta.url), "utf8");
const begin = source.indexOf("const unregister = register(");
const end = source.indexOf("const sendDims =", begin);

function fixture() {
	const term = new Terminal({ cols: 40, rows: 3, scrollback: 100 });
	let writer!: { write(data: string): void; reset(): void };
	runInNewContext(source.slice(begin, end), {
		term,
		conversationId: "conversation",
		terminalId: "terminal",
		stripExitBanner: (data: string) => ({ clean: data }),
		register: (_conversation: string, _id: string, value: typeof writer) => {
			writer = value;
			return () => {};
		},
	});
	const drain = () => new Promise<void>((resolve) => term.write("", resolve));
	const lines = () => {
		const buffer = term.buffer.active;
		return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)).filter(Boolean);
	};
	return { term, writer, drain, lines };
}

describe("TermXterm queued history reset", () => {
	it("clears real scrollback and keeps queued replay and live output in order", async () => {
		const { term, writer, drain, lines } = fixture();
		try {
			writer.write("old1\r\nold2\r\nold3\r\nold4\r\nold5\r\n");
			await drain();
			expect(term.buffer.active.baseY).toBeGreaterThan(0);
			writer.write("pending-old\r\n");
			writer.reset();
			writer.write("history1\r\nhistory2\r\nhistory3\r\nhistory4\r\n");
			writer.write("live1\r\nlive2");
			await drain();
			expect(lines()).toEqual(["history1", "history2", "history3", "history4", "live1", "live2"]);
			expect(term.buffer.active.baseY).toBeGreaterThan(0);
		} finally {
			term.dispose();
		}
	});

	it("handles consecutive replay barriers and empty history without retaining scrollback", async () => {
		const { term, writer, drain, lines } = fixture();
		try {
			writer.write("old1\r\nold2\r\nold3\r\nold4\r\n");
			writer.reset();
			writer.write("replay1\r\nreplay2\r\nreplay3\r\nreplay4\r\n");
			writer.write("superseded-live\r\n");
			writer.reset();
			writer.write("final-history\r\n");
			writer.write("final-live");
			await drain();
			expect(lines()).toEqual(["final-history", "final-live"]);
			expect(term.buffer.active.baseY).toBe(0);

			writer.reset();
			writer.write("");
			await drain();
			expect(lines()).toEqual([]);
			expect(term.buffer.active.baseY).toBe(0);
			expect(term.buffer.active.length).toBe(term.rows);
		} finally {
			term.dispose();
		}
	});
});
