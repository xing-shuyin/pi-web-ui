// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Modal } from "../../web/src/components/Modal.js";
import { LanguageProvider } from "../../web/src/i18n.js";

const ROOT = process.cwd();

describe("Modal 全屏能力与交互", () => {
	it("当 allowFullscreen 未开启时，不渲染全屏按钮，保持标准行为", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		act(() => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(
						Modal,
						{
							open: true,
							title: "普通弹窗",
							onClose: () => {},
						},
						"内容",
					),
				),
			);
		});

		const fullscreenBtn = document.querySelector(".modal-fullscreen-btn");
		expect(fullscreenBtn).toBeNull();
		const modal = document.querySelector(".modal");
		expect(modal?.classList.contains("has-fullscreen-toggle")).toBe(false);

		act(() => root.unmount());
		container.remove();
	});

	it("当 allowFullscreen 开启时，渲染全屏按钮并支持点击切换全屏", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const onFullscreenChange = vi.fn();

		act(() => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(
						Modal,
						{
							open: true,
							title: "文件预览",
							allowFullscreen: true,
							onFullscreenChange,
							onClose: () => {},
						},
						"内容",
					),
				),
			);
		});

		const fullscreenBtn = document.querySelector(".modal-fullscreen-btn") as HTMLButtonElement | null;
		expect(fullscreenBtn).not.toBeNull();
		const modal = document.querySelector(".modal");
		const backdrop = document.querySelector(".modal-backdrop");
		expect(modal?.classList.contains("has-fullscreen-toggle")).toBe(true);
		expect(modal?.classList.contains("fullscreen")).toBe(false);

		act(() => {
			fullscreenBtn?.click();
		});

		expect(modal?.classList.contains("fullscreen")).toBe(true);
		expect(backdrop?.classList.contains("fullscreen")).toBe(true);
		expect(onFullscreenChange).toHaveBeenCalledWith(true);

		act(() => {
			fullscreenBtn?.click();
		});

		expect(modal?.classList.contains("fullscreen")).toBe(false);
		expect(backdrop?.classList.contains("fullscreen")).toBe(false);
		expect(onFullscreenChange).toHaveBeenCalledWith(false);

		act(() => root.unmount());
		container.remove();
	});

	it("双击头部空白区域可在全屏与窗口间快速切换", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		act(() => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(
						Modal,
						{
							open: true,
							title: "双击测试",
							allowFullscreen: true,
							onClose: () => {},
						},
						"内容",
					),
				),
			);
		});

		const modalHead = document.querySelector(".modal-head") as HTMLElement | null;
		expect(modalHead).not.toBeNull();
		const modal = document.querySelector(".modal");

		act(() => {
			modalHead?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(modal?.classList.contains("fullscreen")).toBe(true);

		act(() => {
			modalHead?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(modal?.classList.contains("fullscreen")).toBe(false);

		act(() => root.unmount());
		container.remove();
	});
});

describe("PluginFilePreview CSS 规则守护", () => {
	const css = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

	it("plugin-file-preview 必须显式声明 max-width 且突破 460px 限制", () => {
		const match = css.match(/\.modal\.plugin-file-preview\s*\{([^}]+)\}/);
		expect(match).not.toBeNull();
		const block = match![1];

		expect(block).toContain("max-width:");
		expect(block).not.toContain("max-width: 460px");
		expect(block).toMatch(/max-width:\s*min\(1[0-9]{3}px/);
	});

	it("必须支持全屏模式与无缝内容区填充", () => {
		expect(css).toContain(".modal.plugin-file-preview.fullscreen");
		expect(css).toContain(".modal-backdrop.fullscreen");
		const bodyMatch = css.match(/\.plugin-file-preview-body\s*\{([^}]+)\}/);
		expect(bodyMatch).not.toBeNull();
		expect(bodyMatch![1]).toContain("padding: 0;");
	});
});
