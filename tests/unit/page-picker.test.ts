// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePickId, type PickPayload } from "../../plugins/page-picker/extension/src/shared/contract.js";
import {
	buildDomPath,
	buildNthPath,
	buildSelector,
	buildXPath,
	escapeIdent,
	isUniqueSelector,
	ownSegment,
	tagSummary,
} from "../../plugins/page-picker/extension/src/shared/selector.js";
import { htmlSkeleton } from "../../plugins/page-picker/extension/src/shared/html-skeleton.js";
import { code, collapse, truncate } from "../../plugins/page-picker/extension/src/shared/text.js";
import { toPrompt } from "../../plugins/page-picker/extension/src/shared/to-prompt.js";
import {
	DEFAULT_SERVER_URL,
	isValidMatchPattern,
	normalizeServerUrl,
	originPattern,
	tabMatchesBase,
} from "../../plugins/page-picker/extension/src/shared/settings.js";
import { bindView } from "../../plugins/page-picker/extension/src/shared/bind.js";
import { detectPiWebUi } from "../../plugins/page-picker/extension/src/background.js";
import type { ElementSnapshot } from "../../plugins/page-picker/extension/src/shared/contract.js";

/** 页面元素拾取扩展的纯逻辑：定位串生成 / HTML 骨架 / 契约渲染成 Markdown。
 *  这些函数决定「AI 到底看到什么」，所以逐条钉住（体积与降级都在这里）。 */

const mount = (html: string): void => {
	document.body.innerHTML = html;
};

const q = (sel: string): Element => {
	const el = document.querySelector(sel);
	if (!el) throw new Error(`missing ${sel}`);
	return el;
};

describe("escapeIdent / code / truncate", () => {
	it("escapeIdent：常规字符原样，特殊字符转义", () => {
		expect(escapeIdent("card")).toBe("card");
		expect(escapeIdent("card--active")).toBe("card--active");
		expect(escapeIdent("a:b.c d")).toBe("a\\:b\\.c\\ d");
	});

	it("escapeIdent：开头是数字/连字符时也转义（否则不是合法 CSS 标识符）", () => {
		expect(escapeIdent("1col")).toBe("\\1col");
		expect(escapeIdent("-x")).toBe("\\-x");
	});

	it("collapse 折叠换行与缩进（元素文本几乎都是源码级多行）", () => {
		expect(collapse("\n   高级   设置\n\t面板\n")).toBe("高级 设置 面板");
	});

	it("truncate 超长加省略号，不超不动", () => {
		expect(truncate("abcdef", 10)).toBe("abcdef");
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("abcdef", 0)).toBe("");
	});

	it("code 用行内反引号包住，内部有反引号时自动加长围栏", () => {
		expect(code("/src/a.ts")).toBe("`/src/a.ts`");
		expect(code("a`b")).toBe("``a`b``");
	});
});

