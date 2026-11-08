// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installBridgePage, uninstallBridgePage } from "../../plugins/page-picker/extension/src/content/bridge-page.js";

/**
 * 页面侧内置动作（`__builtin`）的口令脱敏回归。
 *
 * 口径与桌面原生 `browser/automation/page-operation.ts` 一致：口令框的 value 不从任何一条路径出页面
 * （read query / read html / type 回显 / click 回显），否则明文会跟着 pageCall 结果进模型上下文。
 */

const TOKEN = "test-bridge-token";

type Invoke = (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

let invoke: Invoke;

interface ContentBridge {
	__invoke: (op: unknown, args: unknown, from: unknown, builtin?: unknown) => Promise<Record<string, unknown>>;
}

function bridgeApi(): ContentBridge {
	return (globalThis as unknown as { __piBridge: ContentBridge }).__piBridge;
}

beforeEach(() => {
	document.documentElement.setAttribute("data-pi-bridge", TOKEN);
	document.body.innerHTML =
		'<form id="login"><input id="user" value="alice">' +
		'<input id="pw1" type="password" value="markup-secret">' +
		'<input id="pw2" type="password"></form>';
	(document.querySelector("#pw2") as HTMLInputElement).value = "typed-by-user-123";
	const installed = installBridgePage({ control: true });
	expect(installed.ok).toBe(true);
	const api = bridgeApi();
	invoke = (op, args) => api.__invoke(op, args ?? {}, "", true);
});

afterEach(() => {
	uninstallBridgePage();
	document.documentElement.removeAttribute("data-pi-bridge");
	document.body.innerHTML = "";
});

describe("page-picker 内置动作的口令脱敏", () => {
	it("read what=query 不返回口令框的 value，text 也为空", async () => {
		const res = await invoke("read", { what: "query", selector: "input[type=password]" });
		expect(res.ok).toBe(true);
		const items = (res.value as { items: Record<string, unknown>[] }).items;
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect("value" in item).toBe(false);
			expect(item.text).toBe("");
			expect(item.type).toBe("password");
		}
	});

	it("read what=html 清掉口令框的 value 属性，同一节点里的普通字段不受影响", async () => {
		const res = await invoke("read", { what: "html", selector: "form#login" });
		expect(res.ok).toBe(true);
		const html = String((res.value as { html: string }).html);
		expect(html).not.toContain("markup-secret");
		expect(html).toContain('value="alice"');
		expect(html).toContain('id="pw1"');
	});

	it("type 照样写得进去，但返回值不回显口令", async () => {
		const res = await invoke("type", { selector: "#pw2", text: "typed-by-agent-456" });
		expect(res.ok).toBe(true);
		const value = res.value as Record<string, unknown>;
		expect(value.typed).toBe(true);
		expect("value" in value).toBe(false);
		expect((document.querySelector("#pw2") as HTMLInputElement).value).toBe("typed-by-agent-456");
	});

	it("click 回显里的口令框摘要同样没有 value", async () => {
		const res = await invoke("click", { selector: "#pw1" });
		expect(res.ok).toBe(true);
		const value = res.value as Record<string, unknown>;
		expect(value.clicked).toBe(true);
		expect("value" in value).toBe(false);
	});

	it("普通输入框的 value 照常返回（脱敏只针对口令框）", async () => {
		const query = await invoke("read", { what: "query", selector: "#user" });
		const items = (query.value as { items: Record<string, unknown>[] }).items;
		expect(items[0]?.value).toBe("alice");
		const typed = await invoke("type", { selector: "#user", text: "bob" });
		expect((typed.value as Record<string, unknown>).value).toBe("bob");
	});
});
