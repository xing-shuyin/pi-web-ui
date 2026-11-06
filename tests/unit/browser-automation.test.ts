// @vitest-environment jsdom
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPageRequest, BrowserTab } from "../../browser/contracts.js";
import { createBrowserExecutor, type BrowserExecutorManager } from "../../browser/automation/executor.js";

function tab(id: string, url = "https://example.com/a", internal = false): BrowserTab {
	return { id, url, title: id, loading: false, canGoBack: false, canGoForward: false, internal };
}

function fixture(tabs: BrowserTab[] = [tab("one")], active: string | null = tabs[0]?.id ?? null) {
	const contents = tabs.map((_, i) => ({
		id: i + 10,
		isDestroyed: vi.fn(() => false),
		executeJavaScript: vi.fn(async (code: string) => window.eval(code)),
		capturePage: vi.fn(),
	}));
	const manager: BrowserExecutorManager = {
		getTabs: () => tabs,
		getActiveTabId: () => active,
		getWebContents: (id) => contents[tabs.findIndex((t) => t.id === id)] as unknown as WebContents,
		createTab: vi.fn(() => "created"),
		navigate: vi.fn(async () => {}),
	};
	const executor = createBrowserExecutor(manager);
	return {
		manager,
		contents,
		execute: (req: Omit<BrowserPageRequest, "timeoutMs"> & { timeoutMs?: number }, caller?: number) =>
			executor({ ...req, timeoutMs: req.timeoutMs ?? 30000 }, caller),
	};
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("browser automation target resolution", () => {
	it("pages/status retain page-picker fields and include native tab references, excluding caller/internal/destroyed tabs", async () => {
		const f = fixture([tab("caller"), tab("internal", "pi://newtab", true), tab("other"), tab("closed")]);
		f.contents[3].isDestroyed.mockReturnValue(true);
		expect(await f.execute({ op: "pages" }, 10)).toEqual({
			ok: true,
			result: {
				pages: [
					{ origin: "https://example.com", title: "other", open: true, tabId: "other", url: "https://example.com/a" },
				],
			},
		});
		expect(await f.execute({ op: "status" }, 10)).toMatchObject({
			ok: true,
			result: { installed: true, hasHost: true, aiControl: true, allowEval: false, allowShot: true },
		});
	});

	it("an explicit stale target, full URL or origin prefix never falls back to the active tab", async () => {
		const f = fixture();
		for (const target of ["missing", "https://example.com/a", "https://exam", ""]) {
			expect(await f.execute({ op: "click", target, args: { selector: "button" } })).toMatchObject({ ok: false });
		}
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
	});

	it("multiple tabs at the exact same origin require a tab ID", async () => {
		const f = fixture([tab("one"), tab("two", "https://example.com/b")]);
		expect(await f.execute({ op: "read", target: "https://example.com" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("Ambiguous"),
		});
		document.title = "second";
		expect(await f.execute({ op: "read", target: "two", args: { what: "title" } })).toEqual({
			ok: true,
			result: { title: "second" },
		});
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
		expect(f.contents[1].executeJavaScript).toHaveBeenCalledOnce();
	});

	it("origin matching distinguishes scheme, port and hostname", async () => {
		const f = fixture([
			tab("wrong-scheme", "http://example.com"),
			tab("wrong-port", "https://example.com:9443"),
			tab("wrong-host", "https://example.com.evil.test"),
			tab("right"),
		]);
		await f.execute({ op: "read", target: "https://example.com", args: { what: "title" } });
		expect(f.contents.map((c) => c.executeJavaScript.mock.calls.length)).toEqual([0, 0, 0, 1]);
	});

	it("refuses caller and internal tab IDs", async () => {
		const f = fixture([tab("caller"), tab("internal", "pi://newtab", true), tab("other")]);
		for (const target of ["caller", "internal"])
			expect(await f.execute({ op: "read", target }, 10)).toMatchObject({ ok: false });
		expect(f.contents.every((c) => c.executeJavaScript.mock.calls.length === 0)).toBe(true);
	});

	it("multiple available pages require a target even when one is active", async () => {
		const f = fixture([tab("one"), tab("two")], "two");
		expect(await f.execute({ op: "read" })).toMatchObject({ ok: false, error: expect.stringContaining("Several") });
		expect(f.contents.every((c) => c.executeJavaScript.mock.calls.length === 0)).toBe(true);
	});

	it("routes an explicit goto through the manager and rejects privileged URLs", async () => {
		const f = fixture([tab("one"), tab("two")], "two");
		expect(await f.execute({ op: "goto", target: "two", args: { url: "https://other.example/a" } })).toEqual({
			ok: true,
			result: { navigating: true, url: "https://other.example/a" },
		});
		expect(f.manager.navigate).toHaveBeenCalledWith("https://other.example/a", "two");
		for (const url of ["javascript:alert(1)", "file:///private/settings.html", "pi://newtab"]) {
			expect(await f.execute({ op: "goto", target: "two", args: { url } })).toMatchObject({ ok: false });
		}
		expect(f.manager.navigate).toHaveBeenCalledOnce();
	});

	it("first-use goto creates a native tab when only an internal page exists", async () => {
		const f = fixture([tab("internal", "pi://newtab", true)]);
		expect(await f.execute({ op: "goto", args: { url: "https://first.example/" } }, 10)).toEqual({
			ok: true,
			result: { navigating: true, url: "https://first.example/", tabId: "created" },
		});
		expect(f.manager.createTab).toHaveBeenCalledWith("https://first.example/");
		expect(f.manager.navigate).not.toHaveBeenCalled();
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
	});

	it("a missing explicit target or invalid goto never creates a fallback tab", async () => {
		const f = fixture([]);
		expect(await f.execute({ op: "goto", target: "stale", args: { url: "https://first.example/" } })).toMatchObject({
			ok: false,
		});
		expect(await f.execute({ op: "goto", args: { url: "file:///private/settings.html" } })).toMatchObject({
			ok: false,
		});
		expect(f.manager.createTab).not.toHaveBeenCalled();
	});
});

describe("browser automation page-picker operations", () => {
	it("read/query/snapshot preserve shapes and exclude password field values", async () => {
		document.body.innerHTML = '<input id="secret" type="password" value="private-value"><button>Continue</button>';
		const f = fixture();
		for (const req of [
			{ op: "read", args: { what: "query", selector: "input" } },
			{ op: "read", args: { what: "html" } },
			{ op: "read", args: { what: "html", selector: "#secret" } },
			{ op: "snapshot" },
		]) {
			const res = await f.execute(req);
			expect(res.ok).toBe(true);
			expect(JSON.stringify(res)).not.toContain("private-value");
		}
		expect(await f.execute({ op: "read", args: { what: "query", selector: "input" } })).toMatchObject({
			ok: true,
			result: { selector: "input", count: 1, shown: 1, items: [{ tag: "input", id: "secret", type: "password" }] },
		});
		expect(await f.execute({ op: "snapshot" })).toMatchObject({
			ok: true,
			result: { items: [{ selector: expect.any(String) }, { text: "Continue" }] },
		});
	});

	it("type updates controlled inputs with native setters and input/change events, click respects index", async () => {
		document.body.innerHTML =
			'<input id="field"><input id="secret" type="password"><button>A</button><button>B</button>';
		const field = document.querySelector("#field") as HTMLInputElement;
		const input = vi.fn();
		const change = vi.fn();
		field.addEventListener("input", input);
		field.addEventListener("change", change);
		Object.defineProperty(field, "value", {
			configurable: true,
			set: () => {
				throw new Error("framework setter");
			},
			get: () => "framework-value",
		});
		const f = fixture();
		expect(await f.execute({ op: "type", args: { selector: "#field", text: "new" } })).toMatchObject({
			ok: true,
			result: { typed: true },
		});
		expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(field)).toBe("new");
		expect(input).toHaveBeenCalledOnce();
		expect(change).toHaveBeenCalledOnce();
		const res = await f.execute({ op: "type", args: { selector: "#secret", text: "private-value" } });
		expect(res).toMatchObject({ ok: true, result: { typed: true } });
		expect(JSON.stringify(res)).not.toContain("private-value");
		const click = vi.fn();
		document.querySelectorAll("button")[1].addEventListener("click", click);
		expect(await f.execute({ op: "click", args: { selector: "button", index: 1 } })).toMatchObject({
			ok: true,
			result: { clicked: true, text: "B" },
		});
		expect(click).toHaveBeenCalledOnce();
	});

	it("wait(text) polls until text appears instead of returning immediately", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let settled = false;
		const pending = f.execute({ op: "wait", args: { text: "Ready" }, timeoutMs: 1000 }).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(200);
		expect(settled).toBe(false);
		document.body.textContent = "Ready";
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toMatchObject({ ok: true, result: { found: "text", text: "Ready", waitedMs: 300 } });
	});

	it("wait returns the existing found:null timeout shape and supports selectors", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const pending = f.execute({ op: "wait", args: { text: "missing" }, timeoutMs: 200 });
		await vi.advanceTimersByTimeAsync(200);
		expect(await pending).toMatchObject({ ok: true, result: { found: null, waitedMs: 200 } });
		document.body.innerHTML = '<button id="ready">Ready</button>';
		expect(await f.execute({ op: "wait", args: { selector: "#ready" } })).toMatchObject({
			ok: true,
			result: { found: "selector", selector: "#ready" },
		});
	});

	it("metrics preserve page-picker viewport and scroll field names", async () => {
		const f = fixture();
		expect(await f.execute({ op: "metrics" })).toEqual({
			ok: true,
			result: { vw: innerWidth, vh: innerHeight, sx: scrollX, sy: scrollY, dpr: devicePixelRatio },
		});
		expect(f.contents[0].executeJavaScript.mock.calls[0]).toHaveLength(1);
	});

	it("native options gate AI actions and screenshots while status stays readable", async () => {
		const f = fixture();
		const disabled = createBrowserExecutor(f.manager, { aiControl: false, allowShot: false });
		expect(await disabled({ op: "status", timeoutMs: 30000 })).toMatchObject({
			ok: true,
			result: { aiControl: false, allowShot: false },
		});
		for (const op of ["pages", "read", "goto"])
			expect(await disabled({ op, timeoutMs: 30000 })).toMatchObject({
				ok: false,
				error: expect.stringContaining("AI control is disabled"),
			});
		expect(
			await createBrowserExecutor(f.manager, { allowShot: false })({ op: "shot", timeoutMs: 30000 }),
		).toMatchObject({ ok: false, error: expect.stringContaining("screenshots are disabled") });
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
		expect(f.contents[0].capturePage).not.toHaveBeenCalled();
		expect(f.manager.createTab).not.toHaveBeenCalled();
	});

	it("eval is disabled by default and only enabled by executor options", async () => {
		const f = fixture();
		expect(await f.execute({ op: "eval", args: { code: "1 + 2" } })).toMatchObject({
			ok: false,
			error: expect.stringContaining("disabled"),
		});
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
		expect(
			await createBrowserExecutor(f.manager, { allowEval: true })({
				op: "eval",
				args: { code: "1 + 2" },
				timeoutMs: 30000,
			}),
		).toEqual({ ok: true, result: { value: 3 } });
	});

	it("bounds args and serialized results including eval", async () => {
		const f = fixture();
		expect(await f.execute({ op: "read", args: { text: "a".repeat(256 * 1024) } })).toMatchObject({
			ok: false,
			error: expect.stringContaining("arguments exceed"),
		});
		expect(f.contents[0].executeJavaScript).not.toHaveBeenCalled();
		f.contents[0].executeJavaScript.mockResolvedValue("x".repeat(512 * 1024));
		expect(
			await createBrowserExecutor(f.manager, { allowEval: true })({
				op: "eval",
				args: { code: "large" },
				timeoutMs: 30000,
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("result exceeds") });
	});
});