describe("buildSelector", () => {
	beforeEach(() => mount(""));

	it("有唯一 id → 直接用 #id", () => {
		mount(`<div id="root"><span id="hero">x</span></div>`);
		expect(buildSelector(q("#hero"))).toBe("#hero");
	});

	it("无 id 有 class → tag.class，且能唯一定位就不往上爬", () => {
		mount(`<main><section class="card">a</section><section class="other">b</section></main>`);
		expect(buildSelector(q("section.card"))).toBe("section.card");
	});

	it("同名同 class 多个 → 往上叠父级段（父级内先补 nth-of-type 收窄）", () => {
		mount(
			`<main id="wrap"><div class="row"><section class="card">a</section></div><div class="row"><section class="card">b</section></div></main>`,
		);
		const el = q("div.row:nth-of-type(2) section.card");
		const sel = buildSelector(el);
		expect(isUniqueSelector(sel, el)).toBe(true);
		expect(sel).toBe("div.row:nth-of-type(2) > section.card");
	});

	it("爬不上去（层数受限）→ 退到全 nth-of-type 路径（长但一定准）", () => {
		// 四层同构：body 下两个 .a，各含两个 .b，各含一个 p —— 每一层都需要 nth-of-type 才分得开，
		// maxDepth 只给 2 层就爬不到唯一的前缀
		mount(
			`<div class="a"><div class="b"><p>1</p></div><div class="b"><p>2</p></div></div>` +
				`<div class="a"><div class="b"><p>3</p></div><div class="b"><p>4</p></div></div>`,
		);
		const el = document.querySelectorAll("p")[1];
		const sel = buildSelector(el, { maxDepth: 2 });
		expect(isUniqueSelector(sel, el)).toBe(true);
		expect(sel).toBe(buildNthPath(el));
		expect(sel).toContain("html");
	});

	it("class 数量超上限时截断（选择器别比元素还长）", () => {
		mount(`<div class="a b c d e f"></div>`);
		expect(buildSelector(q("div"), { maxClasses: 2 })).toBe("div.a.b");
	});

	it("生成的串永远能 querySelector 回去（唯一性检查不是摆设）", () => {
		mount(`<ul><li class="x">1</li><li class="x">2</li><li class="x">3</li></ul>`);
		for (const li of document.querySelectorAll("li")) {
			const sel = buildSelector(li);
			expect(isUniqueSelector(sel, li)).toBe(true);
		}
	});

	it("ownSegment 遇到不唯一的 id 不会误用 #id", () => {
		mount(`<div id="dup"></div><div id="dup"></div>`);
		const seg = ownSegment(document.querySelectorAll("#dup")[1]);
		expect(seg).not.toBe("#dup");
	});
});

describe("buildXPath / buildDomPath / tagSummary", () => {
	it("buildXPath：同标签兄弟带下标，唯一的兄弟不带", () => {
		mount(`<main><p>only</p></main>`);
		expect(buildXPath(q("p"))).toBe("/html/body/main/p");
		mount(`<main><section>a</section><section>b</section></main>`);
		expect(buildXPath(document.querySelectorAll("section")[1])).toBe("/html/body/main/section[2]");
	});

	it("buildDomPath：去掉 html，带 id/class，超深只留尾巴并加 …", () => {
		mount(`<div id="root"><main><section class="card outer extra">x</section></main></div>`);
		expect(buildDomPath(q("section"))).toBe("body > div#root > main > section.card.outer");
	});

	it("buildDomPath：超深截断", () => {
		mount(`<div><div><div><div><div><p id="deep">x</p></div></div></div></div></div>`);
		const path = buildDomPath(q("#deep"), { maxDepth: 2 });
		expect(path.startsWith("… > ")).toBe(true);
		expect(path.endsWith("div > p#deep")).toBe(true);
	});

	it("tagSummary：id/class 必带，其他属性限量且值截断", () => {
		mount(`<input id="q" class="field big" type="text" name="keyword" placeholder="${"x".repeat(80)}">`);
		const s = tagSummary(q("input"), { maxAttrs: 1, maxValue: 10 });
		expect(s).toContain(`id="q"`);
		expect(s).toContain(`class="field big"`);
		expect(s).toContain(`type="text"`);
		expect(s).not.toContain(`name=`);
		expect(s.length).toBeLessThan(80);
	});
});

