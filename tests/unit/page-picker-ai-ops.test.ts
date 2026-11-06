// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridgePage, invokeBridgeHandler } from "../../plugins/page-picker/extension/src/content/bridge-page.js";
import { BUILTIN_OPS } from "../../plugins/page-picker/extension/src/shared/bridge.js";

function boot(options: { control?: boolean; peers?: string[] } = {}): void {
	document.documentElement.setAttribute("data-pi-bridge", "tok-ai");
	installBridgePage({
		peers: options.peers ?? ["https://other.example"],
		self: "http://localhost:5173",
		control: options.control !== false,
	});
}

const run = (op: string, args?: Record<string, unknown>) =>
	invokeBridgeHandler({ op, args, from: "http://127.0.0.1:8787", builtin: true });

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piBridge;
	document.documentElement.removeAttribute("data-pi-bridge");
	document.body.innerHTML = "";
	document.title = "夹具页";
});

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as Record<string, unknown>).__piBridge;
});

describe("read（模型的眼睛）", () => {
	it("title / url", async () => {
		boot();
		await expect(run("read", { what: "title" })).resolves.toMatchObject({ ok: true, value: { title: "夹具页" } });
		const url = await run("read", { what: "url" });
		expect(url.ok).toBe(true);
		expect(String((url.value as { url: string }).url)).toContain("localhost");
	});

	it("text：整页正文（默认）与指定选择器", async () => {
		boot();
		document.body.innerHTML = `<div id="a">第一段</div><div id="b">第二段</div>`;
		const all = await run("read", { what: "text" });
		expect((all.value as { text: string }).text).toContain("第一段");
		const one = await run("read", { what: "text", selector: "#b" });
		expect((one.value as { text: string }).text).toBe("第二段");
	});

	it("text 选择器没匹上 → 一句人话的失败（不是空字符串让模型猜）", async () => {
		boot();
		const res = await run("read", { what: "text", selector: "#不存在" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("没匹上");
	});

	it("query：给模型一份元素摘要（含文本/尺寸/输入框的值）", async () => {
		boot();
		document.body.innerHTML = `<ul>
			<li class="row" id="r1">甲</li>
			<li class="row">乙</li>
			<li><input class="row" value="填好的" placeholder="请输入" /></li>
		</ul>`;
		const res = await run("read", { what: "query", selector: ".row" });
		const value = res.value as { count: number; shown: number; items: Record<string, unknown>[] };
		expect(value.count).toBe(3);
		expect(value.shown).toBe(3);
		expect(value.items[0]).toMatchObject({ tag: "li", id: "r1", text: "甲" });
		expect(value.items[2]).toMatchObject({ tag: "input", value: "填好的", placeholder: "请输入" });
	});

	it("query 的 limit 生效（一页几百个元素的页面不该把上下文撑爆）", async () => {
		boot();
		document.body.innerHTML = `<div>${Array.from({ length: 30 }, (_, i) => `<span class="x">${i}</span>`).join("")}</div>`;
		const res = await run("read", { what: "query", selector: ".x", limit: 5 });
		const value = res.value as { count: number; shown: number };
		expect(value.count).toBe(30);
		expect(value.shown).toBe(5);
	});

	it("html：结构（截断保护）", async () => {
		boot();
		document.body.innerHTML = `<p id="p">文字</p>`;
		const res = await run("read", { what: "html", selector: "#p" });
		expect(String((res.value as { html: string }).html)).toContain('<p id="p">');
	});
});

describe("click / type（模型的手）", () => {
	it("click：真的派发点击（页面的监听器收到）", async () => {
		boot();
		document.body.innerHTML = `<button id="go">走</button>`;
		const button = document.getElementById("go") as HTMLButtonElement;
		let clicks = 0;
		button.addEventListener("click", () => clicks++);
		const res = await run("click", { selector: "#go" });
		expect(clicks).toBe(1);
		expect(res.ok).toBe(true);
		expect((res.value as { text: string }).text).toBe("走");
	});

	it("click：选择器没匹上 → 失败（不静默）", async () => {
		boot();
		const res = await run("click", { selector: "#没有" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("没匹上");
	});

	it("type：走原型上的 native setter + 补发 input/change（React 受控组件才认）", async () => {
		boot();
		document.body.innerHTML = `<input id="name" />`;
		const input = document.getElementById("name") as HTMLInputElement;
		const events: string[] = [];
		input.addEventListener("input", () => events.push("input"));
		input.addEventListener("change", () => events.push("change"));
		let instanceValueSet = 0;
		Object.defineProperty(input, "value", {
			configurable: true,
			get: () => "",
			set: () => {
				instanceValueSet += 1;
			},
		});

		const res = await run("type", { selector: "#name", text: "你好" });
		expect(res.ok).toBe(true);
		expect(instanceValueSet).toBe(0);
		expect(input.value).toBe("");
		expect(events).toEqual(["input", "change"]);
	});

	it("type：clear=false 是追加；submit=true 会把回车键也发出去", async () => {
		boot();
		document.body.innerHTML = `<input id="q" value="已有" />`;
		const input = document.getElementById("q") as HTMLInputElement;
		const keys: string[] = [];
		input.addEventListener("keydown", (e) => keys.push(`down:${e.key}`));
		const res = await run("type", { selector: "#q", text: "续写", clear: false, submit: true });
		expect(input.value).toBe("已有续写");
		expect(keys).toEqual(["down:Enter"]);
		expect(res.value).toMatchObject({ submitted: true });
	});

	it("type：contenteditable 走 textContent", async () => {
		boot();
		document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
		const res = await run("type", { selector: "#ed", text: "写进去的" });
		expect(res.ok).toBe(true);
		expect(document.getElementById("ed")?.textContent).toBe("写进去的");
	});
});

describe("wait / scroll / goto", () => {
	it("wait：元素稍后出现 → 等到它（轮询而不是立刻放弃）", async () => {
		boot();
		setTimeout(() => {
			const div = document.createElement("div");
			div.id = "late";
			document.body.append(div);
		}, 120);
		const res = await run("wait", { selector: "#late", timeoutMs: 2000 });
		expect(res.value).toMatchObject({ found: "selector", selector: "#late" });
	});

	it("wait：等文案（SPA 里元素早就在、内容才后到）", async () => {
		boot();
		document.body.innerHTML = `<div id="box">加载中</div>`;
		setTimeout(() => {
			const box = document.getElementById("box");
			if (box) box.textContent = "加载完成";
		}, 100);
		const res = await run("wait", { text: "加载完成", timeoutMs: 2000 });
		expect(res.value).toMatchObject({ found: "text" });
	});

	it("wait：等不到 → 返回 found:null + 一句提示（不抛错，模型能自己决定下一步）", async () => {
		boot();
		const res = await run("wait", { selector: "#永远不来", timeoutMs: 150 });
		expect(res.value).toMatchObject({ found: null });
		expect(String((res.value as { note: string }).note)).toContain("没出现");
	});

	it("wait：既没 selector 也没 text → 直接说明", async () => {
		boot();
		const res = await run("wait", {});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("selector");
	});

	it("scroll：to / by / selector 三种（jsdom 里位置不变，但调用不能炸）", async () => {
		boot();
		document.body.innerHTML = `<div id="deep">深处</div>`;
		expect((await run("scroll", { to: { x: 0, y: 100 } })).ok).toBe(true);
		expect((await run("scroll", { by: { y: 50 } })).ok).toBe(true);
		const res = await run("scroll", { selector: "#deep" });
		expect(res.ok).toBe(true);
	});

	it("scroll：什么都不给 → 说明要 selector / to / by", async () => {
		boot();
		const res = await run("scroll", {});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("scroll");
	});

	it("goto：先回结果再跳（直接改 location 会让这次调用变成「没有响应」）", async () => {
		boot();
		vi.useFakeTimers();
		const res = await run("goto", { url: "https://example.com/next" });
		expect(res.value).toMatchObject({ navigating: true, url: "https://example.com/next" });
		vi.useRealTimers();
	});

	it("goto：没给 url → 说明", async () => {
		boot();
		const res = await run("goto", {});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("url");
	});
});

describe("eval（默认关，开了才到得了这里）", () => {
	it("返回表达式结果", async () => {
		boot();
		const res = await run("eval", { code: "[1,2,3].map(n => n * 2)" });
		expect(res).toMatchObject({ ok: true, value: { value: [2, 4, 6] } });
	});

	it("能改页面（这就是它的用途）", async () => {
		boot();
		document.body.innerHTML = `<p id="p">旧</p>`;
		const res = await run("eval", { code: "document.querySelector('#p').textContent = '新'" });
		expect(res.ok).toBe(true);
		expect(document.getElementById("p")?.textContent).toBe("新");
	});

	it("脚本抛错 → 把原因带回来", async () => {
		boot();
		const res = await run("eval", { code: "throw new Error('炸了')" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("炸了");
	});

	it("CSP 挡住 eval 时给一句能照做的建议", async () => {
		boot();
		const res = await run("eval", { code: "eval('1')" });
		if (!res.ok) expect(res.error).toMatch(/CSP|unsafe-eval/);
	});
});

describe("边界（这些决定了「模型不能干什么」）", () => {
	it("page 没被授权（control: false）→ 内置动作不存在", async () => {
		boot({ control: false });
		const res = await run("read");
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-control");
		expect(res.error).toContain("授权");
	});

	it("未内置的动作名 → 拒绝并列出支持的（不是静默成功）", async () => {
		boot();
		const res = await run("rm-rf");
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-handler");
		expect(res.error).toContain("read");
	});

	it("pages：页面知道自己跟谁有关（peers）", async () => {
		boot({ peers: ["https://other.example"] });
		const res = await run("pages");
		expect(res.value).toEqual({ pages: ["https://other.example"], self: "http://localhost:5173" });
	});

	it("白名单里恰好是这十二个（扩表就要同步工具描述与 README）", () => {
		expect([...BUILTIN_OPS]).toEqual([
			"status",
			"openOptions",
			"pages",
			"read",
			"click",
			"type",
			"scroll",
			"goto",
			"wait",
			"eval",
			"shot",
			"metrics",
		]);
	});

	it("metrics：给出 dpr 与视口（截图裁剪要用：rect 是 CSS 像素、截图是物理像素）", async () => {
		boot();
		const res = await run("metrics");
		expect(res.ok).toBe(true);
		const value = res.value as { dpr: number; vw: number };
		expect(typeof value.dpr).toBe("number");
		expect(value.dpr).toBeGreaterThan(0);
	});

	it("shot 不由页面执行（截图是扩展的活：captureVisibleTab + 切页）", async () => {
		boot();
		const res = await run("shot");
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-handler");
	});

	it("status 不由页面答（它是 worker 的状态查询，不进页面）", async () => {
		boot();
		const res = await run("status");
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-handler");
	});

	it("执行动作时在页面上闪一条「AI 正在操作本页」（页面不是自己在动）", async () => {
		boot();
		document.body.innerHTML = `<button id="go">走</button>`;
		await run("click", { selector: "#go" });

		const badge = document.getElementById("pi-ai-control-badge");
		expect(badge).not.toBeNull();
		expect(badge?.shadowRoot?.textContent).toContain("AI 正在操作本页");
		expect(badge?.shadowRoot?.textContent).toContain("click");
		expect(badge?.style.pointerEvents).toBe("none");
	});

	it("提示条不会堆出一堆（连续动作只刷新同一条）", async () => {
		boot();
		document.body.innerHTML = `<button id="q">走</button>`;
		await run("click", { selector: "#q" });
		await run("click", { selector: "#q" });
		expect(document.querySelectorAll("#pi-ai-control-badge")).toHaveLength(1);
	});
});
