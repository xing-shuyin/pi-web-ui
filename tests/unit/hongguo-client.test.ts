// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer } from "../../plugins/hongguo/client/player.mjs";
import {
	HISTORY_KEY,
	PREFS_KEY,
	layoutFor,
	resizeFloating,
	resumePosition,
	saveRecord,
} from "../../plugins/hongguo/client/state.mjs";

const players: ReturnType<typeof createPlayer>[] = [];
beforeEach(() => {
	document.documentElement.lang = "zh-CN";
	document.body.innerHTML = '<div data-pi-anchor="app" style="padding-inline-end:7px"></div>';
	localStorage.clear();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(90);
});
afterEach(() => {
	players.splice(0).forEach((player) => player.destroy());
	vi.restoreAllMocks();
});

function setup(fetcher?: typeof fetch) {
	const app = document.querySelector<HTMLElement>('[data-pi-anchor="app"]')!;
	app.getBoundingClientRect = () => ({
		width: 1200,
		height: 850,
		left: 0,
		top: 0,
		right: 1200,
		bottom: 850,
		x: 0,
		y: 0,
		toJSON() {},
	});
	const calls: string[] = [];
	const fetchMock = vi.fn(async (url: URL, _init?: RequestInit) => {
		calls.push(url.pathname + url.search);
		let data: unknown = {};
		if (url.pathname.endsWith("/config")) data = { ffmpegAvailable: true };
		if (url.pathname.endsWith("/list")) data = { items: [{ id: "show1", title: "测试短剧", episodes: 2 }] };
		if (url.pathname.endsWith("/search"))
			data =
				url.searchParams.get("type") === "actor"
					? { items: [{ id: "actor1", name: "马小宇", title: "马小宇", kind: "actor" }] }
					: { items: [{ id: "show1", title: "测试短剧" }] };
		if (url.pathname.endsWith("/actors/works"))
			data = { person: { id: "actor1", name: "马小宇" }, items: [{ id: "show1", title: "测试短剧", episodes: 2 }] };
		if (url.pathname.endsWith("/preload")) data = { episodeId: url.searchParams.get("episode"), ready: true };
		if (url.pathname.endsWith("/series"))
			data = {
				series: { id: "show1", title: "测试短剧" },
				episodes: [
					{ id: "ep1", number: 1 },
					{ id: "ep2", number: 2 },
				],
			};
		if (url.pathname.endsWith("/play"))
			data = { streams: [{ kind: "file", url: `./media/${url.searchParams.get("episode")}` }] };
		return { ok: true, json: async () => data };
	});
	const player = createPlayer(
		{ dom: { anchors: () => ({ app }) } },
		{ fetch: fetcher ?? fetchMock, storage: localStorage },
	);
	players.push(player);
	player.open();
	return { player, app, calls, fetchMock };
}
const click = (label: string) => {
	const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === label,
	);
	expect(target, label).toBeTruthy();
	target!.click();
};
function pointer(target: EventTarget, type: string, x: number, y: number, id = 7) {
	const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
	Object.defineProperty(event, "pointerId", { value: id });
	target.dispatchEvent(event);
}

async function watch() {
	await vi.waitFor(() => expect(document.querySelector(".hg-card")).toBeTruthy());
	document.querySelector<HTMLButtonElement>(".hg-card")!.click();
	await vi.waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toContain("media/ep1"));
}