describe("htmlSkeleton", () => {
	it("展开发根元素 + 下一层，文本折叠截断", () => {
		mount(`<section class="card"><h3>\n  标题\n</h3><p>正文</p></section>`);
		expect(htmlSkeleton(q("section"))).toBe(`<section class="card"><h3>标题</h3><p>正文</p></section>`);
	});

	it("到深度上限 → 子节点折成 …（不吐整棵子树）", () => {
		mount(`<div class="a"><div class="b"><div class="c"><p>deep</p></div></div></div>`);
		expect(htmlSkeleton(q("div.a"), { maxDepth: 1 })).toBe(`<div class="a"><div class="b">…</div></div>`);
	});

	it("void 元素不补闭合标签", () => {
		mount(`<div><img src="a.png"><br></div>`);
		expect(htmlSkeleton(q("div"), { maxDepth: 3 })).toBe(`<div><img><br></div>`);
	});

	it("class 超上限 → 加 … 提示还有更多", () => {
		mount(`<div class="a b c d e"></div>`);
		expect(htmlSkeleton(q("div"), { maxClasses: 2 })).toBe(`<div class="a b …"></div>`);
	});

	it("总长超上限 → 截断（极端宽 DOM 也撑不爆上下文）", () => {
		mount(`<div>${"<span>x</span>".repeat(200)}</div>`);
		const out = htmlSkeleton(q("div"), { maxDepth: 3, maxLength: 60 });
		expect(out.length).toBeLessThanOrEqual(60);
		expect(out.endsWith("…")).toBe(true);
	});
});

const snap = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
	tag: "section",
	classes: ["card", "card--active"],
	selector: "main > section.card:nth-of-type(2)",
	tagSummary: `<section class="card card--active">`,
	rect: { x: 10, y: 20, w: 320.4, h: 180.2, vwPct: 22.2222, vhPct: 20.0222 },
	...over,
});

const payload = (over: Partial<PickPayload> = {}): PickPayload => ({
	id: "pick-test",
	pickedAt: "2026-01-01T00:00:00.000Z",
	page: {
		url: "http://localhost:5173/settings",
		title: "Settings",
		viewport: { w: 1440, h: 900, dpr: 2 },
		framework: "react",
		colorScheme: "dark",
	},
	elements: [{ snapshot: snap({ text: "高级   设置\n面板" }) }],
	detail: "standard",
	...over,
});

