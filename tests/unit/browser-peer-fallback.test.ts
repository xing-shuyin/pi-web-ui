// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { browserPeerChildScript, browserPeerParentScript } from "../../server/device-center/browser-peer-client.js";
import { wrapperHtml } from "../../server/device-center/path-portal.js";

/**
 * 设备页 wrapper 的浏览器直连（P2P 预览）必须先给 iframe 挂上中转地址才可能显示内容，
 * 而它是 `await window.__piBrowserPeerReady` 之后再挂的：
 * 只要协商 promise 不 settle，用户就永远停在「正在连接设备…」的空白页。
 * 这里用一个「数据通道永远不打开」的假 RTCPeerConnection 复现卡死，
 * 断言硬上限一到就被判失败并回退到 hub 中转（badge 变更 + promise settle）。
 */
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
	delete (window as unknown as Record<string, unknown>).__piBrowserPeerReady;
	delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
});

it("浏览器直连只是后台加速：协商卡死时到上限退到 hub 中转，不会永远卡住", async () => {
	vi.useFakeTimers();
	document.body.innerHTML = '<iframe></iframe><div id="loading"></div>';

	class StuckPeerConnection {
		connectionState = "new";
		iceGatheringState = "complete";
		localDescription = { type: "offer", sdp: "v=0" };
		onconnectionstatechange: (() => void) | null = null;
		createDataChannel() {
			return { readyState: "connecting", close() {} };
		}
		createOffer() {
			return Promise.resolve({ type: "offer", sdp: "v=0" });
		}
		setLocalDescription() {
			return Promise.resolve();
		}
		/** 关键：协商永远不结束（真实环境里 WebRTC 也可能这样卡住）。 */
		setRemoteDescription() {
			return new Promise(() => {});
		}
		getStats() {
			return Promise.resolve(new Map());
		}
		close() {}
	}

	const win = window as unknown as Record<string, unknown>;
	win.RTCPeerConnection = StuckPeerConnection;
	win.AbortSignal = Object.assign(AbortSignal, { timeout: () => new AbortController().signal });
	win.fetch = vi.fn(async () => ({
		ok: true,
		json: async () => ({ version: 1, key: "a".repeat(64), signal: { version: 1, sdp: "v=0" } }),
	}));

	new Function(browserPeerParentScript("https://hub.test/device/x/__relay/token/", "/signal"))();

	const ready = win.__piBrowserPeerReady as Promise<void>;
	expect(ready).toBeInstanceOf(Promise);
	await vi.advanceTimersByTimeAsync(21000);
	await expect(ready).resolves.toBeUndefined();
	expect(document.getElementById("browser-route")?.textContent).toContain("Hub relay");
});

it("首屏先给中转地址：wrapper 不再等直连协商才设 iframe.src", () => {
	const base = "https://hub.test/device/dev/__relay/token/";
	const wrapper = wrapperHtml(
		base,
		"",
		undefined,
		"Device",
		undefined,
		undefined,
		"hub",
		undefined,
		undefined,
		undefined,
		undefined,
		base + "__browser_p2p",
	);
	const connectAt = wrapper.html.indexOf("const connect=");
	expect(connectAt).toBeGreaterThan(0);
	const srcAt = wrapper.html.indexOf("frame.src=", connectAt);
	expect(srcAt).toBeGreaterThan(connectAt);
	// 直连协商在 peerParent 里后台跑；connect() 内不得再 await 它
	expect(wrapper.html.slice(connectAt, srcAt)).not.toContain("__piBrowserPeerReady");
	expect(wrapper.html).toContain("device-p2p-upgraded");
	expect(wrapper.html).toContain("device-p2p-lost");
});
