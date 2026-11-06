import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";

describe("TermXterm dispose-vs-write-queue race protection", () => {
	it("defers term.dispose() in cleanup until queued output drains (source guard)", () => {
		const src = readFileSync(new URL("../../web/src/components/TermXterm.tsx", import.meta.url), "utf8");

		expect(src).not.toMatch(/term\.dispose\(\);\s*\n\s*termRef\.current = null;/);

		expect(src).toMatch(/term\.write\(\s*""\s*,\s*disposeDisplay\s*\);/);

		expect(src).toMatch(/disposeTimer\s*=\s*setTimeout\(\s*disposeDisplay\s*,\s*5000\s*\);/);

		expect(src).toMatch(/clearTimeout\(\s*disposeTimer\s*\);/);
		expect(src).toMatch(/if\s*\(\s*termRef\.current\?\.term\s*===\s*term\s*\)\s*termRef\.current\s*=\s*null;/);

		expect(src).toMatch(/dispose:\s*\(\)\s*=>\s*disposeDisplay\(\)/);
	});

	it("drains queued output before calling dispose, preserving active reference on remount", async () => {
		vi.useFakeTimers();
		try {
			const term = new Terminal({ cols: 40, rows: 5 });
			const disposeSpy = vi.spyOn(term, "dispose");

			let displayDisposed = false;
			let disposeTimer: ReturnType<typeof setTimeout> | undefined;

			type TermRef = { current: { term: Terminal; fit: unknown } | null };
			const termRef: TermRef = { current: { term, fit: {} } };

			const disposeDisplay = () => {
				if (displayDisposed) return;
				displayDisposed = true;
				clearTimeout(disposeTimer);
				term.dispose();
				if (termRef.current?.term === term) termRef.current = null;
			};

			term.write("line 1\r\nline 2\r\nline 3\r\n");

			term.write("", disposeDisplay);
			disposeTimer = setTimeout(disposeDisplay, 5000);

			expect(disposeSpy).not.toHaveBeenCalled();
			expect(termRef.current).not.toBeNull();

			const nextTerm = new Terminal({ cols: 40, rows: 5 });
			termRef.current = { term: nextTerm, fit: {} };

			await vi.runAllTimersAsync();

			expect(disposeSpy).toHaveBeenCalledTimes(1);

			expect(termRef.current).toEqual({ term: nextTerm, fit: {} });
			expect(termRef.current?.term).toBe(nextTerm);

			nextTerm.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("handles stuck write queue via 5s timeout backstop and remains idempotent", () => {
		vi.useFakeTimers();
		try {
			const term = new Terminal({ cols: 40, rows: 5 });
			const disposeSpy = vi.spyOn(term, "dispose");

			let displayDisposed = false;
			let disposeTimer: ReturnType<typeof setTimeout> | undefined;

			type TermRef = { current: { term: Terminal; fit: unknown } | null };
			const termRef: TermRef = { current: { term, fit: {} } };

			const disposeDisplay = () => {
				if (displayDisposed) return;
				displayDisposed = true;
				clearTimeout(disposeTimer);
				term.dispose();
				if (termRef.current?.term === term) termRef.current = null;
			};

			disposeTimer = setTimeout(disposeDisplay, 5000);

			expect(disposeSpy).not.toHaveBeenCalled();
			expect(termRef.current?.term).toBe(term);

			vi.advanceTimersByTime(5000);

			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(termRef.current).toBeNull();

			disposeDisplay();
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
