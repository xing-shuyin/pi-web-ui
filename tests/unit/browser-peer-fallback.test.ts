// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
	browserPeerChildScript,
	browserPeerParentScript,
	watchBrowserPeerRoute,
} from "../../server/device-center/browser-peer-client.js";
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

it("follows the selected data-channel ICE pair across route changes and stops observing on close", async () => {
	vi.useFakeTimers();
	const ice = Object.assign(new EventTarget(), { getSelectedCandidatePair: vi.fn() });
	const pc = { sctp: { transport: { iceTransport: ice } }, getStats: vi.fn() };
	const report = vi.fn();
	const select = async (local: string, remote: string, ip: string, host = "computer.local") => {
		ice.getSelectedCandidatePair.mockReturnValue({
			local: { type: local, address: host },
			remote: { type: remote, address: ip },
		});
		ice.dispatchEvent(new Event("selectedcandidatepairchange"));
		await vi.advanceTimersByTimeAsync(0);
	};
	await select("host", "host", "printer.local.");
	const stop = watchBrowserPeerRoute(pc, report, window);
	await vi.advanceTimersByTimeAsync(0);
	expect(report).toHaveBeenLastCalledWith("lan");
	for (const ip of ["169.254.7.4", "fd03:20::8", "fe80::1%en0", "::ffff:192.168.1.4"]) {
		await select("host", "host", ip);
		expect(report).toHaveBeenLastCalledWith("lan");
	}
	await select("host", "host", "2001:db8:0:0:1::1", "2001:db8::2");
	expect(report).toHaveBeenLastCalledWith("lan");
	await select("host", "host", "2001:db8:3::1", "2001:db8::2");
	expect(report).toHaveBeenLastCalledWith("p2p");
	await select("srflx", "host", "192.168.1.4");
	expect(report).toHaveBeenLastCalledWith("p2p");
	await select("host", "srflx", "203.0.113.7");
	expect(report).toHaveBeenLastCalledWith("p2p");
	await select("relay", "host", "192.168.1.4");
	expect(report).toHaveBeenLastCalledWith("turn");
	await select("host", "host", "");
	expect(report).toHaveBeenLastCalledWith("peer");
	stop();
	report.mockClear();
	await select("host", "host", "192.168.1.4");
	await vi.advanceTimersByTimeAsync(10000);
	expect(report).not.toHaveBeenCalled();
});

it("prefers the transport-selected stats pair and never guesses between nominated alternatives", async () => {
	vi.useFakeTimers();
	const stats = new Map<string, any>([
		["local", { type: "local-candidate", candidateType: "host" }],
		["private", { type: "remote-candidate", candidateType: "host", ip: "10.0.0.9" }],
		["relay", { type: "remote-candidate", candidateType: "relay" }],
		...["private", "relay"].map((id): [string, any] => [
			"pair-" + id,
			{ type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: id },
		]),
		["ice", { type: "transport", selectedCandidatePairId: "pair-private" }],
	]);
	const pc = { getStats: vi.fn().mockRejectedValueOnce(new Error("Telemetry unavailable")).mockResolvedValue(stats) };
	const report = vi.fn();
	const stop = watchBrowserPeerRoute(pc, report, window);
	await vi.advanceTimersByTimeAsync(5000);
	expect(report.mock.calls).toEqual([["lan"]]);
	stats.get("ice").selectedCandidatePairId = "pair-relay";
	await vi.advanceTimersByTimeAsync(5000);
	expect(report).toHaveBeenLastCalledWith("turn");
	stats.delete("ice");
	report.mockClear();
	await vi.advanceTimersByTimeAsync(5000);
	expect(report).not.toHaveBeenCalled();
	stats.delete("pair-relay");
	await vi.advanceTimersByTimeAsync(5000);
	expect(report).toHaveBeenLastCalledWith("lan");
	stop();
});

it("bridges only desktop frames and requests belonging to the same device capability", () => {
	const base = "https://hub.test/device/a/__relay/" + "a".repeat(64) + "/";
	const parent = { postMessage: vi.fn() },
		desktop = { postMessage: vi.fn() },
		otherFrame = { postMessage: vi.fn() };
	const listeners: ((event: any) => void)[] = [];
	const win = {
		location: { href: base },
		parent,
		fetch: vi.fn(),
		WebSocket: class {},
		EventTarget,
		addEventListener(name: string, listener: (event: any) => void) {
			if (name === "message") listeners.push(listener);
		},
		document: {
			querySelectorAll: () => [
				{ src: base + "desktop-preview", contentWindow: desktop },
				{ src: base + "other", contentWindow: otherFrame },
			],
		},
	};
	new Function("globalThis", browserPeerChildScript(base))({ window: win });
	const port = { postMessage: vi.fn(), close: vi.fn() };
	const ask = (source: typeof desktop, url: string, origin = "null") => {
		const data = { type: "pi-browser-peer", kind: "fetch", url };
		for (const listener of listeners) listener({ source, origin, data, ports: [port] });
		return data;
	};
	const request = ask(desktop, base + "api/device-desktop/preview");
	expect(parent.postMessage).toHaveBeenCalledWith(request, "*", [port]);
	parent.postMessage.mockClear();
	ask(otherFrame, request.url);
	ask(desktop, request.url, "https://other.test");
	ask(desktop, base.replace("/device/a/", "/device/b/") + "api/device-desktop/preview");
	ask(desktop, base + "api/chat");
	expect(parent.postMessage).not.toHaveBeenCalled();
	expect(port.close).toHaveBeenCalledTimes(2);
	for (const listener of listeners) listener({ source: parent, data: { type: "device-p2p-upgraded" }, ports: [] });
	expect(desktop.postMessage).toHaveBeenCalledWith({ type: "device-p2p-upgraded" }, "*");
	expect(otherFrame.postMessage).not.toHaveBeenCalled();
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