describe("Hongguo player lifecycle", () => {
	it("keeps the same playing video when switching floating/split and restores the app on close", async () => {
		const { player, app } = setup();
		await watch();
		const video = document.querySelector("video")!;
		video.currentTime = 24;
		const source = video.src;
		click("分屏");
		expect(app.style.paddingInlineEnd).toBe("400px");
		expect(document.querySelector("video")).toBe(video);
		expect(video.src).toBe(source);
		expect(video.currentTime).toBe(24);
		click("悬浮");
		expect(app.style.paddingInlineEnd).toBe("7px");
		expect(video.currentTime).toBe(24);
		click("分屏");
		player.close();
		expect(app.style.paddingInlineEnd).toBe("7px");
		expect((document.querySelector(".hg-root") as HTMLElement).hidden).toBe(true);
		player.destroy();
		expect(document.querySelector(".hg-root")).toBeNull();
		expect(video.getAttribute("src")).toBeNull();
	});
	it("resizes from the left edge, captures the pointer across video and releases it on cancel", async () => {
		setup();
		await watch();
		const root = document.querySelector<HTMLElement>(".hg-root")!;
		const video = document.querySelector("video")!;
		const edge = root.querySelector<HTMLElement>(".hg-resize-w")!;
		let captured = false;
		edge.setPointerCapture = vi.fn(() => {
			captured = true;
		});
		edge.hasPointerCapture = vi.fn(() => captured);
		edge.releasePointerCapture = vi.fn(() => {
			captured = false;
		});
		const left = Number.parseFloat(root.style.left),
			width = Number.parseFloat(root.style.width);
		const source = video.src;
		video.currentTime = 24;
		pointer(edge, "pointerdown", left + 4, 300);
		expect(edge.setPointerCapture).toHaveBeenCalledWith(7);
		pointer(video, "pointermove", left - 56, 300, 8);
		expect(Number.parseFloat(root.style.width)).toBe(width);
		pointer(video, "pointermove", left - 56, 300);
		expect(Number.parseFloat(root.style.width)).toBe(width + 60);
		expect(Number.parseFloat(root.style.left)).toBe(left - 60);
		expect(video.src).toBe(source);
		expect(video.currentTime).toBe(24);
		pointer(window, "pointercancel", left - 56, 300);
		expect(edge.releasePointerCapture).toHaveBeenCalledWith(7);
		expect(root.classList.contains("hg-dragging")).toBe(false);
		pointer(window, "pointermove", left - 120, 300);
		expect(Number.parseFloat(root.style.width)).toBe(width + 60);
	});
	it("keeps compact window sizes independent and allows resizing them", async () => {
		setup();
		await watch();
		const root = document.querySelector<HTMLElement>(".hg-root")!;
		const mini = root.querySelector<HTMLButtonElement>('[aria-label="精简播放器"]')!;
		const full = { w: root.style.width, h: root.style.height };
		mini.click();
		expect(root.style.width).toBe("320px");
		expect(root.style.height).toBe("260px");
		const edge = root.querySelector<HTMLElement>(".hg-resize-sw")!;
		pointer(edge, "pointerdown", 900, 300);
		pointer(window, "pointermove", 810, 360);
		pointer(window, "pointerup", 810, 360);
		expect(root.style.width).toBe("410px");
		expect(root.style.height).toBe("320px");
		expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ miniW: 410, miniH: 320 });
		mini.click();
		expect(root.style.width).toBe(full.w);
		expect(root.style.height).toBe(full.h);
		mini.click();
		expect(root.style.width).toBe("410px");
		expect(root.style.height).toBe("320px");
	});
	it("resizes desktop and vertical split boundaries and stops the gesture on blur", async () => {
		const { app } = setup();
		const root = document.querySelector<HTMLElement>(".hg-root")!;
		click("分屏");
		pointer(root.querySelector(".hg-resize-w")!, "pointerdown", 802, 300);
		pointer(window, "pointermove", 722, 300);
		pointer(window, "pointerup", 722, 300);
		expect(app.style.paddingInlineEnd).toBe("480px");
		const original = app.getBoundingClientRect();
		app.getBoundingClientRect = () => ({ ...original, width: 390, right: 390 });
		window.dispatchEvent(new Event("resize"));
		expect(root.classList.contains("hg-vertical")).toBe(true);
		const height = Number.parseFloat(root.style.height);
		pointer(root.querySelector(".hg-resize-n")!, "pointerdown", 200, 450);
		pointer(window, "pointermove", 200, 490);
		expect(Number.parseFloat(app.style.paddingBlockEnd)).toBe(height - 40);
		window.dispatchEvent(new Event("blur"));
		pointer(window, "pointermove", 200, 520);
		expect(Number.parseFloat(app.style.paddingBlockEnd)).toBe(height - 40);
		expect(root.classList.contains("hg-dragging")).toBe(false);
	});
	it("searches actors and opens their dramas before selecting episodes", async () => {
		const { calls } = setup();
		await vi.waitFor(() => expect(document.querySelector(".hg-card")).toBeTruthy());
		const type = document.querySelector<HTMLSelectElement>('[aria-label="搜索类型"]')!;
		type.value = "actor";
		type.dispatchEvent(new Event("change"));
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLInputElement>(".hg-search input")!.placeholder).toBe("搜索演员姓名"),
		);
		const input = document.querySelector<HTMLInputElement>(".hg-search input")!;
		input.value = "马小宇";
		document.querySelector("form.hg-search")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(document.querySelector(".hg-person-card")).toBeTruthy());
		document.querySelector<HTMLButtonElement>(".hg-person-card")!.click();
		await vi.waitFor(() => expect(document.querySelector(".hg-section-title")?.textContent).toContain("马小宇的作品"));
		expect(calls.some((path) => path.includes("actors/works?id=actor1"))).toBe(true);
		expect(calls.some((path) => path.includes("/play?"))).toBe(false);
		await vi.waitFor(() => expect(document.querySelector(".hg-card")).toBeTruthy());
		document.querySelector<HTMLButtonElement>(".hg-card")!.click();
		await vi.waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toContain("media/ep1"));
		expect(calls.some((path) => path.includes("series?id=actor1"))).toBe(false);
	});
	it("preloads one upcoming episode after playback begins and allows disabling it", async () => {
		const { fetchMock } = setup();
		await watch();
		const video = document.querySelector("video")!;
		video.dispatchEvent(new Event("playing"));
		await vi.waitFor(() => expect(document.querySelector(".hg-preload-state")?.textContent).toBe("下一集已就绪"));
		let preloads = fetchMock.mock.calls.filter(([url]) => url.pathname.endsWith("/preload"));
		expect(preloads).toHaveLength(1);
		expect(preloads[0][0].searchParams.get("episode")).toBe("ep2");
		expect(preloads[0][1]?.method).toBe("POST");
		video.dispatchEvent(new Event("playing"));
		await Promise.resolve();
		expect(fetchMock.mock.calls.filter(([url]) => url.pathname.endsWith("/preload"))).toHaveLength(1);
		const toggle = document.querySelector<HTMLInputElement>(".hg-preload input")!;
		toggle.checked = false;
		toggle.dispatchEvent(new Event("change"));
		video.dispatchEvent(new Event("playing"));
		await Promise.resolve();
		preloads = fetchMock.mock.calls.filter(([url]) => url.pathname.endsWith("/preload"));
		expect(preloads).toHaveLength(1);
	});
	it("cancels a pending preload when closed and ignores a late response", async () => {
		const { player, fetchMock } = setup();
		await watch();
		let finish!: (value: unknown) => void;
		let signal!: AbortSignal;
		fetchMock.mockImplementationOnce(async (_url, init) => {
			signal = init!.signal!;
			return {
				ok: true,
				json: () =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			};
		});
		document.querySelector("video")!.dispatchEvent(new Event("playing"));
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		player.close();
		expect(signal.aborted).toBe(true);
		finish({ ready: true });
		await Promise.resolve();
		player.open();
		expect(document.querySelector(".hg-preload-state")?.textContent).toBe("");
	});
	it("saves playback progress and advances only when automatic playback is enabled", async () => {
		const { calls } = setup();
		await watch();
		const video = document.querySelector("video")!;
		video.currentTime = 18;
		video.dispatchEvent(new Event("timeupdate"));
		expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!).show1).toMatchObject({ episodeId: "ep1", position: 18 });
		video.dispatchEvent(new Event("ended"));
		await vi.waitFor(() => expect(calls.some((path) => path.includes("episode=ep2"))).toBe(true));
		const auto = document.querySelector<HTMLInputElement>(".hg-auto input")!;
		auto.checked = false;
		auto.dispatchEvent(new Event("change"));
		const count = calls.length;
		video.dispatchEvent(new Event("ended"));
		await Promise.resolve();
		expect(calls).toHaveLength(count);
	});
	it("ignores a late playback result after the player is destroyed", async () => {
		let resolvePlay: ((value: unknown) => void) | undefined;
		const fetcher = vi.fn(async (url: URL) => ({
			ok: true,
			json: async () => {
				if (url.pathname.endsWith("/config")) return { ffmpegAvailable: true };
				if (url.pathname.endsWith("/list")) return { items: [{ id: "show1", title: "测试短剧" }] };
				if (url.pathname.endsWith("/series"))
					return { series: { id: "show1", title: "测试短剧" }, episodes: [{ id: "ep1", number: 1 }] };
				return new Promise((resolve) => {
					resolvePlay = resolve;
				});
			},
		}));
		const { player, app } = setup(fetcher as any);
		await vi.waitFor(() => expect(document.querySelector(".hg-card")).toBeTruthy());
		document.querySelector<HTMLButtonElement>(".hg-card")!.click();
		await vi.waitFor(() => expect(resolvePlay).toBeTypeOf("function"));
		player.setMode("split");
		player.destroy();
		resolvePlay!({ streams: [{ kind: "file", url: "./media/ep1" }] });
		await Promise.resolve();
		expect(document.querySelector(".hg-root")).toBeNull();
		expect(app.style.paddingInlineEnd).toBe("7px");
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
	});
});

