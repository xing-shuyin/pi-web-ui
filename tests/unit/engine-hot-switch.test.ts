import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

describe("双引擎并存与零重启热切换状态持久化 (ClientStateStore)", () => {
	const dirs: string[] = [];

	function makeStore(): { store: ClientStateStore; filePath: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-engine-switch-"));
		dirs.push(dir);
		const filePath = join(dir, "client-state.json");
		return { store: new ClientStateStore(filePath), filePath };
	}

	afterEach(() => {
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("支持多标签页（不同 clientId）各自独立记忆 pi 与 dsh 引擎，且新标签页默认跟随最近一次切换的全局引擎", () => {
		const { store, filePath } = makeStore();

		// 初始未设置时均为 undefined
		expect(store.getDefaultEngine()).toBeUndefined();
		expect(store.getClientEngine("tab-1")).toBeUndefined();
		expect(store.getClientEngine("tab-2")).toBeUndefined();

		// 标签页 1 切换到 dsh，同时更新全局默认引擎为 dsh
		store.saveClientEngine("tab-1", "dsh");
		store.saveDefaultEngine("dsh");

		// 标签页 2 切换到 pi，同时更新全局默认引擎为 pi
		store.saveClientEngine("tab-2", "pi");
		store.saveDefaultEngine("pi");

		// 两个标签页在内存中同时保持各自的引擎
		expect(store.getClientEngine("tab-1")).toBe("dsh");
		expect(store.getClientEngine("tab-2")).toBe("pi");
		expect(store.getDefaultEngine()).toBe("pi");

		// 重新从磁盘加载（模拟页面刷新或服务重启后读取同一份 client-state.json）
		const reloaded = new ClientStateStore(filePath);
		expect(reloaded.getClientEngine("tab-1")).toBe("dsh");
		expect(reloaded.getClientEngine("tab-2")).toBe("pi");
		expect(reloaded.getDefaultEngine()).toBe("pi");
	});
});
