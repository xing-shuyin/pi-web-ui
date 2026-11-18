import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOWNLOADS_SCRIPT, getDownloadsScript, scriptLiteral } from "../../browser/runtime/downloads.js";

const SCRIPT_JS = readFileSync(new URL("../../browser/renderer/downloads.js", import.meta.url), "utf8");
const MANAGER_TS = readFileSync(new URL("../../browser/runtime/manager.ts", import.meta.url), "utf8");
const BUILD_MJS = readFileSync(new URL("../../scripts/build-browser.mjs", import.meta.url), "utf8");

describe("下载悬浮圆钮", () => {
	it("注入脚本能取到，并且打包时会被复制进 dist", () => {
		expect(getDownloadsScript()).toContain("__PI_DOWNLOADS__");
		expect(DOWNLOADS_SCRIPT).toContain("__PI_DOWNLOADS__");
		// 打包漏了这份，装包后就只有「下载没提示」
		expect(BUILD_MJS).toContain('"downloads.js"');
	});

	it("只做单向显示：不碰 innerHTML，也不给网页任何反向能力", () => {
		expect(SCRIPT_JS).not.toMatch(/\.innerHTML\s*=/);
		expect(SCRIPT_JS).toContain("createElementNS");
		// 页面里能调到的只有 update()/items：不许出现任何宿主能力（打开文件、读目录、调桥）
		const exposed = SCRIPT_JS.slice(SCRIPT_JS.indexOf("window.__PI_DOWNLOADS__ = {"));
		expect(exposed).toContain("update(next)");
		expect(exposed).not.toMatch(/piBrowserShell|__piBrowser|pageCall|require\(|ipcRenderer/);
	});

	it("站点清空 body 后能重新挂回去，且没有标题栏/新标签页上重复挂", () => {
		expect(SCRIPT_JS).toContain("MutationObserver");
		expect(SCRIPT_JS).toContain('location.pathname.includes("newtab.html")');
		expect(SCRIPT_JS).toContain('location.pathname.includes("shell.html")');
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
