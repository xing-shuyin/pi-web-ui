import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
	handleMessage,
	installBridgePage,
	invokeBridgeHandler,
	syncBridges,
	uninstallBridgePage,
} from "../plugins/page-picker/extension/dist/background.js";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const BRIDGE_BUNDLE = join(REPO_ROOT, "plugins", "page-picker", "extension", "dist", "bridge.js");
const PORT_A = 9500 + Math.floor(Math.random() * 40);
const PORT_B = 9540 + Math.floor(Math.random() * 40);
const PORT_C = 9580 + Math.floor(Math.random() * 20);
const ORIGIN_A = `http://127.0.0.1:${PORT_A}`;
const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;
const ORIGIN_C = `http://127.0.0.1:${PORT_C}`;

if (!existsSync(BRIDGE_BUNDLE)) {
	console.log("✗ 缺 dist/bridge.js —— 先跑 npm run build:extension");
	process.exit(1);
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const FIXTURE_HTML = (who) =>
	`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${who}</title></head>` +
	`<body><h1 id="who">${who}</h1><p id="data">夹具页 ${who}</p></body></html>`;

const sites = [];
for (const [who, port] of [
	["A", PORT_A],
	["B", PORT_B],
	["C", PORT_C],
]) {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(FIXTURE_HTML(`页面 ${who}`));
	});
	await new Promise((r) => server.listen(port, "127.0.0.1", r));
	sites.push(server);
}

const fakeSettings = {};
const localStore = {
	bridgePairs: [{ a: ORIGIN_A, b: ORIGIN_B, enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }],
};
const tabsById = new Map();

function matchesPattern(pattern, url) {
	return url.startsWith(pattern.replace(/\*$/, ""));
}

globalThis.chrome = {
	storage: {
		sync: { get: async () => ({ ...fakeSettings }), set: async () => {} },
		local: {
			get: async (keys) => {
				const out = {};
				for (const key of keys ?? Object.keys(localStore)) if (key in localStore) out[key] = localStore[key];
				return out;
			},
			set: async (items) => Object.assign(localStore, items),
		},
	},
	tabs: {
		query: async (info = {}) => {
			const patterns = Array.isArray(info.url) ? info.url : info.url ? [info.url] : [];
			for (const p of patterns) {
				if (!/^https?:\/\/[^/]+\//.test(String(p))) throw new Error(`Invalid url pattern '${p}'`);
			}
			const all = [...tabsById.entries()].map(([id, entry]) => ({ id, windowId: 1, url: entry.url }));
			return patterns.length === 0 ? all : all.filter((t) => patterns.some((p) => matchesPattern(p, t.url)));
		},
		sendMessage: async (tabId, message) => {
			if (message?.type !== "page-picker:bridge-arm") return undefined;
			const entry = tabsById.get(tabId);
			if (!entry) throw new Error(`No tab with id: ${tabId}`);
			return await entry.page.evaluate(
				() =>
					new Promise((resolve) => {
						const cb = globalThis.__armCb;
						if (!cb) {
							resolve(null);
							return;
						}
						const keep = cb({ type: "page-picker:bridge-arm" }, {}, (r) => resolve(r ?? null));
						if (!keep) resolve(null);
					}),
			);
		},
		update: async () => ({}),
		create: async () => ({}),
		captureVisibleTab: async () => {
			throw new Error("no activeTab");
		},
	},
	windows: { update: async () => ({}) },
	action: { setBadgeText: async () => {}, setTitle: async () => {} },
	permissions: { contains: async () => true, request: async () => true },
	scripting: {
		executeScript: async (injection) => {
			const entry = tabsById.get(injection.target.tabId);
			if (!entry) throw new Error(`No tab with id: ${injection.target.tabId}`);
			if (injection.files) {
				await entry.page.addScriptTag({ path: BRIDGE_BUNDLE });
				return [{}];
			}
			const args = injection.args ?? [];
			const name = injection.func?.name;
			if (name === "installBridgePage") return [{ result: await entry.page.evaluate(installBridgePage, args[0]) }];
			if (name === "invokeBridgeHandler") return [{ result: await entry.page.evaluate(invokeBridgeHandler, args[0]) }];
			if (name === "uninstallBridgePage") return [{ result: await entry.page.evaluate(uninstallBridgePage, args[0]) }];
			return [{}];
		},
	},
};

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const context = await browser.newContext();

async function openTab(id, origin) {
	const page = await context.newPage();
	page.on("pageerror", (e) => check(`页面 ${origin} 无 JS 报错`, false, String(e)));
	await page.exposeFunction("__toWorker", async (message) => {
		return await new Promise((resolve) =>
			handleMessage(message, { tab: { id, url: `${origin}/` } }, (r) => resolve(r ?? null)),
		);
	});
	await page.addInitScript(() => {
		const stub = {
			runtime: {
				onMessage: { addListener: (cb) => (globalThis.__armCb = cb) },
				sendMessage: async (message) => await globalThis.__toWorker(message),
			},
		};
		globalThis.chrome = stub;
	});
	await page.goto(`${origin}/`);
	tabsById.set(id, { page, url: `${origin}/` });
	return page;
}

const pageA = await openTab(1, ORIGIN_A);
const pageB = await openTab(2, ORIGIN_B);
const pageC = await openTab(3, ORIGIN_C);

const installed = await syncBridges();
check("syncBridges 给配对的页面装上了桥（两端各一次）", installed === 2, `installed=${installed}`);
check(
	"没配对的第三个页面一个字节都没注入（默认拒绝）",
	(await pageC.evaluate(() => typeof globalThis.__piBridge)) === "undefined",
);
const peersA = await pageA.evaluate(() => globalThis.__piBridge?.peers ?? null);
check("页面侧知道自己的对端是谁", Array.isArray(peersA) && peersA[0] === ORIGIN_B, JSON.stringify(peersA));
check("页面侧 API 的版本与扩展一致（字面量同步）", (await pageA.evaluate(() => globalThis.__piBridge?.version)) === 1);

await pageB.evaluate(() => {
	globalThis.__orders = [
		{ id: 1, amount: 88 },
		{ id: 2, amount: 12 },
	];
	globalThis.__calls = [];
	window.__piBridge.on("orders", (args, ctx) => {
		globalThis.__calls.push({ args, from: ctx.from });
		return globalThis.__orders;
	});
	window.__piBridge.on("slow", () => new Promise((r) => setTimeout(() => r("迟到"), 400)));
	window.__piBridge.on("loop", () => {
		const o = {};
		o.self = o;
		return o;
	});
	window.__piBridge.on("boom", () => {
		throw new Error("B 页的 handler 炸了");
	});
});

const readOrders = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "orders", args: { day: "今天" } }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"**A 页拿到了 B 页的数据**（跨源 + 跨标签页，走完整条链）",
	readOrders.ok && readOrders.value?.length === 2 && readOrders.value[1].amount === 12,
	JSON.stringify(readOrders),
);
check(
	"B 的 handler 收到了 args 与 from（对端知道是谁在调）",
	JSON.stringify(await pageB.evaluate(() => globalThis.__calls)) ===
		JSON.stringify([{ args: { day: "今天" }, from: ORIGIN_A }]),
);

