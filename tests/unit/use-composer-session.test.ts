// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useComposerSessionReset } from "../../web/src/use-composer-session.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

function mountProbe(initial: string) {
	const onSessionChange = vi.fn();
	let setSession: (s: string) => void = () => {};

	function Probe() {
		const [sessionId, set] = useState(initial);
		setSession = set;
		useComposerSessionReset(sessionId, onSessionChange);
		return null;
	}

	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(Probe));
	});
	return {
		onSessionChange,
		switchTo: (s: string) =>
			act(() => {
				setSession(s);
			}),
	};
}

describe("useComposerSessionReset", () => {
	it("首次就绪（挂载时就有 sessionId）→ 不清空", () => {
		const p = mountProbe("s1");
		expect(p.onSessionChange).not.toHaveBeenCalled();
	});

	it("同一会话的快照刷新（sessionId 不变）→ 不清空", () => {
		const p = mountProbe("s1");
		p.switchTo("s1");
		p.switchTo("s1");
		expect(p.onSessionChange).not.toHaveBeenCalled();
	});

	it("会话换了（新建对话 / 切对话 / 过户）→ 清空一次", () => {
		const p = mountProbe("s1");
		p.switchTo("s2");
		expect(p.onSessionChange).toHaveBeenCalledTimes(1);
		p.switchTo("s3");
		expect(p.onSessionChange).toHaveBeenCalledTimes(2);
	});

	it("断线重连的瞬时态（sessionId 短暂为空）→ 不清，回到同一会话也不清", () => {
		const p = mountProbe("s1");
		p.switchTo("");
		expect(p.onSessionChange).not.toHaveBeenCalled();
		p.switchTo("s1");
		expect(p.onSessionChange).not.toHaveBeenCalled();
	});

	it("瞬时态之后真的换了会话 → 照常清空", () => {
		const p = mountProbe("s1");
		p.switchTo("");
		p.switchTo("s2");
		expect(p.onSessionChange).toHaveBeenCalledTimes(1);
	});

	it("挂载时还没有会话（未连接）→ 首次就绪不清空", () => {
		const p = mountProbe("");
		expect(p.onSessionChange).not.toHaveBeenCalled();
		p.switchTo("s1");
		expect(p.onSessionChange).not.toHaveBeenCalled();
	});
});