describe("Hongguo layout and resume", () => {
	it("keeps floating windows onscreen and switches to vertical split on phones", () => {
		const floating = layoutFor("floating", 390, 650, { x: 9999, y: -50, w: 900, h: 1000 });
		expect(floating.x).toBeGreaterThanOrEqual(0);
		expect(floating.y).toBeGreaterThanOrEqual(0);
		expect(floating.x + floating.w).toBeLessThanOrEqual(390);
		const mobile = layoutFor("split", 390, 650);
		expect(mobile.reserveRight).toBe(0);
		expect(mobile.reserveBottom).toBeGreaterThan(0);
		expect(mobile.axis).toBe("y");
		expect(layoutFor("split", 1200, 850).reserveRight).toBe(400);
	});
	it("anchors opposite edges and enforces minimum and viewport bounds when resizing", () => {
		const box = { x: 300, y: 200, w: 400, h: 500 };
		expect(resizeFloating(box, "nw", -100, -50, 1200, 900)).toEqual({ x: 200, y: 150, w: 500, h: 550 });
		expect(resizeFloating(box, "se", 100, 50, 1200, 900)).toEqual({ x: 300, y: 200, w: 500, h: 550 });
		const minimum = resizeFloating(box, "nw", 1000, 1000, 1200, 900);
		expect(minimum.w).toBe(300);
		expect(minimum.h).toBe(340);
		expect(minimum.x + minimum.w).toBe(700);
		expect(minimum.y + minimum.h).toBe(700);
		const maximum = resizeFloating(box, "nw", -1000, -1000, 1200, 900);
		expect(maximum.x).toBe(12);
		expect(maximum.y).toBe(12);
		expect(layoutFor("floating", 1200, 900, { compact: true, w: 270, h: 180 })).toMatchObject({ w: 270, h: 180 });
	});
	it("bounds history and starts finished episodes from the beginning", () => {
		let records = {};
		for (let i = 0; i < 40; i++)
			records = saveRecord(records, { id: String(i), title: "测试" }, { id: "ep" }, 20, 60, i);
		expect(Object.keys(records)).toHaveLength(30);
		expect(records).not.toHaveProperty("0");
		expect(resumePosition({ position: 59, duration: 60 })).toBe(0);
		expect(resumePosition({ position: 20, duration: 60 })).toBe(20);
	});
});
