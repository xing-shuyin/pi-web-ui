// @vitest-environment jsdom
/**
 * 建群入口必须常驻「智能体」标题行。
 *
 * 「群组」区块在一条群组都没有时整块隐藏（`DeviceGroupSection` 的 `hideWhenEmpty`），
 * 所以建群入口不能只住在那里或某个会被裁掉的菜单里：一个 Bot 都没有时也得点得到。
 * 这里守两件事：空列表也渲染入口；点击走 `pi-web-ui:device-group-open` 的唯一事件链路。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBotsSection } from "../../web/src/components/AgentBotsSection";
import { closeContextMenu } from "../../web/src/context-menu-state";

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	useT: () => (key: string) =>
		({
			agentBotsTitle: "智能体",
			createGroup: "新建群组",
			agentBotsEmpty: "还没有智能体",
		})[key] ?? key,
}));

const response = (data: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => data }) as unknown as Response;

let root: Root | undefined;
let host: HTMLDivElement;

async function settle(check: () => boolean) {
	for (let i = 0; i < 20 && !check(); i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function render() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(createElement(AgentBotsSection, { active: true, activeBotId: null, cwd: "/test" })),
	);
	await settle(() => Boolean(host.querySelector(".lp-bots-actions")));
}

afterEach(() => {
	closeContextMenu();
	vi.unstubAllGlobals();
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
});

describe("智能体标题行的建群入口", () => {
	it("一个智能体都没有时入口仍在，点击派发建群事件", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ bots: [], drafts: [] })),
		);
		await render();

		const groupBtn = host.querySelector<HTMLButtonElement>(".lp-bots-actions .lp-bots-group");
		expect(groupBtn).toBeTruthy();
		// 空列表也渲染入口：群组区块这时整块隐藏，没有这个按钮就建不出群。
		expect(host.querySelector(".lp-bots-empty")).toBeTruthy();
		expect(groupBtn!.getAttribute("aria-label")).toBe("新建群组");

		const events: unknown[] = [];
		const listener = (event: Event) => events.push((event as CustomEvent).detail);
		window.addEventListener("pi-web-ui:device-group-open", listener);
		try {
			await act(async () => groupBtn!.click());
		} finally {
			window.removeEventListener("pi-web-ui:device-group-open", listener);
		}
		expect(events).toEqual([{ create: true }]);
	});
});
