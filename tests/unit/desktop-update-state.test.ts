import { describe, expect, it, vi } from "vitest";
import {
	classifyUpdaterError,
	createUpdaterController,
	DEFAULT_UPDATER_PREFS,
	initialUpdaterState,
	MAX_NOTE_CHARS,
	MAX_NOTE_RELEASES,
	normalizeReleaseNotes,
	reduceUpdater,
	releasesUrlFor,
	resolveUpdaterMode,
	type UpdaterAdapter,
	type UpdaterEvent,
	type UpdaterState,
} from "../../desktop/updater.js";

const AUTO = { mode: "auto", reason: "ready" } as const;
const MANUAL = { mode: "manual", reason: "portable" } as const;

function baseState(overrides: Partial<UpdaterState> = {}): UpdaterState {
	return {
		...initialUpdaterState({ currentVersion: "0.120.0", mode: AUTO.mode, modeReason: AUTO.reason }),
		...overrides,
	};
}

describe("resolveUpdaterMode", () => {
	it("打包 + 有更新配置才走应用内更新", () => {
		expect(resolveUpdaterMode({ isPackaged: true, portable: false, hasUpdateFeed: true })).toEqual({
			mode: "auto",
			reason: "ready",
		});
	});

	it("dev / 便携 / 没有 app-update.yml 一律 manual，并给出原因", () => {
		expect(resolveUpdaterMode({ isPackaged: false, portable: false, hasUpdateFeed: false })).toEqual({
			mode: "manual",
			reason: "dev",
		});
		expect(resolveUpdaterMode({ isPackaged: true, portable: true, hasUpdateFeed: true })).toEqual({
			mode: "manual",
			reason: "portable",
		});
		expect(resolveUpdaterMode({ isPackaged: true, portable: false, hasUpdateFeed: false })).toEqual({
			mode: "manual",
			reason: "no-feed",
		});
	});

	it("环境变量可强制覆盖", () => {
		expect(resolveUpdaterMode({ isPackaged: true, portable: false, hasUpdateFeed: true, override: "manual" })).toEqual({
			mode: "manual",
			reason: "forced",
		});
		// 支持现场用来「强行打开」自更新（例如换了分发方式但产物里还没有 app-update.yml）。
		expect(resolveUpdaterMode({ isPackaged: true, portable: true, hasUpdateFeed: false, override: "auto" })).toEqual({
			mode: "auto",
			reason: "ready",
		});
	});
});

describe("classifyUpdaterError", () => {
	it.each([
		["HttpError: 404 Not Found latest.yml", "feed"],
		["Cannot parse releases feed: <xml/>", "feed"],
		["getaddrinfo ENOTFOUND github.com", "network"],
		["net::ERR_INTERNET_DISCONNECTED", "network"],
		["Error: EACCES: permission denied, unlink '/Applications/x.app'", "permission"],
		["Error: ENOSPC: no space left on device", "disk"],
		["Could not get code signature for running application", "signature"],
		["Squirrel.Mac could not update", "signature"],
		["something odd happened", "unknown"],
	] as const)("%s → %s", (message, code) => {
		expect(classifyUpdaterError(message)).toBe(code);
		expect(classifyUpdaterError(new Error(message))).toBe(code);
	});
});

describe("normalizeReleaseNotes", () => {
	it("fullChangelog 的数组按新→旧保留，剥掉版本号的 v 前缀", () => {
		const { notes, cut } = normalizeReleaseNotes([
			{ version: "v0.123.0", note: "### Added\n\n- 新功能" },
			{ version: "0.122.0", note: "- 修一个问题" },
		]);
		expect(cut).toBe(false);
		expect(notes).toEqual([
			{ version: "0.123.0", markdown: "### Added\n\n- 新功能" },
			{ version: "0.122.0", markdown: "- 修一个问题" },
		]);
	});

	it("字符串说明归到目标版本；空说明丢掉", () => {
		expect(normalizeReleaseNotes("- only one", "0.123.0").notes).toEqual([
			{ version: "0.123.0", markdown: "- only one" },
		]);
		expect(normalizeReleaseNotes([{ version: "1.0.0", note: "   " }]).notes).toEqual([]);
		expect(normalizeReleaseNotes(null).notes).toEqual([]);
	});

	it("条数与长度都有上限，超了就标记 cut", () => {
		const many = Array.from({ length: MAX_NOTE_RELEASES + 5 }, (_, i) => ({
			version: `1.0.${i}`,
			note: `- 第 ${i} 条`,
		}));
		const capped = normalizeReleaseNotes(many);
		expect(capped.notes).toHaveLength(MAX_NOTE_RELEASES);
		expect(capped.cut).toBe(true);

		const long = normalizeReleaseNotes([{ version: "2.0.0", note: "x".repeat(MAX_NOTE_CHARS + 100) }]);
		expect(long.notes[0].markdown).toHaveLength(MAX_NOTE_CHARS);
		expect(long.cut).toBe(true);
	});
});