await pageA.evaluate(() => {
	window.__piBridge.on("highlight", ({ id }) => {
		const el = document.querySelector(`#${id}`);
		if (el) el.dataset.highlighted = "yes";
		return el ? el.textContent : null;
	});
});
const highlight = await pageB.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "highlight", args: { id: "data" } }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"**B 页能操控 A 页**（配对是对称的：这次是 A 的 DOM 被改了）",
	highlight.ok && (await pageA.evaluate(() => document.querySelector("#data").dataset.highlighted)) === "yes",
	JSON.stringify(highlight),
);

const notRegistered = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "没注册过的 op" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"对端没注册那个 op → 报错里说明并列出它注册了什么",
	!notRegistered.ok && notRegistered.error.includes("没注册"),
	notRegistered.error,
);

const tooSlow = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "slow", timeoutMs: 60 }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check("对端太慢 → 页面侧的 Promise 自己超时（不悬着）", !tooSlow.ok && tooSlow.error.includes("60ms"), tooSlow.error);

const badReturn = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "loop" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"对端返回值不可传输（循环引用）→ 一句说明而不是 DataCloneError",
	!badReturn.ok && badReturn.error.includes("传不回来"),
	badReturn.error,
);

const thrown = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "boom" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check("对端 handler 抛错 → 原因原样带回本页", !thrown.ok && thrown.error.includes("炸了"), thrown.error);

await pageC.addScriptTag({ path: BRIDGE_BUNDLE });
const cInstalled = await pageC.evaluate(installBridgePage, { peers: [ORIGIN_B], self: ORIGIN_C });
check("没配对的页面也能被硬装上桥（用来验证准入不是靠页面自觉）", cInstalled.ok === true, JSON.stringify(cInstalled));
const outsider = await pageC.evaluate(async (to) => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "orders", to }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
}, ORIGIN_B);
check(
	"**没配对的页面调不动任何人**（哪怕它自己装了桥、还指名要调对端）",
	!outsider.ok && outsider.error.includes("没配对"),
	outsider.error,
);

const bEntry = tabsById.get(2);
tabsById.delete(2);
const closed = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "orders" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check("对端标签页没开着 → 直接说「没打开」", !closed.ok && closed.error.includes("没打开"), closed.error);
tabsById.set(2, bEntry);

