import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

/**
 * 桌面更新通道的守卫：主进程的 IPC、preload 暴露的桥、渲染层的桥三者必须对齐。
 * 少一处就会出现「面板点了没反应」——而且只在打包版里才看得出来，所以放在单测里拦。
 */
const root = cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const mainSource = read("desktop/main.ts");
const preloadSource = read("desktop/preload.cts");
const webSource = read("web/src/desktop-updater.ts");

const CHANNELS = [
	"pi-desktop-updater:state",
	"pi-desktop-updater:check",
	"pi-desktop-updater:download",
	"pi-desktop-updater:cancel",
	"pi-desktop-updater:skip",
	"pi-desktop-updater:quit-install",
] as const;

function handledChannels(source: string): Set<string> {
	return new Set([...source.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
}

describe("桌面更新 IPC 三面对齐", () => {
	it("主进程注册了全部更新通道", () => {
		const handled = handledChannels(mainSource);
		for (const channel of CHANNELS) expect(handled.has(channel), channel).toBe(true);
	});

	it("preload 只暴露主进程真的有的通道", () => {
		const handled = handledChannels(mainSource);
		const exposed = [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*"(pi-desktop-updater:[^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(exposed.length).toBeGreaterThan(0);
		for (const channel of new Set(exposed)) expect(handled.has(channel), channel).toBe(true);
	});

	it("广播通道与订阅通道同名", () => {
		expect(mainSource).toContain('const UPDATER_EVENT_CHANNEL = "pi-desktop-updater:event"');
		expect(preloadSource).toContain('ipcRenderer.on("pi-desktop-updater:event"');
	});

	it("渲染层桥的方法都在 preload 里实现", () => {
		for (const method of [
			"getState",
			"check",
			"download",
			"cancel",
			"skip",
			"quitAndInstall",
			"applyRuntime",
			"onEvent",
		]) {
			expect(webSource.includes(`${method}`), method).toBe(true);
			expect(preloadSource.includes(`${method}:`), method).toBe(true);
		}
	});

	it("更新状态只有一份：main.ts 不再自己拼增量事件", () => {
		expect(mainSource).not.toContain("pushUpdaterEvent");
		expect(mainSource).not.toContain("interface DesktopUpdaterEvent");
		// 检查和下载只能经过状态机：main.ts 一次都不直接调，适配器里各只有一处。
		expect(mainSource.match(/autoUpdater\.(checkForUpdates|downloadUpdate)\(/g) ?? []).toHaveLength(0);
		const updaterSource = read("desktop/updater.ts");
		expect(updaterSource.match(/autoUpdater\.checkForUpdates\(\)/g) ?? []).toHaveLength(1);
		expect(updaterSource.match(/autoUpdater\.downloadUpdate\(/g) ?? []).toHaveLength(1);
	});
});