describe("reduceUpdater", () => {
	it("checking 清掉上一次的错误", () => {
		const state = reduceUpdater(baseState({ phase: "error", error: "x", errorCode: "network" }), {
			type: "checking",
		});
		expect(state.phase).toBe("checking");
		expect(state.error).toBeNull();
		expect(state.errorCode).toBeNull();
	});

	it("available 带上发布说明、落后版本数与发布页", () => {
		const state = reduceUpdater(
			baseState(),
			{
				type: "available",
				version: "0.123.0",
				notes: [
					{ version: "0.123.0", note: "- 新功能" },
					{ version: "0.122.0", note: "- 修复" },
				],
			},
			1000,
		);
		expect(state.phase).toBe("available");
		expect(state.targetVersion).toBe("0.123.0");
		expect(state.releasesBehind).toBe(2);
		expect(state.notes).toHaveLength(2);
		expect(state.releasesUrl).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0");
		expect(state.checkedAt).toBe(1000);
	});

	it("up-to-date 清掉目标版本，避免面板继续显示旧版本号", () => {
		const state = reduceUpdater(
			baseState({ phase: "available", targetVersion: "0.123.0", notes: [{ version: "0.123.0", markdown: "- x" }] }),
			{ type: "up-to-date", version: "0.121.0" },
		);
		expect(state.phase).toBe("up-to-date");
		expect(state.targetVersion).toBeNull();
		expect(state.notes).toEqual([]);
		expect(state.currentVersion).toBe("0.121.0");
	});

	it("progress 用字节算百分比，没有 percent 时不留旧值", () => {
		const downloading = reduceUpdater(baseState({ phase: "available", targetVersion: "0.123.0", percent: 80 }), {
			type: "progress",
			transferred: 25,
			total: 100,
		});
		expect(downloading.phase).toBe("downloading");
		expect(downloading.percent).toBe(25);
		expect(downloading.transferred).toBe(25);
		expect(downloading.total).toBe(100);
		expect(reduceUpdater(downloading, { type: "progress", percent: 137 }).percent).toBe(100);
		expect(reduceUpdater(downloading, { type: "progress", percent: Number.NaN }).percent).toBe(25);
	});

	it("downloaded 固定 100%，取消下载回到 available 不报错", () => {
		const downloaded = reduceUpdater(baseState({ phase: "downloading", targetVersion: "0.123.0", percent: 40 }), {
			type: "downloaded",
			version: "0.123.0",
		});
		expect(downloaded.phase).toBe("downloaded");
		expect(downloaded.percent).toBe(100);

		const cancelled = reduceUpdater(downloaded, { type: "cancelled" });
		expect(cancelled.phase).toBe("available");
		expect(cancelled.percent).toBe(0);
		expect(cancelled.error).toBeNull();
	});

	it("error 自动分类，显式 code 优先", () => {
		const net = reduceUpdater(baseState({ phase: "checking" }), { type: "error", message: "getaddrinfo ENOTFOUND" });
		expect(net.phase).toBe("error");
		expect(net.errorCode).toBe("network");
		expect(reduceUpdater(baseState(), { type: "error", message: "x", code: "signature" }).errorCode).toBe("signature");
	});

	it("skipped 记下忽略的版本", () => {
		const state = reduceUpdater(baseState({ phase: "available", targetVersion: "0.123.0" }), {
			type: "skipped",
			version: "v0.123.0",
		});
		expect(state.skippedVersion).toBe("0.123.0");
		expect(reduceUpdater(state, { type: "skipped", version: null }).skippedVersion).toBeNull();
	});

	it("未知事件原样返回同一个对象", () => {
		const state = baseState();
		expect(reduceUpdater(state, { type: "weird" } as unknown as UpdaterEvent)).toBe(state);
	});
});

