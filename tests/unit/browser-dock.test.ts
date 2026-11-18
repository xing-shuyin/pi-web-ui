import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCK_JS = readFileSync(new URL("../../browser/renderer/dock.js", import.meta.url), "utf8");
const DOCK_TS = readFileSync(new URL("../../browser/runtime/dock.ts", import.meta.url), "utf8");

describe("浏览器悬浮 Dock 注入脚本", () => {
	it("静态模板走 Trusted Types，避免启用 TrustedHTML 的站点直接抛错", () => {
		for (const source of [DOCK_JS, DOCK_TS]) {
			expect(source).toContain("trustedTypes.createPolicy");
			expect(source).toContain("setMarkup(");
			expect(source).not.toMatch(/\.innerHTML\s*=\s*`/);
		}
		expect(DOCK_JS).not.toContain("selectFolder.innerHTML");
	});

	it("宿主节点被站点移除后能重新挂载，重复注入不会建出第二个 Dock", () => {
		for (const source of [DOCK_JS, DOCK_TS]) {
			expect(source).toContain("MutationObserver");
			expect(source).toContain("if (!host.isConnected) document.body.appendChild(host)");
			expect(source).toContain("existingDock.ready");
		}
	});
});
