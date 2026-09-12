/**
 * legado-web 的「AI 修源接口」测试（零 token、自包含）。
 *
 * 不起 pi-web-ui 服务：直接用假 host 激活插件入口，拿到注册的 AI 工具与 HTTP 路由，
 * 对着本进程里的假书源站跑一遍（规则引擎在 worker 里跑，同步 JS 规则走共享内存桥）。
 *
 * 覆盖：
 * - 四个工具注册 + 规则速查内容
 * - legado_book_sources：list / get / add / update（深合并）/ remove（真正落盘）
 * - legado_source_probe：完整链路逐步回报（请求、页体片段、规则原文、规则失败）
 * - legado_run_rule：抓页试规则（含条目级 listRule）
 * - 引擎修复回归：单段 CSS 规则（无 @）= 选择器 + 取文本，`.title##正则` 可用，
 *   且 `text`/`href` 这类输出写法仍然有效
 * - 书源 JS 规则里的同步 java.ajax（worker + Atomics 桥）
 *
 * 运行：先 npm run build（或 node plugins/legado-web/build.mjs），再 node tests/legado-web-engine-test.mjs
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { freePort } from "./lib/port-utils.mjs";

import { buildFixPrompt, isAiFixMessage, normalizeFixContext } from "../plugins/legado-web/client/ai-fix.mjs";

const PORT = 8995;
const BASE = `http://127.0.0.1:${PORT}`;
const pluginDir = join(import.meta.dirname, "..", "plugins", "legado-web");
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-engine-"));
const notes = [];
const messageHandlers = [];
const sentTo = [];

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- 假书源站 --------------------------------------------------------------
const site = http.createServer((req, res) => {
	const u = new URL(req.url ?? "/", BASE);
	const send = (type, body) => {
		res.writeHead(200, { "Content-Type": type });
		res.end(body);
	};
	if (u.pathname === "/search") {
		return send(
			"application/json",
			JSON.stringify({
				data: {
					list: [
						{ name: "测试书", author: "某人", url: "/book/1", id: "1" },
						{ name: "第二本", author: "另一人", url: "/book/2", id: "2" },
					],
				},
			}),
		);
	}
	if (u.pathname === "/book/1") {
		return send(
			"text/html; charset=utf-8",
			'<html><head><title>站点标题</title></head><body><h1 class="resourceName">测试书</h1><div class="intro">简介</div><a class="toc" href="/toc/1">目录</a></body></html>',
		);
	}
	if (u.pathname === "/toc/1") {
		return send(
			"text/html",
			'<html><body><div id="mulu"><a href="/c/1">第1章 起始</a><a href="/c/2">第2章 继续</a></div></body></html>',
		);
	}
	if (u.pathname === "/c/1") {
		return send("text/html", `<html><body><div id="content">正文内容。${"字".repeat(80)}</div></body></html>`);
	}
	if (u.pathname === "/api/extra") {
		return send(
			"application/json",
			JSON.stringify({ ok: true, list: [{ name: "同步规则书", author: "谁", url: "/book/1" }] }),
		);
	}
	return send("text/html", "<html><body>home</body></html>");
});

const source = {
	bookSourceUrl: BASE,
	bookSourceName: "本地测试源",
	bookSourceType: 0,
	enabled: true,
	searchUrl: "/search?key={{key}}",
	ruleSearch: { bookList: "$.data.list", name: "name", author: "author", bookUrl: "url" },
	ruleBookInfo: { name: ".resourceName", intro: ".intro", tocUrl: ".toc@href" },
	ruleToc: { chapterList: "#mulu a", chapterName: "text", chapterUrl: "href" },
	ruleContent: { content: "#content" },
};
const jsSource = {
	...source,
	bookSourceUrl: `${BASE}/js`,
	bookSourceName: "同步规则源",
	ruleSearch: {
		bookList: `@js:JSON.parse(java.ajax('${BASE}/api/extra')).list`,
		name: "$.name",
		author: "$.author",
		bookUrl: "$.url",
	},
};

let deactivate = null;
try {
	if (!existsSync(join(pluginDir, "server", "engine.mjs")))
		throw new Error("缺 server/engine.mjs —— 先跑 node plugins/legado-web/build.mjs");

	await new Promise((r) => site.listen(PORT, "127.0.0.1", r));
	freePort(PORT + 1000); // 只探测（本测试不需要额外端口）

	// ---- 假 host 激活插件 ----------------------------------------------------
	const mod = await import(pathToFileURL(join(pluginDir, "index.mjs")).href);
	const tools = new Map();
	const routes = new Map();
	const host = {
		dir: pluginDir,
		dataDir,
		cwd: dataDir,
		log: () => {},
		notify: (level, text) => notes.push(`${level}: ${text}`),
		onMessage: (handler) => {
			messageHandlers.push(handler);
			return () => {};
		},
		sendTo: (clientId, payload) => sentTo.push({ clientId, payload }),
		route: (method, path, handler) => {
			routes.set(`${method} ${path}`, handler);
			return () => routes.delete(`${method} ${path}`);
		},
		registerAgentTool: (tool) => {
			tools.set(tool.name, tool);
			return () => tools.delete(tool.name);
		},
	};
	deactivate = mod.default.activate(host);

	// ---- 1. 工具注册 ---------------------------------------------------------
	const want = ["legado_rules", "legado_book_sources", "legado_source_probe", "legado_run_rule"];
	const missing = want.filter((n) => !tools.has(n));
	if (missing.length) fail(`缺工具：${missing.join(", ")}`);
	else console.log(`✓ 注册 AI 工具：${want.join(", ")}`);
	if (routes.size !== 4) fail(`HTTP 路由数不对：${[...routes.keys()].join(", ")}`);

	const run = (name, params) => tools.get(name).execute("t", params);

	// ---- 2. 规则速查 ---------------------------------------------------------
	const rules = await run("legado_rules", {});
	const text = String(rules.text ?? "");
	for (const kw of ["ruleSearch", "ruleContent", "@put", "##", "java.ajax"]) {
		if (!text.includes(kw)) fail(`规则速查缺内容：${kw}`);
	}
	if (!process.exitCode) console.log(`✓ legado_rules 返回规则速查（${text.length} 字）`);

	// ---- 2b. 「AI 修复源」的给 AI 正文（纯函数） ------------------------------
	{
		const msg = {
			type: "legado:ai-fix",
			context: {
				scene: "content",
				sourceUrl: BASE,
				sourceName: "本地测试源",
				bookName: "测试书",
				url: `${BASE}/c/1`,
				error: "正文规则未解析出内容",
				rules: { ruleContent: { content: "#content" } },
			},
		};
		const prompt = buildFixPrompt(msg.context, {
			sourcesFile: "D:/data/legado-web/sources.json",
			rulesFile: "P:/plugin/rules.md",
			dataDir: "D:/data/legado-web",
			pluginDir: "P:/plugin",
		});
		for (const need of [
			"【AI 修复书源】",
			"本地测试源",
			BASE,
			"legado_source_probe",
			"D:/data/legado-web/sources.json",
			"P:/plugin/rules.md",
			"D:/data/legado-web",
			"不要修改阅读插件的任何文件",
			'"content":"#content"',
		]) {
			if (!prompt.includes(need)) fail(`给 AI 的正文缺内容：${need}`);
		}
		// 目录没给全时不能凭空编：sourcesFile 可由 dataDir 推出，但绝不能再给出“可改的源码目录”
		const noDirs = buildFixPrompt(msg.context, {});
		if (/插件源码目录/.test(noDirs)) fail("正文里不应该再出现“插件源码目录”（AI 不该改插件代码）");
		if (!buildFixPrompt(msg.context, { dataDir: "D:/data/legado-web" }).includes("D:/data/legado-web/sources.json"))
			fail("只给 dataDir 时应能推出 sourcesFile");
		if (!isAiFixMessage(msg) || isAiFixMessage({ type: "x" })) fail("isAiFixMessage 判定不对");
		const dirty = normalizeFixContext({ scene: "bad", sourceUrl: 1, error: "x".repeat(9000) });
		if (dirty.scene !== "source" || dirty.sourceUrl !== "" || dirty.error.length !== 1500) fail("脏上下文没归一化");
		if (!process.exitCode)
			console.log(
				"✓ 「AI 修复源」正文组装（含书源/现场/规则 + 书源文件与规则文件路径 + “只改书源不改插件”硬约束）+ 脏上下文归一化",
			);

		// 「AI 新建书源」：只给网站链接的正文模板
		const newPrompt = buildFixPrompt(
			{ scene: "new", sourceUrl: "https://www.example.com" },
			{ dataDir: "D:/d", sourcesFile: "D:/d/sources.json", pluginDir: "P:/p" },
		);
		for (const need of [
			"【AI 新建书源】",
			"https://www.example.com",
			"bookSourceType=0",
			"legado_book_sources",
			"add 保存",
			"不要修改阅读插件",
			"只读",
		]) {
			if (!newPrompt.includes(need)) fail(`新建源正文缺内容：${need}`);
		}
		if (!buildFixPrompt({ scene: "new", sourceUrl: "https://x.com" }, {}).includes("bookSourceUrl 用站点根地址"))
			fail("新建源模板少了落盘要求");
		if (!process.exitCode) console.log("✓ 「AI 新建书源」正文模板（网址 + 抓页步骤 + 落盘要求 + 硬约束）");
	}

	// ---- 3. 书源文件读写 -----------------------------------------------------
	let r = await run("legado_book_sources", { action: "list" });
	if (r.total !== 0) fail(`初始书源应为 0，实际 ${r.total}`);
	r = await run("legado_book_sources", { action: "add", source });
	if (!r.ok || !r.total) fail(`add 失败：${JSON.stringify(r).slice(0, 120)}`);
	r = await run("legado_book_sources", { action: "add", source: jsSource });
	if (r.total !== 2) fail(`add 第二个源后应为 2，实际 ${r.total}`);

	r = await run("legado_book_sources", { action: "list", query: "本地测试" });
	if (r.matched !== 1 || !r.items[0]?.hasSearch) fail(`list/query 异常：${JSON.stringify(r).slice(0, 200)}`);

	r = await run("legado_book_sources", { action: "get", url: BASE });
	if (r.source?.ruleContent?.content !== "#content") fail(`get 没拿到书源：${JSON.stringify(r).slice(0, 120)}`);

	r = await run("legado_book_sources", {
		action: "update",
		url: BASE,
		fields: { ruleContent: { content: "#content@text", nextContentUrl: "" } },
	});
	if (!r.ok || !r.changed.includes("ruleContent")) fail(`update 失败：${JSON.stringify(r).slice(0, 160)}`);
	const onDisk = JSON.parse(readFileSync(join(dataDir, "legado-web", "sources.json"), "utf8"));
	const written = onDisk.find((s) => s.bookSourceUrl === BASE);
	if (written?.ruleContent?.content !== "#content@text") fail("update 没落盘");
	else if (!written?.ruleSearch?.bookList) fail("update 深合并把其它字段弄丢了");
	else if (!written?.ruleContent?.nextContentUrl === undefined) fail("update 没合并新键");
	else console.log("✓ legado_book_sources：list / get / add / update（深合并落盘）/ 通知");

	// ---- 4. 链路诊断 ---------------------------------------------------------
	r = await run("legado_source_probe", { url: BASE, key: "测试", dump: "snippet", dumpMax: 300 });
	const names = (r.steps ?? []).map((s) => s.name).join(">");
	if (!r.ok) fail(`完整链路应通过，实际：${r.conclusion}（${names}）`);
	else if (names !== "reach>search>info>toc>content") fail(`步骤顺序不对：${names}`);
	else if (!r.steps.find((s) => s.name === "toc")?.value?.length) fail("目录步骤没回传章节样本");
	else if (!r.steps.find((s) => s.name === "content")?.requests?.[0]?.snippet) fail("dump=snippet 没回传页体片段");
	else console.log(`✓ legado_source_probe：${r.conclusion}（逐步回报请求 + 规则 + 页体片段）`);

	// 步进模式：只测正文（跳过搜索/详情/目录）
	r = await run("legado_source_probe", { url: BASE, step: "content", bookUrl: `${BASE}/c/1`, dump: "none" });
	if (!r.ok || r.steps.length !== 1)
		fail(`step=content 应只跑一步，实际 ${JSON.stringify(r.steps?.map((s) => s.name))}`);
	else console.log("✓ legado_source_probe：step 只跑指定步骤");

	// ---- 5. 试规则（含条目级） ------------------------------------------------
	r = await run("legado_run_rule", { url: `${BASE}/c/1`, rule: "#content" });
	if (!String(r.first ?? "").startsWith("正文内容")) fail(`runRule 单段选择器失败：${JSON.stringify(r).slice(0, 160)}`);
	const itemLevel = await run("legado_run_rule", { url: `${BASE}/toc/1`, rule: "text", listRule: "#mulu a" });
	if (itemLevel.list?.[0] !== "第1章 起始") fail(`条目级 listRule 失败：${JSON.stringify(itemLevel).slice(0, 160)}`);
	else console.log("✓ legado_run_rule：抓页试规则（页面级 + 条目级）");

	// ---- 6. 引擎修复回归：单段 CSS 规则 --------------------------------------
	const html = '<html><body><div class="title">测试<font color="RED">书</font></div></body></html>';
	const cssCases = [
		[".title##<font.*?></font>", "测试书"],
		[".title", "测试书"],
		["text", "测试书"],
	];
	for (const [rule, expect] of cssCases) {
		/* eslint-disable no-await-in-loop */
		const out = await run("legado_run_rule", { body: html, rule, dump: "none" });
		if (String(out.first ?? "") !== expect)
			fail(`引擎 CSS 规则 ${rule} → ${JSON.stringify(out.first)}，应为 ${expect}`);
	}
	if (!process.exitCode) console.log("✓ 单段 CSS 规则 = 选择器 + 取文本（`.title##正则`、`text` 均可用）");

	// ---- 7. 书源 JS 规则里的同步 java.ajax -----------------------------------
	r = await run("legado_source_probe", { url: jsSource.bookSourceUrl, key: "测试", mode: "search", dump: "none" });
	if (!r.ok) fail(`同步 java.ajax 规则失败：${r.conclusion}`);
	else console.log(`✓ java.ajax 同步规则可用（${r.conclusion}）`);

	// ---- 8. 删源 --------------------------------------------------------------
	r = await run("legado_book_sources", { action: "remove", url: jsSource.bookSourceUrl });
	if (!r.ok || r.total !== 1) fail(`remove 失败：${JSON.stringify(r).slice(0, 120)}`);
	else console.log("✓ legado_book_sources：remove");
	if (!notes.length) fail("写操作没有通知用户");
	else console.log(`✓ 写操作通知用户（${notes.length} 条，例如「${notes[0].slice(0, 40)}…」）`);

	// ---- 9. 前端问目录：{type:"info"} → 回 {kind:"info", sourcesFile, rulesFile, dataDir, pluginDir} ------
	if (!messageHandlers.length) fail("没注册 onMessage（前端问目录拿不到答案）");
	else {
		for (const h of messageHandlers) h({ type: "info" }, "client-1");
		const reply = sentTo.find((m) => m.payload?.kind === "info");
		if (reply?.clientId !== "client-1")
			fail(`info 回复没定向发给提问的客户端：${JSON.stringify(sentTo).slice(0, 120)}`);
		else if (reply.payload.dataDir !== join(dataDir, "legado-web"))
			fail(`info 里 dataDir 不对：${reply.payload.dataDir}`);
		else if (reply.payload.sourcesFile !== join(dataDir, "legado-web", "sources.json"))
			fail(`info 里 sourcesFile 不对：${reply.payload.sourcesFile}`);
		else if (reply.payload.sourceDir !== undefined) fail("info 里不该再回 sourceDir（AI 不该往插件里写东西）");
		else if (reply.payload.rulesFile !== join(pluginDir, "rules.md"))
			fail(`info 里 rulesFile 不对：${reply.payload.rulesFile}`);
		else console.log('✓ {type:"info"} → 回目录信息（sourcesFile / rulesFile / dataDir / pluginDir / workspace）');
	}
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	try {
		deactivate?.();
	} catch {
		/* ignore */
	}
	site.close();
	await new Promise((r) => setTimeout(r, 500));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
