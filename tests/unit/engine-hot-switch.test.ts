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
			} catch {}
		}
	});

	it("支持多标签页（不同 clientId）各自独立记忆 pi、dsh 与 claude 引擎，且新标签页默认跟随最近一次切换的全局引擎", () => {
		const { store, filePath } = makeStore();

		expect(store.getDefaultEngine()).toBeUndefined();
		expect(store.getClientEngine("tab-1")).toBeUndefined();
		expect(store.getClientEngine("tab-2")).toBeUndefined();
		expect(store.getClientEngine("tab-3")).toBeUndefined();

		store.saveClientEngine("tab-1", "dsh");
		store.saveDefaultEngine("dsh");

		store.saveClientEngine("tab-2", "claude");
		store.saveDefaultEngine("claude");

		store.saveClientEngine("tab-3", "pi");
		store.saveDefaultEngine("pi");

		expect(store.getClientEngine("tab-1")).toBe("dsh");
		expect(store.getClientEngine("tab-2")).toBe("claude");
		expect(store.getClientEngine("tab-3")).toBe("pi");
		expect(store.getDefaultEngine()).toBe("pi");

		const reloaded = new ClientStateStore(filePath);
		expect(reloaded.getClientEngine("tab-1")).toBe("dsh");
		expect(reloaded.getClientEngine("tab-2")).toBe("claude");
		expect(reloaded.getClientEngine("tab-3")).toBe("pi");
		expect(reloaded.getDefaultEngine()).toBe("pi");
	});
});
