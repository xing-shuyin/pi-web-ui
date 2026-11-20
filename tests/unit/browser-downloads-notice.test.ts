import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOWNLOADS_SCRIPT, getDownloadsScript, scriptLiteral } from "../../browser/runtime/downloads.js";

const SCRIPT_JS = readFileSync(new URL("../../browser/renderer/downloads.js", import.meta.url), "utf8");
const DOCK_JS = readFileSync(new URL("../../browser/renderer/dock.js", import.meta.url), "utf8");
const PRELOAD_CTS = readFileSync(new URL("../../browser/preload.cts", import.meta.url), "utf8");
const HOST_TS = readFileSync(new URL("../../desktop/browser-host.ts", import.meta.url), "utf8");
const MANAGER_TS = readFileSync(new URL("../../browser/runtime/manager.ts", import.meta.url), "utf8");
const BUILD_MJS = readFileSync(new URL("../../scripts/build-browser.mjs", import.meta.url), "utf8");

describe("下载圆钮（右下角悬浮球里那一颗）", () => {
	it("注入脚本能取到，并且打包时会被复制进 dist", () => {
		expect(getDownloadsScript()).toContain("__PI_DOWNLOADS__");
		expect(DOWNLOADS_SCRIPT).toContain("__PI_DOWNLOADS__");
		// 打包漏了这份，装包后就只有「下载没提示」
		expect(BUILD_MJS).toContain('"downloads.js"');
	});

	it("住在悬浮球的插槽里：没有下载任务收起，有任务和刷新钮一起显示", () => {
		// 插槽由 dock 提供，跟着刷新钮一起摆、一起拖动；dock 不在时退回自建宿主
		expect(DOCK_JS).toContain("slot(id)");
		expect(DOCK_JS).toContain("window.__AIB_DOCK__ = { ready: true, remount: ensureMounted, slot }");
		expect(SCRIPT_JS).toContain('dock.slot("downloads")');
		expect(SCRIPT_JS).toContain("root.hidden = items.length === 0");
		// 兜底宿主仍然在右下角，但只在没有 dock 时才建
		expect(SCRIPT_JS).toContain('host.id = "pi-download-host"');
	});

	it("只碰 DOM 的低层 API：不写 innerHTML，图标走 createElementNS", () => {
		expect(SCRIPT_JS).not.toMatch(/\.innerHTML\s*=/);
		expect(SCRIPT_JS).toContain("createElementNS");
		// 样式优先构造式样式表（不吃页面 CSP style-src），拿不到才退回 <style>
		expect(SCRIPT_JS).toContain("adoptedStyleSheets");
	});

	it("反向能力只有一条窄桥：按 id 请宿主定位，路径与命令一个字都不从页面过", () => {
		// 页面里能调的只有 update()/items/reveal(id)：没有打开文件、读目录、拼路径的能力
		expect(SCRIPT_JS).toContain("window.__piDownloads");
		expect(SCRIPT_JS).toContain("bridge.reveal(item.id)");
		expect(SCRIPT_JS).not.toMatch(/piBrowserShell|__piBrowser|pageCall|require\(|ipcRenderer/);
		expect(SCRIPT_JS).not.toContain("openPath");
		// 桥本身只收 id（string），不接受路径 / 命令
		expect(PRELOAD_CTS).toContain('exposeInMainWorld("__piDownloads"');
		expect(PRELOAD_CTS).toContain('invoke("pi-browser:downloads-reveal"');
		// 主进程只按自己的下载记录解析，且只认已完成项；发送方必须是浏览器 session 里的网站 frame
		expect(HOST_TS).toContain('ipcMain.handle("pi-browser:downloads-reveal"');
		expect(HOST_TS).toContain("shell.showItemInFolder(item.path)");
		expect(HOST_TS).toContain('entry.id === id && entry.state === "completed"');
		expect(HOST_TS).toContain("this.webFrameOrigin(event)");
	});

	it("内部页不注入：判据是 file:// 协议，不误杀 github.com 上的同名路径", () => {
		expect(SCRIPT_JS).toContain('location.protocol === "file:"');
		expect(SCRIPT_JS).not.toContain('location.pathname.includes("shell.html")');
		// 主进程侧的闸门同样只认内部页 URL，不再拿 pathname 子串判定
		expect(MANAGER_TS).toContain("!isLocalFile && !this.isInternalPage(current)");
		expect(MANAGER_TS).not.toContain('current.includes("shell.html")');
	});

	it("状态只推当前活动标签，且已结束的任务只留一小会儿", () => {
		expect(MANAGER_TS).toContain("this.injectDownloads(wc)");
		expect(MANAGER_TS).toContain("window.__PI_DOWNLOADS__ && window.__PI_DOWNLOADS__.update(");
		expect(MANAGER_TS).toContain("DOWNLOAD_NOTICE_MS");
		expect(MANAGER_TS).toContain("record.finishedAt = Date.now()");
	});

	it("塞进 executeJavaScript 的字面量不会带出换行/尖括号", () => {
		const literal = scriptLiteral({ filename: "a\u2028b</script>\u2029c" });
		expect(literal).not.toMatch(/[\u2028\u2029]/);
		expect(literal).not.toContain("</");
		expect(JSON.parse(literal)).toEqual({ filename: "a\u2028b</script>\u2029c" });
	});
});
