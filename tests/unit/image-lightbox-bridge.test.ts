/**
 * 图片灯箱桥单测（web/src/image-lightbox-bridge.ts）：注册/注销/受理/关闭/状态查询。
 * 纯模块级 sink，无 DOM API 依赖（node 环境可跑）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeImageLightbox,
	isImageLightboxOpen,
	isImageLightboxReady,
	openImageLightbox,
	registerImageLightboxHost,
	resetImageLightboxHost,
} from "../../web/src/image-lightbox-bridge.js";

beforeEach(() => {
	resetImageLightboxHost();
});

describe("image-lightbox-bridge", () => {
	it("没有宿主时不受理", () => {
		expect(isImageLightboxReady()).toBe(false);
		expect(openImageLightbox({ src: "data:image/png;base64,abc" })).toBe(false);
	});

	it("注册后把目标转给宿主 open", () => {
		const open = vi.fn();
		const close = vi.fn();
		registerImageLightboxHost({ open, close });
		expect(isImageLightboxReady()).toBe(true);
		expect(openImageLightbox({ src: "data:image/png;base64,abc", alt: "my-pic" })).toBe(true);
		expect(open).toHaveBeenCalledWith({ src: "data:image/png;base64,abc", alt: "my-pic" });
	});

	it("src 为空时不转（脏数据不触发打开）", () => {
		const open = vi.fn();
		const close = vi.fn();
		registerImageLightboxHost({ open, close });
		expect(openImageLightbox({ src: "" })).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("调用 closeImageLightbox 触发宿主 close", () => {
		const open = vi.fn();
		const close = vi.fn();
		registerImageLightboxHost({ open, close });
		closeImageLightbox();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("注销后不再受理", () => {
		const open = vi.fn();
		const close = vi.fn();
		registerImageLightboxHost({ open, close });
		registerImageLightboxHost(null);
		expect(isImageLightboxReady()).toBe(false);
		expect(openImageLightbox({ src: "http://example.com/pic.png" })).toBe(false);
	});

	it("isOpen 透传宿主状态；宿主没给 checker 时为 false", () => {
		registerImageLightboxHost({ open: vi.fn(), close: vi.fn(), isOpen: () => true });
		expect(isImageLightboxOpen()).toBe(true);
		registerImageLightboxHost({ open: vi.fn(), close: vi.fn() });
		expect(isImageLightboxOpen()).toBe(false);
	});

	it("后注册的覆盖先前的（重复挂载不留旧 sink）", () => {
		const firstOpen = vi.fn();
		const secondOpen = vi.fn();
		registerImageLightboxHost({ open: firstOpen, close: vi.fn() });
		registerImageLightboxHost({ open: secondOpen, close: vi.fn() });
		openImageLightbox({ src: "http://example.com/a.png" });
		expect(firstOpen).not.toHaveBeenCalled();
		expect(secondOpen).toHaveBeenCalledTimes(1);
	});
});
