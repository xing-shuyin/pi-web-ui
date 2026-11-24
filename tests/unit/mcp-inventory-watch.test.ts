import { describe, expect, it, vi } from "vitest";
import { McpInventoryWatch, type McpInventoryWatchFn } from "../../server/mcp-inventory-watch.js";

/** 假 watcher：拿到每个目录的监听回调，由测试自己触发事件（不存在的目录不会被装上）。 */
function fakeWatch() {
	const entries: {
		dir: string;
		listener: (eventType: string, filename: string | Buffer | null) => void;
		closed: boolean;
	}[] = [];
	const fn: McpInventoryWatchFn = vi.fn((dir, _options, listener) => {
		const entry = { dir, listener, closed: false };
		entries.push(entry);
		return {
			on: () => {},
			// 真 fs 上 `close()` 之后就不会再有事件：假体也按这个口径丢掉监听。
			close: () => {
				entry.closed = true;
			},
		};
	});
	return {
		fn,
		closed: () => entries.filter((entry) => entry.closed).map((entry) => entry.dir),
		fire: (filename: string | Buffer | null = "mcp.json") => {
			for (const entry of entries) if (!entry.closed) entry.listener("change", filename);
		},
	};
}

const paths = () => ({ globalPath: "/agent/mcp.json", projectPath: "/work/.pi/mcp.json" });
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("McpInventoryWatch（mcp.json 只读监听叶子）", () => {
	it("一次保存的多条事件合并成一次通知（防抖）", async () => {
		const fake = fakeWatch();
		const notify = vi.fn();
		const watch = new McpInventoryWatch({ paths, isDisposed: () => false, notify, debounceMs: 10, watchFn: fake.fn });

		watch.watch();
		fake.fire();
		fake.fire();
		fake.fire();
		expect(notify).not.toHaveBeenCalled();
		await tick(40);
		expect(notify).toHaveBeenCalledTimes(1);
		watch.close();
	});

	it("路径没变且已有 watcher 就不重装（重复 watch 幂等）", () => {
		const fake = fakeWatch();
		const watch = new McpInventoryWatch({ paths, isDisposed: () => false, notify: () => {}, watchFn: fake.fn });
		watch.watch();
		// 两份配置各一个目录 → 两个 watcher；它们的目录不同，所以都装。
		expect(fake.fn).toHaveBeenCalledTimes(2);
		watch.watch();
		expect(fake.fn).toHaveBeenCalledTimes(2);
		watch.close();
	});

	it("路径变了就换一份 watcher（先关旧的后装新的）", () => {
		const fake = fakeWatch();
		let projectPath = "/work/.pi/mcp.json";
		const watch = new McpInventoryWatch({
			paths: () => ({ globalPath: "/agent/mcp.json", projectPath }),
			isDisposed: () => false,
			notify: () => {},
			watchFn: fake.fn,
		});
		watch.watch();
		expect(fake.fn).toHaveBeenCalledTimes(2);
		projectPath = "/other/.pi/mcp.json";
		watch.watch();
		expect(fake.fn).toHaveBeenCalledTimes(4);
		expect(fake.closed()).toContain("/work/.pi");
		watch.close();
	});

	it("只认 mcp.json 的事件，其它文件名直接忽略", async () => {
		const fake = fakeWatch();
		const notify = vi.fn();
		const watch = new McpInventoryWatch({ paths, isDisposed: () => false, notify, debounceMs: 10, watchFn: fake.fn });
		watch.watch();
		fake.fire("settings.json");
		await tick(40);
		expect(notify).not.toHaveBeenCalled();
		watch.close();
	});

	it("已释放 / close() 之后不再通知，防抖计时器一并清掉", async () => {
		const fake = fakeWatch();
		const notify = vi.fn();
		let disposed = false;
		const watch = new McpInventoryWatch({
			paths,
			isDisposed: () => disposed,
			notify,
			debounceMs: 10,
			watchFn: fake.fn,
		});
		watch.watch();
		fake.fire();
		disposed = true;
		await tick(40);
		expect(notify).not.toHaveBeenCalled();

		disposed = false;
		watch.close();
		fake.fire();
		await tick(40);
		expect(notify).not.toHaveBeenCalled();
		expect(fake.closed()).toEqual(expect.arrayContaining(["/agent", "/work/.pi"]));
	});
});