describe("releasesUrlFor", () => {
	it("有版本直达 tag，没有落 latest", () => {
		expect(releasesUrlFor("0.123.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0");
		expect(releasesUrlFor("v0.123.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0");
		expect(releasesUrlFor(null)).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/latest");
	});
});

interface FakeAdapter extends UpdaterAdapter {
	emit: (event: string, payload?: unknown) => void;
	/** 每个动作被调用了几次；比 spy 更容易和 UpdaterAdapter 的窄签名对齐。 */
	calls: { check: number; download: number; install: string[] };
}

function fakeAdapter(behaviour: { check?: () => Promise<void>; download?: () => Promise<void> } = {}): FakeAdapter {
	const handlers = new Map<string, ((payload: unknown) => void)[]>();
	const calls: FakeAdapter["calls"] = { check: 0, download: 0, install: [] };
	const adapter: FakeAdapter = {
		autoDownload: true,
		autoInstallOnAppQuit: true,
		fullChangelog: false,
		on(event, listener) {
			const list = handlers.get(event) ?? [];
			list.push(listener);
			handlers.set(event, list);
			return adapter;
		},
		emit(event, payload) {
			for (const listener of handlers.get(event) ?? []) listener(payload);
		},
		async checkForUpdates() {
			calls.check += 1;
			adapter.emit("checking-for-update");
			if (behaviour.check) return behaviour.check();
			adapter.emit("update-available", {
				version: "0.123.0",
				releaseNotes: [{ version: "0.123.0", note: "- 新功能" }],
			});
		},
		async downloadUpdate() {
			calls.download += 1;
			if (behaviour.download) return behaviour.download();
			adapter.emit("update-downloaded", { version: "0.123.0" });
		},
		quitAndInstall(isSilent, isForceRunAfter) {
			calls.install.push(`${String(isSilent)}/${String(isForceRunAfter)}`);
		},
		calls,
	};
	return adapter;
}

/** 手搓一个可控 promise：下载中途失败 / 取消都靠它。 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeController(
	options: {
		adapter?: FakeAdapter | null;
		mode?: { mode: "auto" | "manual"; reason: "ready" | "portable" };
		prefs?: { skipVersion: string | null };
		timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
	} = {},
) {
	const states: UpdaterState[] = [];
	const saved: { skipVersion: string | null }[] = [];
	const prefs = options.prefs ?? { ...DEFAULT_UPDATER_PREFS };
	const controller = createUpdaterController({
		adapter: options.adapter ?? null,
		mode: options.mode ?? AUTO,
		currentVersion: "0.120.0",
		loadPrefs: () => prefs,
		savePrefs: (next) => {
			saved.push({ ...next });
		},
		publish: (state) => states.push(state),
		// 取消下载要有 token：测试里给个空壳，只看状态机行为。
		createCancelToken: () => ({ cancel: () => {} }),
		now: () => 42,
		timers: options.timers,
	});
	return { controller, states, saved };
}

describe("createUpdaterController", () => {
	it("构造时直接给 adapter 也会订阅事件（不用再 attach 一次）", async () => {
		const adapter = fakeAdapter();
		const { controller, states } = makeController({ adapter });
		expect(await controller.check({ manual: true })).toBe(true);
		expect(controller.getState().phase).toBe("available");
		expect(controller.getState().targetVersion).toBe("0.123.0");
		expect(states.some((s) => s.phase === "available")).toBe(true);
	});

	it("attach 关掉自动下载、打开 fullChangelog", () => {
		const adapter = fakeAdapter();
		const { controller } = makeController();
		controller.attach(adapter);
		expect(adapter.autoDownload).toBe(false);
		expect(adapter.fullChangelog).toBe(true);
		expect(adapter.autoInstallOnAppQuit).toBe(true);
	});

	it("检查 → 发现新版：状态从 checking 走到 available 并广播", async () => {
		const adapter = fakeAdapter();
		const { controller, states } = makeController();
		controller.attach(adapter);
		expect(await controller.check({ manual: true })).toBe(true);
		expect(states.map((s) => s.phase)).toEqual(["checking", "checking", "available"]);
		expect(controller.getState().targetVersion).toBe("0.123.0");
		expect(controller.getState().notes).toHaveLength(1);
	});

	it("auto 模式但没接上 autoUpdater 时，check 把失败写进状态而不是静默", async () => {
		const { controller } = makeController();
		expect(await controller.check({ manual: true })).toBe(false);
		expect(controller.getState().phase).toBe("error");
		expect(controller.getState().error).toContain("electron-updater");
	});

	it("manual 模式不联网，check/download/install 都是空操作", async () => {
		const adapter = fakeAdapter();
		const { controller } = makeController({ adapter, mode: MANUAL });
		controller.attach(adapter);
		expect(controller.getState().mode).toBe("manual");
		expect(await controller.check()).toBe(false);
		expect(await controller.download()).toBe(false);
		expect(controller.quitAndInstall()).toBe(false);
		expect(adapter.calls.check).toBe(0);
	});

	it("下载失败会带上分类，取消下载不留下错误", async () => {
		const failing = deferred();
		const adapter = fakeAdapter({ download: () => failing.promise });
		const { controller } = makeController({ adapter });
		controller.attach(adapter);
		await controller.check();

		const pending = controller.download();
		expect(controller.getState().phase).toBe("downloading");
		failing.reject(new Error("ENOSPC: no space left on device"));
		await pending;
		expect(controller.getState().phase).toBe("error");
		expect(controller.getState().errorCode).toBe("disk");

		const cancelled = deferred();
		const adapter2 = fakeAdapter({ download: () => cancelled.promise });
		const second = makeController({ adapter: adapter2 });
		second.controller.attach(adapter2);
		await second.controller.check();
		const download = second.controller.download();
		expect(second.controller.cancelDownload()).toBe(true);
		cancelled.reject(new Error("Cancelled"));
		await download;
		expect(second.controller.getState().phase).toBe("available");
		expect(second.controller.getState().error).toBeNull();
	});

	it("下载完成才能安装；skip 落盘并跳过该版本", async () => {
		const adapter = fakeAdapter();
		const { controller, saved } = makeController({ adapter });
		controller.attach(adapter);
		expect(controller.quitAndInstall()).toBe(false);
		await controller.check();
		expect(controller.quitAndInstall()).toBe(false);
		await controller.download();
		expect(controller.getState().phase).toBe("downloaded");
		expect(controller.quitAndInstall()).toBe(true);
		expect(adapter.calls.install).toEqual(["false/true"]);

		controller.skip("v0.123.0");
		expect(saved.at(-1)).toEqual({ skipVersion: "0.123.0" });
		expect(controller.getState().skippedVersion).toBe("0.123.0");
	});

	it("自检按时启动，成功后按正常间隔排下一次", async () => {
		const timers: {
			fn: (() => void) | null;
			ms: number[];
			setTimeout: (fn: () => void, ms: number) => unknown;
			clearTimeout: (h: unknown) => void;
		} = {
			fn: null,
			ms: [],
			setTimeout: (fn, ms) => {
				timers.fn = fn;
				timers.ms.push(ms);
				return 1;
			},
			clearTimeout: () => {},
		};
		const adapter = fakeAdapter();
		const { controller } = makeController({ adapter, timers });
		controller.attach(adapter);
		controller.start();
		expect(timers.ms).toEqual([15_000]);

		timers.fn?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(adapter.calls.check).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(timers.ms[1]).toBe(6 * 60 * 60 * 1000);

		controller.dispose();
	});

	it("自检失败退避到更长的间隔", async () => {
		const timers: {
			fn: (() => void) | null;
			ms: number[];
			setTimeout: (fn: () => void, ms: number) => unknown;
			clearTimeout: (h: unknown) => void;
		} = {
			fn: null,
			ms: [],
			setTimeout: (fn, ms) => {
				timers.fn = fn;
				timers.ms.push(ms);
				return 1;
			},
			clearTimeout: () => {},
		};
		const adapter = fakeAdapter({ check: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
		const { controller } = makeController({ adapter, timers });
		controller.attach(adapter);
		controller.start();
		timers.fn?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(controller.getState().errorCode).toBe("network");
		expect(timers.ms[1]).toBe(12 * 60 * 60 * 1000);
		controller.dispose();
	});
});
