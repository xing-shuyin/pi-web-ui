// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { ENGINE_CATALOG } from "../../server/engine-catalog";
import { EnginePicker, SUPPORTED_ENGINES } from "../../web/src/components/EnginePicker.js";
import { LanguageProvider } from "../../web/src/i18n.js";

describe("引擎列表元数据与安装检测 (SUPPORTED_ENGINES & EnginePicker)", () => {
	let container: HTMLDivElement;
	let sentMessages: any[] = [];
	let runCommandEvents: CustomEvent[] = [];
	const onRunCommand = (e: Event) => {
		runCommandEvents.push(e as CustomEvent);
	};

	beforeEach(() => {
		sentMessages = [];
		runCommandEvents = [];
		setAppSend((msg) => {
			sentMessages.push(msg);
			return true;
		});
		localStorage.setItem("pi-web-ui:lang", "zh");

		container = document.createElement("div");
		document.body.appendChild(container);

		window.addEventListener("pi-web-ui:plugin-run-command", onRunCommand);
	});

	afterEach(() => {
		window.removeEventListener("pi-web-ui:plugin-run-command", onRunCommand);
		resetAppGlobals();
		setAppSend(null);
		document.body.innerHTML = "";
	});

	it("SUPPORTED_ENGINES 完整定义了各引擎的全局包名与一键安装命令", () => {
		const pi = SUPPORTED_ENGINES.find((e) => e.id === "pi");
		const dsh = SUPPORTED_ENGINES.find((e) => e.id === "dsh");
		const claude = SUPPORTED_ENGINES.find((e) => e.id === "claude");

		expect(pi).toBeDefined();
		expect(pi?.packageName).toBe("@earendil-works/pi-coding-agent");

		// DSH 的可卸载包与安装命令同时覆盖 TUI，避免只装库却启动不了 dsh-tui。
		expect(dsh).toBeDefined();
		expect(dsh?.packageName).toBe("@deepseek-ai/dsh");
		expect(dsh?.installCommand).toBe("npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui");

		expect(claude).toBeDefined();
		expect(claude?.packageName).toBe("@anthropic-ai/claude-code");
		expect(claude?.installCommand).toBe("npm i -g @anthropic-ai/claude-code");
		const codex = SUPPORTED_ENGINES.find((e) => e.id === "codex");
		expect(codex?.packageName).toBe("@openai/codex");
		expect(codex?.installCommand).toBe("npm i -g @openai/codex");
	});

	it("包名与安装命令单一来源于引擎目录，界面不再手抄一份", () => {
		for (const item of SUPPORTED_ENGINES) {
			const engine = ENGINE_CATALOG[item.id as keyof typeof ENGINE_CATALOG];
			expect(item.packageName).toBe(engine.packageName);
			expect(item.installCommand).toBe(engine.installCommand);
		}
	});

	it("未安装的引擎显示「未安装」标签与「安装」按钮，且点击无法切换引擎只能触发安装终端", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: false, packageName: "@deepseek-ai/dsh" },
				{ id: "claude", installed: false, packageName: "@anthropic-ai/claude-code" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		expect(triggerBtn).toBeTruthy();
		act(() => {
			triggerBtn.click();
		});

		expect(sentMessages).toContainEqual({ type: "check_engines" });

		const items = container.querySelectorAll(".engine-picker-item");
		expect(items.length).toBe(SUPPORTED_ENGINES.length);

		const dshItem = Array.from(items).find((el) => el.classList.contains("engine-dsh")) as HTMLElement;
		expect(dshItem).toBeTruthy();
		expect(dshItem.classList.contains("uninstalled")).toBe(true);

		const uninstalledTag = dshItem.querySelector(".engine-picker-item-tag.uninstalled");
		expect(uninstalledTag).toBeTruthy();
		expect(uninstalledTag?.textContent).toBe("未安装");

		const installBtn = dshItem.querySelector(".engine-picker-install-btn") as HTMLButtonElement;
		expect(installBtn).toBeTruthy();
		expect(installBtn.textContent).toContain("安装");

		sentMessages = [];
		act(() => {
			installBtn.click();
		});
		expect(sentMessages.filter((m) => m.type === "switch_engine")).toHaveLength(0);
		expect(runCommandEvents).toHaveLength(1);
		expect(runCommandEvents[0].detail.command).toBe("npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui");
		expect(runCommandEvents[0].detail.title).toBe("安装 DSH 引擎");

		act(() => {
			triggerBtn.click();
		});
		const newDshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(newDshItem).toBeTruthy();
		act(() => {
			newDshItem.click();
		});
		expect(sentMessages.filter((m) => m.type === "switch_engine")).toHaveLength(0);
		expect(runCommandEvents).toHaveLength(2);
	});

	it("已安装的引擎显示特色定位标签、不显示安装按钮，点击正常触发 switch_engine 切换", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: true, packageName: "@deepseek-ai/dsh", version: "0.2.0" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();
		expect(dshItem.classList.contains("uninstalled")).toBe(false);

		expect(dshItem.querySelector(".engine-picker-item-tag.uninstalled")).toBeNull();
		expect(dshItem.querySelector(".engine-picker-install-btn")).toBeNull();

		sentMessages = [];
		act(() => {
			dshItem.click();
		});
		expect(sentMessages).toContainEqual({ type: "switch_engine", engine: "dsh" });
		expect(runCommandEvents).toHaveLength(0);
	});

	it("已安装的 Codex 可从选择器切换", () => {
		setAppGlobals({ engine: "pi", engines: [{ id: "codex", installed: true, packageName: "@openai/codex" }] });
		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});
		act(() => {
			(container.querySelector(".engine-picker-btn") as HTMLElement).click();
		});
		const item = container.querySelector(".engine-picker-item.engine-codex") as HTMLElement;
		expect(item.textContent).toContain("CODEX");
		expect(item.querySelector(".engine-picker-install-btn")).toBeNull();
		act(() => {
			item.click();
		});
		expect(sentMessages).toContainEqual({ type: "switch_engine", engine: "codex" });
		act(() => root.unmount());
	});

	it("已安装但存在新版本的引擎显示「可更新」标签与「更新」按钮，点击更新按钮触发全局包更新", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{
					id: "dsh",
					installed: true,
					packageName: "@deepseek-ai/dsh",
					version: "0.1.0",
					latestVersion: "0.2.0",
					hasUpdate: true,
				},
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();

		const updateTag = dshItem.querySelector(".engine-picker-item-tag.update-available");
		expect(updateTag).toBeTruthy();
		expect(updateTag?.textContent).toBe("可更新");

		const updateBtn = dshItem.querySelector(".engine-picker-update-btn") as HTMLButtonElement;
		expect(updateBtn).toBeTruthy();
		expect(updateBtn.textContent).toContain("更新");

		sentMessages = [];
		act(() => {
			updateBtn.click();
		});
		expect(sentMessages.filter((m) => m.type === "switch_engine")).toHaveLength(0);
		expect(runCommandEvents).toHaveLength(0);
		expect(sentMessages).toContainEqual({ type: "update_engine", engineId: "dsh" });

		act(() => {
			triggerBtn.click();
		});
		const newDshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		act(() => {
			newDshItem.click();
		});
		expect(sentMessages).toContainEqual({ type: "switch_engine", engine: "dsh" });
	});

	it("正在执行后台更新的引擎显示「更新中…」标签与禁用旋转按钮，点击不重复触发更新", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{
					id: "dsh",
					installed: true,
					packageName: "@deepseek-ai/dsh",
					version: "0.1.0",
					latestVersion: "0.2.0",
					hasUpdate: true,
					updating: true,
				},
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();

		const updateTag = dshItem.querySelector(".engine-picker-item-tag.update-available");
		expect(updateTag).toBeTruthy();
		expect(updateTag?.textContent).toBe("更新中…");

		const updateBtn = dshItem.querySelector(".engine-picker-update-btn") as HTMLButtonElement;
		expect(updateBtn).toBeTruthy();
		expect(updateBtn.disabled).toBe(true);
		expect(updateBtn.textContent).toContain("更新中…");
		expect(updateBtn.querySelector(".engine-update-icon.spinning")).toBeTruthy();

		sentMessages = [];
		act(() => {
			updateBtn.click();
		});
		expect(sentMessages.filter((m) => m.type === "update_engine")).toHaveLength(0);
	});

	it("底栏模式 (bar='bottom') 自动向上弹出 (direction='up') 且默认启用 Portal 挂载到 document.body", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: true, packageName: "@deepseek-ai/dsh" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, { bar: "bottom" })));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		expect(triggerBtn).toBeTruthy();

		act(() => {
			triggerBtn.click();
		});

		const portalWrapper = document.body.querySelector(".dd-portal-wrapper.dd-up") as HTMLElement;
		expect(portalWrapper).toBeTruthy();

		const menuInBody = document.body.querySelector(".engine-picker-menu") as HTMLElement;
		expect(menuInBody).toBeTruthy();
		expect(container.querySelector(".engine-picker-menu")).toBeNull();
	});

	it("已安装的第三方引擎显示「卸载」按钮，首次点击提示二次确认「确认卸载？」，再次点击发送 uninstall_engine 消息", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: true, packageName: "@deepseek-ai/dsh", version: "0.1.0" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();

		const uninstallBtn = dshItem.querySelector(".engine-picker-uninstall-btn") as HTMLButtonElement;
		expect(uninstallBtn).toBeTruthy();
		expect(uninstallBtn.textContent).toContain("卸载");
		expect(uninstallBtn.disabled).toBe(false);

		sentMessages = [];
		act(() => {
			uninstallBtn.click();
		});
		expect(sentMessages).toHaveLength(0);
		expect(uninstallBtn.classList.contains("confirm")).toBe(true);
		expect(uninstallBtn.textContent).toContain("确认卸载？");

		act(() => {
			uninstallBtn.click();
		});
		expect(sentMessages).toContainEqual({ type: "uninstall_engine", engineId: "dsh" });
	});

	it("内置核心引擎 pi 不显示卸载按钮", () => {
		setAppGlobals({
			engine: "dsh",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: true, packageName: "@deepseek-ai/dsh", version: "0.1.0" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const piItem = container.querySelector(".engine-picker-item.engine-pi") as HTMLElement;
		expect(piItem).toBeTruthy();
		expect(piItem.querySelector(".engine-picker-uninstall-btn")).toBeNull();
	});

	it("当前激活选中的第三方引擎卸载按钮处于禁用态，不可触发卸载", () => {
		setAppGlobals({
			engine: "dsh",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{ id: "dsh", installed: true, packageName: "@deepseek-ai/dsh", version: "0.1.0" },
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();

		const uninstallBtn = dshItem.querySelector(".engine-picker-uninstall-btn") as HTMLButtonElement;
		expect(uninstallBtn).toBeTruthy();
		expect(uninstallBtn.disabled).toBe(true);

		sentMessages = [];
		act(() => {
			uninstallBtn.click();
		});
		expect(sentMessages).toHaveLength(0);
	});

	it("正在执行后台卸载的引擎显示「卸载中…」标签与禁用按钮，不重复发送卸载消息", () => {
		setAppGlobals({
			engine: "pi",
			engines: [
				{ id: "pi", installed: true, packageName: "@earendil-works/pi-coding-agent" },
				{
					id: "dsh",
					installed: true,
					packageName: "@deepseek-ai/dsh",
					version: "0.1.0",
					uninstalling: true,
				},
			],
		});

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LanguageProvider, null, createElement(EnginePicker, null)));
		});

		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLElement;
		act(() => {
			triggerBtn.click();
		});

		const dshItem = container.querySelector(".engine-picker-item.engine-dsh") as HTMLElement;
		expect(dshItem).toBeTruthy();

		const uninstallTag = dshItem.querySelector(".engine-picker-item-tag.uninstalling");
		expect(uninstallTag).toBeTruthy();
		expect(uninstallTag?.textContent).toBe("卸载中…");

		const uninstallBtn = dshItem.querySelector(".engine-picker-uninstall-btn") as HTMLButtonElement;
		expect(uninstallBtn).toBeTruthy();
		expect(uninstallBtn.disabled).toBe(true);
		expect(uninstallBtn.textContent).toContain("卸载中…");

		sentMessages = [];
		act(() => {
			uninstallBtn.click();
		});
		expect(sentMessages.filter((m) => m.type === "uninstall_engine")).toHaveLength(0);
	});
});