describe("browser automation shot", () => {
	it.each([
		{ maxEdge: undefined, width: 1280, height: 640 },
		{ maxEdge: 9999, width: 1568, height: 784 },
		{ maxEdge: 10, width: 320, height: 160 },
	])("retains image dataUrl/mimeType/dimensions and bounds maxEdge=$maxEdge", async ({ maxEdge, width, height }) => {
		const f = fixture();
		f.contents[0].executeJavaScript.mockResolvedValue({ vw: 2000, vh: 1000, dpr: 2 });
		const image = {
			isEmpty: () => false,
			getSize: () => ({ width: 2000, height: 1000 }),
			resize: vi.fn(),
			toJPEG: vi.fn(() => Buffer.from("jpeg")),
		};
		image.resize.mockReturnValue(image);
		f.contents[0].capturePage.mockResolvedValue(image);
		expect(await f.execute({ op: "shot", args: { maxEdge } })).toEqual({
			ok: true,
			result: {
				image: {
					dataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
					mimeType: "image/jpeg",
					width,
					height,
				},
				viewport: { dpr: 2 },
			},
		});
		expect(image.resize).toHaveBeenCalledWith({ width, height });
		expect(image.toJPEG).toHaveBeenCalledWith(72);
	});

	it("clips selector screenshots to the viewport and rejects offscreen elements", async () => {
		const f = fixture();
		f.contents[0].executeJavaScript.mockResolvedValue({
			vw: 800,
			vh: 600,
			dpr: 1,
			rect: { x: -10, y: 20, w: 100, h: 80 },
		});
		const image = {
			isEmpty: () => false,
			getSize: () => ({ width: 90, height: 80 }),
			resize: vi.fn(),
			toJPEG: () => Buffer.from("jpeg"),
		};
		image.resize.mockReturnValue(image);
		f.contents[0].capturePage.mockResolvedValue(image);
		expect(await f.execute({ op: "shot", args: { selector: "button" } })).toMatchObject({
			ok: true,
			result: { image: { width: 90, height: 80 }, selector: "button" },
		});
		expect(f.contents[0].capturePage).toHaveBeenCalledWith({ x: 0, y: 20, width: 90, height: 80 });
		f.contents[0].executeJavaScript.mockResolvedValue({
			vw: 800,
			vh: 600,
			dpr: 1,
			rect: { x: 900, y: 20, w: 100, h: 80 },
		});
		expect(await f.execute({ op: "shot", args: { selector: "button" } })).toMatchObject({
			ok: false,
			error: expect.stringContaining("outside"),
		});
		expect(f.contents[0].capturePage).toHaveBeenCalledOnce();
	});
});
