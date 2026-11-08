// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	OVERLAY_STACK_BASE,
	OVERLAY_STACK_MAX,
	OVERLAY_STACK_STEP,
	overlayStackSize,
	overlayZIndexAt,
	resetOverlayStack,
	useOverlayZIndex,
} from "../../web/src/overlay-stack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES_CSS = join(ROOT, "web", "src", "styles.css");
const THEMES_DIR = join(ROOT, "themes");
const SRC_DIR = join(ROOT, "web", "src");

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function listCssFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".css")) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

/** 抽出所有写死的 z-index 数值（var(...) 形式的不算写死）。 */
function literalZIndexes(css: string): { value: number; raw: string }[] {
	const out: { value: number; raw: string }[] = [];
	for (const match of css.matchAll(/z-index:\s*([^;{}]+);/g)) {
		const raw = match[1].trim();
		if (raw.startsWith("var(")) continue;
		const value = Number.parseInt(raw, 10);
		if (Number.isFinite(value)) out.push({ value, raw });
	}
	return out;
}

const probes = new Map<string, number>();

function Probe({ name, active = true }: { name: string; active?: boolean }) {
	const zIndex = useOverlayZIndex(active);
	probes.set(name, zIndex);
	return createElement("div", { "data-probe": name });
}

function Stack({ names, inactive = [] }: { names: string[]; inactive?: string[] }) {
	return createElement(
		"div",
		null,
		names.map((name) => createElement(Probe, { key: name, name, active: !inactive.includes(name) })),
	) as ReactNode;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(children: ReactNode): void {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(children));
}

function rerender(children: ReactNode): void {
	act(() => root?.render(children));
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	probes.clear();
	resetOverlayStack();
});

describe("浮层叠栈（overlay stack）", () => {
	it("后打开的浮层永远更高，先开的从叠栈底线起算", () => {
		mount(createElement(Stack, { names: ["message", "inspector"] }));
		expect(probes.get("message")).toBe(OVERLAY_STACK_BASE);
		expect(probes.get("inspector")).toBe(OVERLAY_STACK_BASE + OVERLAY_STACK_STEP);
		expect(overlayStackSize()).toBe(2);

		// 工具详情里再点开图片预览（本次修复的场景）
		rerender(createElement(Stack, { names: ["message", "inspector", "lightbox"] }));
		expect(probes.get("lightbox")!).toBeGreaterThan(probes.get("inspector")!);
	});

	it("关掉中间那层后，上面那层自动往下收，不留空洞", () => {
		mount(createElement(Stack, { names: ["message", "inspector", "lightbox"] }));
		expect(probes.get("lightbox")).toBe(OVERLAY_STACK_BASE + OVERLAY_STACK_STEP * 2);

		rerender(createElement(Stack, { names: ["message", "lightbox"] }));
		expect(probes.get("lightbox")).toBe(OVERLAY_STACK_BASE + OVERLAY_STACK_STEP);
		expect(overlayStackSize()).toBe(2);
	});

	it("不显示的浮层不占层（不会把别的东西顶上去）", () => {
		mount(createElement(Stack, { names: ["message", "idle", "inspector"], inactive: ["idle"] }));
		expect(probes.get("inspector")).toBe(OVERLAY_STACK_BASE + OVERLAY_STACK_STEP);
	});

	it("层数再深也压在临时通知之下（封顶 MAX）", () => {
		const names = Array.from({ length: 12 }, (_, i) => `layer-${i}`);
		mount(createElement(Stack, { names }));
		for (const name of names) expect(probes.get(name)!).toBeLessThanOrEqual(OVERLAY_STACK_MAX);
		expect(probes.get(names[names.length - 1])).toBe(OVERLAY_STACK_MAX);
		expect(overlayZIndexAt(999)).toBe(OVERLAY_STACK_MAX);
	});
});

describe("浮层层级的样式契约", () => {
	it("styles.css 暴露叠栈起点与通知锚点，且通知永远在叠栈之上", () => {
		const css = readText(STYLES_CSS);
		const stackToken = css.match(/--z-overlay-stack:\s*(\d+);/);
		const noticeToken = css.match(/--z-notice:\s*(\d+);/);
		expect(stackToken, "--z-overlay-stack 缺失").not.toBeNull();
		expect(noticeToken, "--z-notice 缺失").not.toBeNull();
		expect(Number(stackToken![1])).toBe(OVERLAY_STACK_BASE);
		expect(Number(noticeToken![1])).toBeGreaterThan(OVERLAY_STACK_MAX);
	});

	it("base 层、主题与其余前端样式里都不许再手写叠栈区间的 z-index", () => {
		const files = [...new Set([...listCssFiles(join(SRC_DIR)), ...listCssFiles(THEMES_DIR)])];
		for (const file of files) {
			for (const { value, raw } of literalZIndexes(readText(file))) {
				expect(
					value < OVERLAY_STACK_BASE,
					`${file} 出现写死的 z-index: ${raw}；叠栈区间的层级必须走 useOverlayZIndex() 或 var(--z-overlay-stack)`,
				).toBe(true);
			}
		}
	});

	it("能从别的浮层里打开的面板都接进叠栈（图片预览 / 工具详情 / 文件预览 / 全屏 diff / 审批）", () => {
		const expectations: { file: string; pattern: RegExp; why: string }[] = [
			{
				file: join(SRC_DIR, "components", "ImageLightbox.tsx"),
				pattern: /useOverlayZIndex\(\)/,
				why: "图片预览会从工具详情/文件预览里打开",
			},
			{
				file: join(SRC_DIR, "components", "ToolInspectorModal.tsx"),
				pattern: /useOverlayZIndex\(\)/,
				why: "工具详情会从消息卡里打开",
			},
			{
				file: join(SRC_DIR, "components", "FilePreview.tsx"),
				pattern: /useOverlayZIndex\(\)/,
				why: "文件预览会从工具详情里打开",
			},
			{
				file: join(SRC_DIR, "components", "FileChangeCard.tsx"),
				pattern: /useOverlayZIndex\(isFullscreen\)/,
				why: "全屏 diff 从卡片（可能已在详情弹窗里）再往上开",
			},
			{
				file: join(SRC_DIR, "components", "ToolApprovalDialog.tsx"),
				pattern: /useOverlayZIndex\(/,
				why: "审批是打断式浮层，必须盖住已打开的预览",
			},
		];
		for (const { file, pattern, why } of expectations) {
			expect(pattern.test(readText(file)), `${file} 未接入叠栈：${why}`).toBe(true);
		}
	});

	it("图片预览的静态层级不得回落到固定的低值（否则又会被详情弹窗压住）", () => {
		const css = readText(STYLES_CSS);
		const rule = css.match(/\.img-lightbox\s*\{[^}]*\}/);
		expect(rule, ".img-lightbox 规则缺失").not.toBeNull();
		expect(rule![0]).toMatch(/z-index:\s*var\(--z-overlay-stack\)/);
	});
});