describe("toPrompt", () => {
	it("没有元素 → 空串（调用方据此拒收，不注入空消息）", () => {
		expect(toPrompt(payload({ elements: [] }))).toBe("");
		expect(toPrompt(payload({ elements: [{ snapshot: null as never }] }))).toBe("");
	});

	it("标准档：页面上下文 + 选择器 + 尺寸 + 文本，数字取整", () => {
		const md = toPrompt(payload());
		expect(md).toContain("### 网页元素拾取（1 个元素）");
		expect(md).toContain("`http://localhost:5173/settings` — Settings");
		expect(md).toContain("1440×900 @2x，深色");
		expect(md).toContain("疑似框架：React");
		expect(md).toContain("`main > section.card:nth-of-type(2)`");
		expect(md).toContain("320×180 px（视口 22.2% × 20%）");
		expect(md).toContain("`高级 设置 面板`");
	});

	it("源码行：文件:行:列 + 组件调用链", () => {
		const md = toPrompt(
			payload({
				elements: [
					{
						snapshot: snap({
							source: {
								kind: "react",
								file: "/src/components/Card.tsx",
								line: 18,
								column: 5,
								component: "Card",
								chain: ["Card", "SettingsPage"],
							},
						}),
					},
				],
			}),
		);
		expect(md).toContain("- 源码：`/src/components/Card.tsx:18:5`");
		expect(md).toContain("`Card` ← `SettingsPage`");
	});

	it("拿不到的字段整条不出现（不输出 undefined / 空值行）", () => {
		const md = toPrompt(
			payload({
				elements: [{ snapshot: snap() }],
				page: { url: "http://x/", title: "", viewport: { w: 800, h: 600, dpr: 1 } },
			}),
		);
		expect(md).not.toContain("undefined");
		expect(md).not.toContain("- 源码：");
		expect(md).not.toContain("- 文本：");
		expect(md).not.toContain("疑似框架");
		expect(md).not.toContain("浅色");
	});

	it("compact 档：砍掉样式/规则/骨架/XPath（体积最小）", () => {
		const md = toPrompt(
			payload({
				detail: "compact",
				elements: [
					{
						snapshot: snap({
							text: "x",
							xpath: "/html/body/main/section[2]",
							domPath: "body > main > section.card",
							htmlSkeleton: `<section class="card">…</section>`,
							styles: { display: "flex" },
							matchedRules: [{ file: "/src/a.css", line: 3, selector: ".card", declarations: "display:flex" }],
						}),
					},
				],
			}),
		);
		expect(md).toContain("- 选择器：");
		expect(md).not.toContain("计算样式");
		expect(md).not.toContain("命中的 CSS");
		expect(md).not.toContain("HTML 骨架");
		expect(md).not.toContain("XPath");
	});

	it("full 档：额外输出 XPath 与 DOM 路径", () => {
		const md = toPrompt(
			payload({
				detail: "full",
				elements: [{ snapshot: snap({ xpath: "/html/body/main/section[2]", domPath: "body > main > section.card" }) }],
			}),
		);
		expect(md).toContain("- XPath：`/html/body/main/section[2]`");
		expect(md).toContain("- DOM：`body > main > section.card`");
	});

	it("命中的 CSS 带文件:行号，且是合法 css 围栏", () => {
		const md = toPrompt(
			payload({
				elements: [
					{
						snapshot: snap({
							matchedRules: [
								{
									file: "/src/components/Card.css",
									line: 42,
									selector: ".card",
									declarations: "display:flex;padding:12px 16px",
								},
								{ selector: ".card--active", declarations: "border-color:#3b82f6" },
							],
						}),
					},
				],
			}),
		);
		expect(md).toContain("命中的 CSS：");
		expect(md).toContain("/* /src/components/Card.css:42 */");
		expect(md).toContain(".card { display:flex;padding:12px 16px }");
		expect(md).toContain(".card--active { border-color:#3b82f6 }");
		expect((md.match(/```/g) ?? []).length % 2).toBe(0);
	});

	it("计算样式折成一行行内代码", () => {
		const md = toPrompt(
			payload({ elements: [{ snapshot: snap({ styles: { display: "flex", "padding-left": "12px", empty: "" } }) }] }),
		);
		expect(md).toContain("计算样式（仅与默认/继承值不同的）：`display: flex; padding-left: 12px`");
		expect(md).not.toContain("empty");
	});

	it("备注：元素级与整体都带上（用户的话原样进上下文）", () => {
		const md = toPrompt(
			payload({
				note: "这三处间距不一致",
				elements: [{ snapshot: snap({ text: "x" }), note: "这个卡片 padding 太大了" }],
			}),
		);
		expect(md).toContain("- 整体说明：这三处间距不一致");
		expect(md).toContain("- 备注：这个卡片 padding 太大了");
	});

	it("有截图 → 只提示「见本轮附图」，base64 绝不进正文", () => {
		const md = toPrompt(payload({ elements: [{ snapshot: snap({ text: "x" }), shot: "data:image/png;base64,QUJD" }] }));
		expect(md).toContain("- 截图：见本轮附图");
		expect(md).not.toContain("base64");
		expect(md).not.toContain("data:image");
	});

	it("多元素：按序编号；超过上限的只报数量", () => {
		const many = Array.from({ length: 4 }, (_, i) => ({ snapshot: snap({ text: `第${i}个` }) }));
		const md = toPrompt(payload({ elements: many }), { maxElements: 2 });
		expect(md).toContain("#### 元素 1");
		expect(md).toContain("#### 元素 2");
		expect(md).not.toContain("#### 元素 3");
		expect(md).toContain("（另有 2 个已拾取元素未展开）");
	});

	it("文本截断（标准档 400 / compact 160）", () => {
		const long = "字".repeat(500);
		const standard = toPrompt(payload({ elements: [{ snapshot: snap({ text: long }) }] }));
		const compact = toPrompt(payload({ detail: "compact", elements: [{ snapshot: snap({ text: long }) }] }));
		expect(standard).toContain("字".repeat(399) + "…");
		expect(compact).toContain("字".repeat(159) + "…");
	});

	it("不产生连续空行（Markdown 干净）", () => {
		const md = toPrompt(payload());
		expect(md).not.toMatch(/\n{3,}/);
	});
});

describe("makePickId", () => {
	it("可读 + 带随机后缀，两次不同", () => {
		const a = makePickId(1700000000000, () => 0.5);
		const b = makePickId(1700000000000, () => 0.25);
		expect(a.startsWith("pick-")).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe("远程部署：地址归一 / 权限模式 / 标签页复核", () => {
	it("normalizeServerUrl：补协议、去尾斜杠、保留子路径（反代部署）", () => {
		expect(normalizeServerUrl("pi.example.com")).toBe("http://pi.example.com");
		expect(normalizeServerUrl("https://pi.example.com/")).toBe("https://pi.example.com");
		expect(normalizeServerUrl("https://host/pi/")).toBe("https://host/pi");
		expect(normalizeServerUrl("  192.168.1.10:8787  ")).toBe("http://192.168.1.10:8787");
		expect(normalizeServerUrl("")).toBe(DEFAULT_SERVER_URL);
		expect(normalizeServerUrl("http://")).toBe(DEFAULT_SERVER_URL);
		expect(normalizeServerUrl(42)).toBe(DEFAULT_SERVER_URL);
	});

	it("originPattern：按 origin 申请权限（端口不影响模式，路径不该进模式）", () => {
		expect(originPattern("https://pi.example.com/")).toBe("https://pi.example.com/*");
		expect(originPattern("pi.example.com:9000")).toBe("http://pi.example.com:9000/*");
		expect(originPattern("https://host/pi/")).toBe("https://host/*");
	});

	it("tabMatchesBase：认子路径与查询串，但不认「前缀相似的别的站点」", () => {
		const base = "https://host/pi";
		expect(tabMatchesBase("https://host/pi/", base)).toBe(true);
		expect(tabMatchesBase("https://host/pi/chat", base)).toBe(true);
		expect(tabMatchesBase("https://host/pi?token=x", base)).toBe(true);
		// 关键：这几个都不能算我们的页面（权限缺失时 tabs.query 会返回一堆无关标签页）
		expect(tabMatchesBase("https://host/pi-other/", base)).toBe(false);
		expect(tabMatchesBase("https://host/", base)).toBe(false);
		expect(tabMatchesBase("http://localhost:5173/", base)).toBe(false);
		expect(tabMatchesBase(undefined, base)).toBe(false);
	});

	it("originPattern 的结果一定是合法 match pattern（能直接交给 chrome.tabs.query）", () => {
		// 真事故（0.2.0）：曾经把「裸 origin」也当成查询模式之一传进去，真 Chrome/Edge 直接抛
		// `Invalid url pattern 'http://localhost:8787'`，而被 catch 成「没找到页面」。
		expect(isValidMatchPattern(originPattern("http://localhost:8787"))).toBe(true);
		expect(isValidMatchPattern(originPattern("https://pi.example.com/pi"))).toBe(true);
		expect(isValidMatchPattern(originPattern("192.168.1.10:9000"))).toBe(true);
		expect(isValidMatchPattern("http://localhost:8787")).toBe(false); // 裸 origin（无路径）→ 非法
		expect(isValidMatchPattern("localhost:8787/*")).toBe(false); // 缺 scheme
		expect(isValidMatchPattern("http://host")).toBe(false);
		expect(isValidMatchPattern("http://*/*")).toBe(true); // 任意主机（manifest 里的预置权限就是这种）
		expect(isValidMatchPattern(undefined)).toBe(false);
	});

	it("根部署：/ 与任意子路径都算，别的端口/协议不算", () => {
		const base = "http://127.0.0.1:8787";
		expect(tabMatchesBase("http://127.0.0.1:8787/", base)).toBe(true);
		expect(tabMatchesBase("http://127.0.0.1:8787/anything", base)).toBe(true);
		expect(tabMatchesBase("http://127.0.0.1:5173/", base)).toBe(false);
		expect(tabMatchesBase("https://127.0.0.1:8787/", base)).toBe(false);
	});
});

// --------------------------------------------------------------- 绑定服务（点图标认页面）

describe("bindView（在 pi-web-ui 本页上问什么）", () => {
	it("远程 IP + 端口 → 文案里两个地址都在，带主按钮", () => {
		const view = bindView("http://39.99.235.208:8787/", "http://127.0.0.1:8787");
		expect(view.base).toBe("http://39.99.235.208:8787");
		expect(view.same).toBe(false);
		expect(view.bindLabel).toBe("设为服务地址");
		expect(view.detail).toContain("http://127.0.0.1:8787");
		expect(view.detail).toContain("http://39.99.235.208:8787");
	});

	it("页面带 ?token= / hash → 只留 origin（子路径保留：反代部署）", () => {
		expect(bindView("http://39.99.235.208:8787/?token=x#/chat", "").base).toBe("http://39.99.235.208:8787");
		expect(bindView("https://host/pi/", "").base).toBe("https://host/pi");
	});

	it("页面就是已绑定的地址 → 不再问「要不要绑」，只说现状", () => {
		const view = bindView("http://localhost:9000/", "http://localhost:9000");
		expect(view.same).toBe(true);
		expect(view.bindLabel).toBeUndefined();
		expect(view.title).toContain("已绑定");
	});

	it("localhost 与 127.0.0.1 视为**不同**（匹配用的是字面串，不做别名推断）", () => {
		// 想换地址？在页面上点一下图标就能重绑，没必要在两个回环别名之间“智能”猜测
		expect(bindView("http://localhost:8787/", "http://127.0.0.1:8787").same).toBe(false);
	});
});

describe("detectPiWebUi（认页面：桥 + /api/health 两个判据）", () => {
	const realFetch = globalThis.fetch;
	const setHost = (value: unknown): void => {
		(globalThis as Record<string, unknown>).__piWebUiHost = value;
	};
	const okHealth = (body: unknown): void => {
		globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
	};

	beforeEach(() => {
		delete (globalThis as Record<string, unknown>).__piWebUiHost;
	});

	it("有宿主动作桥 → 直接认定（不再发探针请求）", async () => {
		setHost({ compose: () => true });
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const probe = await detectPiWebUi();
		expect(probe.isPiWebUi).toBe(true);
		expect(probe.hasHost).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("没有桥也能认（老版本）：/api/health 回 {ok, piVersion}", async () => {
		okHealth({ ok: true, piVersion: "0.81.0", cwd: "/tmp", engine: "pi" });
		const probe = await detectPiWebUi();
		expect(probe.isPiWebUi).toBe(true);
		expect(probe.hasHost).toBe(false);
		expect(probe.piVersion).toBe("0.81.0");
	});

	it("别的服务返回同一个路径 → 不误认（要 ok + piVersion/engine）", async () => {
		okHealth({ hello: "world" });
		expect((await detectPiWebUi()).isPiWebUi).toBe(false);
		okHealth({ ok: true });
		expect((await detectPiWebUi()).isPiWebUi).toBe(false);
	});

	it("探不通（404 / 抛错 / 非 JSON）→ 当它不是 pi-web-ui，不抛", async () => {
		globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
		expect((await detectPiWebUi()).isPiWebUi).toBe(false);
		globalThis.fetch = (async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		}) as unknown as typeof fetch;
		expect((await detectPiWebUi()).isPiWebUi).toBe(false);
	});

	it("请求挂住 → 1.2s 后自我中断（点图标绝不能被一个慢请求卡住）", async () => {
		let aborted = false;
		globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		}) as unknown as typeof fetch;
		const probe = await detectPiWebUi();
		expect(probe.isPiWebUi).toBe(false);
		expect(aborted).toBe(true);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});
});