localStore.bridgePairs = [];
const uninstalled = await new Promise((resolve) => {
	handleMessage({ type: "page-picker:pairs-changed", removedOrigins: [ORIGIN_A, ORIGIN_B] }, {}, (r) => resolve(r));
});
check("删掉配对 → 两个页面上的桥都被卸下", uninstalled?.uninstalled === 2, JSON.stringify(uninstalled));
check(
	"卸下后页面上的 window.__piBridge 真的没了",
	(await pageA.evaluate(() => typeof globalThis.__piBridge)) === "undefined",
);
await globalThis.chrome.tabs.sendMessage(1, { type: "page-picker:bridge-arm" });
await pageA.evaluate(installBridgePage, { peers: [ORIGIN_B], self: ORIGIN_A });
const afterDrop = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "orders" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"重新装上桥但配对已删 → 仍然被拒（桥装得回来，权限装不回来）",
	!afterDrop.ok && afterDrop.error.includes("没配对"),
	afterDrop.error,
);

fakeSettings.serverUrl = ORIGIN_C;
localStore.aiPages = [{ origin: ORIGIN_B, title: "页面 B", at: "2026-01-02T00:00:00.000Z" }];
const armCount = await syncBridges();
check("授权后：宿主页与控制页都装上了桥", armCount >= 2, `installed=${armCount}`);

const hostCall = async (op, args) =>
	await pageC.evaluate(
		async ([action, payload]) => {
			try {
				return { ok: true, value: await window.__piBridge.call({ op: action, args: payload }) };
			} catch (err) {
				return { ok: false, error: String(err?.message ?? err) };
			}
		},
		[op, args],
	);

const pagedRead = await hostCall("read", { what: "title" });
check(
	"**AI 读到了被授权页面的标题**（宿主 → 授权页，跑内置动作）",
	pagedRead.ok && String(pagedRead.value?.title ?? "").includes("页面 B"),
	JSON.stringify(pagedRead),
);

// 口令框：查询 / 取 HTML / 输入 三条路径都不许把 value 带出页面（与桌面原生 page-operation 同口径）
await pageB.evaluate(() => {
	document.body.insertAdjacentHTML(
		"beforeend",
		'<form id="login"><input id="user" value="alice">' +
			'<input id="pw1" type="password" value="markup-secret">' +
			'<input id="pw2" type="password"></form>',
	);
	document.querySelector("#pw2").value = "typed-by-user-123";
});

const pwQuery = await hostCall("read", { what: "query", selector: "input[type=password]" });
const pwItems = Array.isArray(pwQuery.value?.items) ? pwQuery.value.items : [];
check(
	"**口令框的值不出页面**（query 结果里没有 value 字段，text 也是空的）",
	pwQuery.ok && pwItems.length === 2 && pwItems.every((item) => !("value" in item) && item.text === ""),
	JSON.stringify(pwQuery),
);

const pwHtml = await hostCall("read", { what: "html", selector: "form#login" });
const pwHtmlText = String(pwHtml.value?.html ?? "");
check(
	"**口令框的值不出页面**（html 里 value 属性被清掉，同一表单的普通字段不受影响）",
	pwHtml.ok && !pwHtmlText.includes("markup-secret") && pwHtmlText.includes('value="alice"'),
	JSON.stringify(pwHtml),
);

const pwType = await hostCall("type", { selector: "#pw2", text: "typed-by-agent-456" });
await pageB.waitForFunction(() => document.querySelector("#pw2")?.value === "typed-by-agent-456", null, {
	timeout: 3000,
});
const pwTyped = await pageB.evaluate(() => document.querySelector("#pw2")?.value);
check(
	"口令框照样能填（只隐藏回显：页面里真的写进去了，返回值里没有 value）",
	pwType.ok && pwType.value?.typed === true && !("value" in (pwType.value ?? {})) && pwTyped === "typed-by-agent-456",
	`${JSON.stringify(pwType)} typed=${pwTyped}`,
);

const pagedClick = await hostCall("eval", { code: "1" });
check(
	"eval 默认关：即使总开关开着也拒（默认关的开关必须真的关）",
	!pagedClick.ok && /eval/.test(pagedClick.error),
	pagedClick.error,
);

fakeSettings.allowEval = true;
const evalAfter = await hostCall("eval", { code: "document.title" });
check(
	"设置里打开 eval 后才放行，且真的在目标页面里执行",
	evalAfter.ok && String(evalAfter.value?.value ?? "").includes("页面 B"),
	JSON.stringify(evalAfter),
);

fakeSettings.aiControl = false;
const disabled = await hostCall("read", { what: "title" });
check("总开关关 → 一切页面动作都拒", !disabled.ok && disabled.error.includes("关闭"), disabled.error);
fakeSettings.aiControl = true;

const noGrant = await hostCall("read", { what: "text", selector: "#永远不存在" });
check("动作本身失败（选择器没匹上）时原因原样带回宿主", !noGrant.ok && noGrant.error.includes("没匹上"), noGrant.error);

const ungranted = await pageA.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "read" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"没被授权的页面调不动任何人（AI 授权表是唯一凭据）",
	!ungranted.ok && ungranted.error.includes("配对"),
	ungranted.error,
);

await browser.close();
for (const server of sites) server.close();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
