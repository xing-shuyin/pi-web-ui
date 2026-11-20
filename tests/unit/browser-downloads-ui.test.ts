// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 下载圆钮的页面行为（真跑一遍脚本，不是读源码猜）：
 * 没有任务时整颗收起、有任务时挂进悬浮球插槽、已完成项只把 id 交给窄桥。
 */
const REPO = path.resolve(__dirname, "../..");
const DOCK_JS = readFileSync(path.join(REPO, "browser/renderer/dock.js"), "utf8");
const DOWNLOADS_JS = readFileSync(path.join(REPO, "browser/renderer/downloads.js"), "utf8");

type AnyWindow = Window & {
	__AIB_DOCK__?: { ready: boolean; slot(id: string): HTMLElement | null };
	__PI_DOWNLOADS__?: { update(list: unknown[]): void; items: unknown[] };
	__piDownloads?: { reveal(id: string): Promise<boolean> };
};

const w = window as AnyWindow;

function bootDock(): ShadowRoot {
	new Function(DOCK_JS)();
	const host = document.getElementById("ai-browser-dock-host");
	if (!host?.shadowRoot) throw new Error("dock host missing");
	return host.shadowRoot;
}

function bootDownloads(): ShadowRoot {
	new Function(DOWNLOADS_JS)();
	const host = document.getElementById("ai-browser-dock-host");
	if (!host?.shadowRoot) throw new Error("dock host missing");
	return host.shadowRoot;
}

const completed = {
	id: "dl-1",
	filename: "report.zip",
	state: "completed",
	receivedBytes: 2048,
	totalBytes: 2048,
	path: "C:/Users/me/Downloads/report.zip",
};

beforeEach(() => {
	document.body.replaceChildren();
	window.history.replaceState({}, "", "/");
	window.localStorage.clear();
	delete w.__AIB_DOCK__;
	delete w.__PI_DOWNLOADS__;
	delete w.__piDownloads;
	vi.useFakeTimers();
});

describe("下载圆钮（页面注入）", () => {
	it("没有任务就整颗收起，有任务才和刷新钮一起出现在同一列", () => {
		const shadow = bootDock();
		bootDownloads();
		const root = shadow.querySelector(".dock-slot-item .pi-dl-root") as HTMLElement;
		expect(root).toBeTruthy();
		// 初始没有任务：收起
		expect(root.hidden).toBe(true);
		// 刷新钮仍然在（它不归下载管）
		expect(shadow.querySelector(".dock-main-btn")).toBeTruthy();

		w.__PI_DOWNLOADS__!.update([completed]);
		expect(root.hidden).toBe(false);
		// 新任务自动亮出面板，行里是文件名 + 两颗药丸
		const panel = shadow.querySelector(".pi-dl-panel") as HTMLElement;
		expect(panel.hidden).toBe(false);
		expect(panel.textContent).toContain("report.zip");
		expect(panel.textContent).toContain("打开文件夹");
		expect(panel.textContent).toContain("复制路径");
	});

	it("点「打开文件夹」只把 id 交给窄桥，回执如实反映结果", async () => {
		const shadow = bootDock();
		const reveal = vi.fn(async () => true);
		w.__piDownloads = { reveal };
		bootDownloads();
		w.__PI_DOWNLOADS__!.update([completed]);

		const folder = [...shadow.querySelectorAll(".pi-dl-btn")].find(
			(node) => node.textContent === "打开文件夹",
		) as HTMLButtonElement;
		folder.click();
		await Promise.resolve();
		await Promise.resolve();
		// 只传 id：路径与命令一个字都不从页面过
		expect(reveal).toHaveBeenCalledWith("dl-1");
		expect(shadow.querySelector(".pi-dl-meta")!.textContent).toBe("已在文件管理器中显示");
	});

	it("宿主拒绝 / 桥不在时不假装成功", async () => {
		const shadow = bootDock();
		w.__piDownloads = { reveal: vi.fn(async () => false) };
		bootDownloads();
		w.__PI_DOWNLOADS__!.update([completed]);
		const folder = () =>
			[...shadow.querySelectorAll(".pi-dl-btn")].find((node) => node.textContent === "打开文件夹") as HTMLButtonElement;

		folder().click();
		await Promise.resolve();
		await Promise.resolve();
		expect(shadow.querySelector(".pi-dl-meta")!.textContent).toContain("打不开");

		// 桥被去掉（老宿主 / 内部页）：如实说桥没就绪
		delete w.__piDownloads;
		folder().click();
		await Promise.resolve();
		expect(shadow.querySelector(".pi-dl-meta")!.textContent).toContain("浏览器桥未就绪");
	});

	it("dock 不在（smartDock 关掉）时退回自建右下角宿主，功能照旧", () => {
		bootDownloads();
		const host = document.getElementById("pi-download-host");
		expect(host?.shadowRoot).toBeTruthy();
		const root = host!.shadowRoot!.querySelector(".pi-dl-root") as HTMLElement;
		expect(root.hidden).toBe(true);
		w.__PI_DOWNLOADS__!.update([completed]);
		expect(root.hidden).toBe(false);
	});
});

describe("悬浮球（dock）在站点上的自己救回来", () => {
	it("路径里带 shell.html 的正常网页照样注入：判据是 file:// 协议，不误杀 GitHub blob 页", () => {
		window.history.replaceState({}, "", "/xing-shuyin/pi-web-ui/blob/main/browser/renderer/shell.html");
		const shadow = bootDock();
		expect(document.getElementById("ai-browser-dock-host")).toBeTruthy();
		expect(shadow.querySelector(".dock-main-btn")).toBeTruthy();
	});

	it("存下来的位置按当前视口夹一遍：窄窗口里不会把整颗钮扔到屏幕外", () => {
		// 宽窗口里拖到右下角存下的坐标，换成窄窗口（分栏 / 还原）也不该跑出视口
		window.localStorage.setItem("__aib_dock_pos", JSON.stringify({ right: 5000, bottom: 5000 }));
		bootDock();
		const dock = (document.getElementById("ai-browser-dock-host") as HTMLElement).shadowRoot!.querySelector(
			".dock-container",
		) as HTMLElement;
		expect(parseInt(dock.style.right, 10)).toBeLessThanOrEqual(window.innerWidth - 44);
		expect(parseInt(dock.style.bottom, 10)).toBeLessThanOrEqual(window.innerHeight - 44);
		expect(parseInt(dock.style.right, 10)).toBeGreaterThan(0);
	});
});
