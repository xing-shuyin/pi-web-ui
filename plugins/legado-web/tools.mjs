/**
 * legado-web 的 AI 工具 —— 让 agent 能「知道规则、读到书源文件、跑链路找病因、改完再验」。
 *
 * 四个工具（都在 manifest.permissions 的 "tools" 族下注册）：
 *   legado_rules         规则语法/字段速查（rules.md，AI 的知识库）
 *   legado_book_sources  读书源文件：list / get / update / add / remove
 *   legado_source_probe  跑「连通→搜索→详情→目录→正文」，逐步回报请求与规则命中
 *   legado_run_rule      拿真实页体试跑一条规则（配合上一步定位坏规则）
 *
 * 写操作会 host.notify 提醒用户刷新阅读页（浏览器里那份是内存副本）。
 */

/** 工具执行里统一抛错（宿主会转成 tool error 文本给模型）。 */
const fail = (msg) => {
	throw new Error(msg);
};

/** 定位书源：优先 bookSourceUrl 精确匹配，其次名字子串（返回全部候选）。 */
function findSources(list, { url, name }) {
	const u = String(url ?? "").trim();
	if (u) {
		const hit = list.find((s) => String(s?.bookSourceUrl ?? "").trim() === u);
		if (hit) return [hit];
		const fuzzy = list.filter((s) => String(s?.bookSourceUrl ?? "").includes(u));
		if (fuzzy.length) return fuzzy;
	}
	const n = String(name ?? "")
		.trim()
		.toLowerCase();
	if (n) {
		return list.filter((s) =>
			String(s?.bookSourceName ?? "")
				.toLowerCase()
				.includes(n),
		);
	}
	return [];
}

const describeSource = (s, check) => ({
	name: s?.bookSourceName,
	url: s?.bookSourceUrl,
	group: s?.bookSourceGroup,
	enabled: s?.enabled !== false,
	type: s?.bookSourceType ?? 0,
	hasSearch: Boolean(String(s?.searchUrl ?? "").trim()),
	hasExplore: Boolean(String(s?.exploreUrl ?? "").trim()),
	rules: {
		search: Object.keys(s?.ruleSearch ?? {}).length,
		bookInfo: Object.keys(s?.ruleBookInfo ?? {}).length,
		toc: Object.keys(s?.ruleToc ?? {}).length,
		content: Object.keys(s?.ruleContent ?? {}).length,
	},
	check: check
		? {
				kind: check.kind ?? (check.ok ? "ok" : "suspect"),
				reason: check.reason,
				at: check.ts ? new Date(check.ts).toISOString() : undefined,
			}
		: undefined,
});

/** 深合并（只处理一层对象字段：ruleSearch/ruleBookInfo/ruleToc/ruleContent 等）。 */
function mergeSource(target, patch) {
	const out = { ...target };
	const changed = [];
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (v === undefined) continue;
		const cur = out[k];
		if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
			const merged = { ...cur };
			for (const [k2, v2] of Object.entries(v)) {
				if (v2 === undefined) continue;
				merged[k2] = v2;
			}
			out[k] = merged;
		} else {
			out[k] = v;
		}
		changed.push(k);
	}
	return { merged: out, changed };
}

const str = (v, fallback = "") => (typeof v === "string" && v.trim() ? v.trim() : fallback);

export function createTools({ host, store, engine, rulesText }) {
	const readSources = () => {
		const list = store.read("sources");
		return Array.isArray(list) ? list : [];
	};
	const writeSources = (list) => store.write("sources", list);
	const readCheck = () => {
		const rec = store.read("check");
		return rec && typeof rec === "object" ? rec : {};
	};

	return [
		{
			name: "legado_rules",
			label: "Legado 规则速查",
			description: [
				"Legado book-source rule reference for this plugin: data structure (BookSource + ruleSearch/ruleBookInfo/ruleToc/ruleContent fields), evaluation semantics (CSS/XPath/JSONPath/JS, || && %%, ## replacement, @put/@get, {{}} templates, :N index), java.* bindings, known deviations, and the recommended repair workflow.",
				"Legado 书源规则速查：数据结构（BookSource 与 ruleSearch/ruleBookInfo/ruleToc/ruleContent 各字段）、求值语义（CSS/XPath/JSONPath/JS、`||`/`&&`/`%%`、`##` 替换、`@put/@get`、`{{}}` 模板、`:N` 序号）、java.* 绑定、已知差异、推荐的修源流程。修源前先读它。",
			].join("\n"),
			promptSnippet: "legado_rules — 读 Legado 书源规则速查（修源前先看）",
			promptGuidelines: [
				"修 Legado 书源前先调用 legado_rules 确认规则语义（本引擎单段 CSS 规则 = 选择器+取文本，`text`/`href` 这类输出写法也兼容）。",
			],
			parameters: {
				type: "object",
				properties: {
					topic: {
						type: "string",
						description: "只要含该关键字的章节（如 css / js / toc / content / 流程）；省略返回全文",
					},
				},
			},
			async execute(_id, params) {
				const topic = str(params.topic).toLowerCase();
				if (!topic) return { text: rulesText };
				const sections = rulesText.split(/\n(?=## )/g);
				const hit = sections.filter((s) => s.toLowerCase().includes(topic));
				return {
					text: hit.length ? hit.join("\n") : `没有含「${topic}」的章节，返回全文：\n\n${rulesText}`,
					topics: sections.map((s) => (s.split("\n")[0] ?? "").replace(/^#+\s*/, "")).filter(Boolean),
				};
			},
		},

		{
			name: "legado_book_sources",
			label: "Legado 书源文件",
			description: [
				"Read and edit the Legado book-source file (<dataDir>/legado-web/sources.json) of this plugin: list (filter by name/url, shows health), get (full JSON of one source), update (deep-merge specific fields, e.g. only ruleContent.content), add (import/replace a whole source), remove.",
				"读书/改 Legado 书源文件（<dataDir>/legado-web/sources.json）：list 列源（可按名字/URL 过滤，带健康状态）、get 取单源完整 JSON、update 深合并改指定字段（如只改 ruleContent.content）、add 导入/覆盖整份书源、remove 删源。改完让用户刷新阅读页生效。",
			].join("\n"),
			promptSnippet: "legado_book_sources — 读/改 Legado 书源文件（list/get/update/add/remove）",
			promptGuidelines: [
				"改 Legado 书源只用 legado_book_sources 的 update（按字段深合并），不要整份覆盖，也不要手写 5MB 的 sources.json。",
				"改完书源提醒用户刷新阅读页（浏览器里是内存副本）。",
			],
			parameters: {
				type: "object",
				required: ["action"],
				properties: {
					action: { type: "string", enum: ["list", "get", "update", "add", "remove"], description: "要做的操作" },
					query: { type: "string", description: "list：按名字或 URL 子串过滤" },
					url: { type: "string", description: "bookSourceUrl（get/update/remove 定位用；update 时是必需）" },
					name: { type: "string", description: "按书源名子串定位（url 没给时用）" },
					fields: {
						type: "object",
						description: 'update：要合并进该书源的字段，如 { ruleContent: { content: "#content@text" } }',
					},
					source: { type: "object", description: "add：整份书源 JSON（按 bookSourceUrl 覆盖或追加）" },
					limit: { type: "number", description: "list 返回条数上限，默认 50" },
				},
			},
			async execute(_id, params) {
				const action = str(params.action);
				const list = readSources();
				const check = readCheck();

				if (action === "list") {
					const q = str(params.query).toLowerCase();
					const limit = Math.max(1, Math.min(Number(params.limit ?? 50) || 50, 200));
					const filtered = list.filter((s) => {
						if (!q) return true;
						return `${s?.bookSourceName ?? ""} ${s?.bookSourceUrl ?? ""} ${s?.bookSourceGroup ?? ""}`
							.toLowerCase()
							.includes(q);
					});
					const items = filtered.slice(0, limit).map((s) => describeSource(s, check[s?.bookSourceUrl]));
					const dead = Object.values(check).filter((c) => c?.kind === "dead").length;
					return {
						total: list.length,
						matched: filtered.length,
						returned: items.length,
						disabled: list.filter((s) => s?.enabled === false).length,
						deadChecked: dead,
						items,
						dataFile: store.dir,
					};
				}

				if (action === "add") {
					const src = params.source;
					if (!src || typeof src !== "object" || !str(src.bookSourceUrl))
						fail("add 需要 source.bookSourceUrl（书源唯一键）");
					const idx = list.findIndex((s) => s?.bookSourceUrl === src.bookSourceUrl);
					if (idx >= 0) list[idx] = { ...list[idx], ...src };
					else list.push(src);
					writeSources(list);
					host.notify(
						"info",
						`已写入书源《${src.bookSourceName ?? src.bookSourceUrl}》，刷新阅读页生效`,
						`Book source "${src.bookSourceName ?? src.bookSourceUrl}" saved — reload the reader page.`,
					);
					return { ok: true, replaced: idx >= 0, total: list.length, note: "让用户刷新阅读页后生效" };
				}

				// get / update / remove 都要先定位
				const hits = findSources(list, params);
				if (!hits.length) fail(`没找到书源（url=${str(params.url) || "-"} name=${str(params.name) || "-"}）`);
				if (hits.length > 1 && action !== "list")
					return {
						ambiguous: true,
						candidates: hits.slice(0, 20).map((s) => ({ name: s.bookSourceName, url: s.bookSourceUrl })),
						note: "多个匹配，请用 url 精确定位",
					};
				const target = hits[0];
				const idx = list.indexOf(target);

				if (action === "get") {
					return { source: target, check: check[target.bookSourceUrl] ?? null, index: idx };
				}

				if (action === "update") {
					const fields = params.fields;
					if (!fields || typeof fields !== "object" || !Object.keys(fields).length)
						fail('update 需要 fields（要改的字段，如 { ruleContent: { content: "..." } }）');
					const { merged, changed } = mergeSource(target, fields);
					list[idx] = merged;
					writeSources(list);
					host.notify(
						"info",
						`已更新书源《${merged.bookSourceName}》的 ${changed.join("/")}，刷新阅读页生效`,
						`Book source "${merged.bookSourceName}" updated (${changed.join("/")}) — reload the reader page.`,
					);
					return {
						ok: true,
						url: merged.bookSourceUrl,
						changed,
						source: merged,
						note: "让用户刷新阅读页后生效；建议再用 legado_source_probe 验证一次",
					};
				}

				if (action === "remove") {
					list.splice(idx, 1);
					writeSources(list);
					host.notify(
						"warning",
						`已删除书源《${target.bookSourceName}》，刷新阅读页生效`,
						`Book source "${target.bookSourceName}" removed — reload the reader page.`,
					);
					return { ok: true, removed: { name: target.bookSourceName, url: target.bookSourceUrl }, total: list.length };
				}

				fail(`未知 action：${action}`);
			},
		},

		{
			name: "legado_source_probe",
			label: "Legado 书源诊断",
			description: [
				"Run the Legado pipeline for one book source step by step (reach → search → info → TOC → content) and report each step: request URLs, HTTP status, page size and snippets, parsed values, the exact rule strings used, and every rule failure. Use it first when a source misbehaves.",
				"对单个书源逐步跑链路诊断（连通 → 搜索 → 详情 → 目录 → 正文）：每步回报请求地址、HTTP 状态、页体大小与片段、解析出的值、用到的规则原文、以及该步的规则失败明细。书源有问题先跑它定位断点。",
			].join("\n"),
			promptSnippet: "legado_source_probe — 跑书源链路看断在哪一步（含规则失败明细与页体片段）",
			promptGuidelines: [
				'书源读不到内容时先 legado_source_probe（dump="snippet"）定位断点，再改规则；不要凭空重写整份书源。',
			],
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "书源 bookSourceUrl（与 name 二选一，优先 url）" },
					name: { type: "string", description: "书源名子串" },
					key: { type: "string", description: "搜索关键词，默认「剑」" },
					mode: { type: "string", enum: ["reach", "search", "full"], description: "跑到哪一档，默认 full" },
					step: {
						type: "string",
						enum: ["reach", "search", "info", "toc", "content"],
						description: "只测这一步（配合 bookUrl 可跳过前面的步骤）",
					},
					bookUrl: {
						type: "string",
						description: "直接指定地址：step=info 给书页、step=toc 给目录页、step=content 给章节页",
					},
					dump: {
						type: "string",
						enum: ["none", "snippet", "full"],
						description: "是否回传页体（默认 snippet，看规则该怎么写时很有用）",
					},
					dumpMax: { type: "number", description: "页体回传上限，默认 4000 字" },
				},
			},
			async execute(_id, params) {
				const list = readSources();
				const hits = findSources(list, params);
				if (!hits.length) fail(`没找到书源（url=${str(params.url) || "-"} name=${str(params.name) || "-"}）`);
				if (hits.length > 1)
					return {
						ambiguous: true,
						candidates: hits.slice(0, 20).map((s) => ({ name: s.bookSourceName, url: s.bookSourceUrl })),
						note: "多个匹配，请用 url 精确定位",
					};
				const options = {
					key: str(params.key, "剑"),
					mode: ["reach", "search", "full"].includes(str(params.mode)) ? str(params.mode) : "full",
					step: params.step,
					bookUrl: str(params.bookUrl) || undefined,
					dump: ["none", "snippet", "full"].includes(str(params.dump)) ? str(params.dump) : "snippet",
					dumpMax: params.dumpMax,
				};
				const result = await engine.run({ kind: "probe", source: hits[0], options });
				return { source: { name: hits[0].bookSourceName, url: hits[0].bookSourceUrl }, ...result };
			},
		},

		{
			name: "legado_run_rule",
			label: "Legado 试规则",
			description: [
				"Fetch a page and evaluate a single Legado rule against it (optionally via a list rule for item-level child rules), returning the request info, page snippet and the exact extracted values. Use it to verify a rule fix before saving.",
				"抓一个页面并试跑单条 Legado 规则（条目级子规则用 listRule 先取条目），返回请求信息、页体片段与真实求值结果。改规则前用它验证改法是否有效。",
			].join("\n"),
			promptSnippet: "legado_run_rule — 抓页面试跑一条规则，验证改法（条目级用 listRule）",
			parameters: {
				type: "object",
				required: ["url", "rule"],
				properties: {
					url: { type: "string", description: "要抓的页面地址（书源站）" },
					rule: { type: "string", description: '要试的规则，如 "#content@text"、".title"、"$.data.list"' },
					listRule: { type: "string", description: '条目级子规则：先按它取条目，再对每条求 rule（如 "li.chapter"）' },
					charset: { type: "string", description: "站点编码（gbk 等），默认自动嗅探" },
					body: { type: "string", description: "不给 url 时可直接用这段页体试规则（少用）" },
					dump: { type: "string", enum: ["none", "snippet", "full"], description: "是否回传页体，默认 snippet" },
					dumpMax: { type: "number", description: "页体回传上限，默认 3000 字" },
				},
			},
			async execute(_id, params) {
				const rule = str(params.rule);
				if (!rule) fail("需要 rule");
				const url = str(params.url);
				const body = typeof params.body === "string" ? params.body : "";
				if (!url && !body) fail("需要 url 或 body");
				const result = await engine.run({
					kind: "rule",
					url: url || undefined,
					body: body || undefined,
					rule,
					listRule: typeof params.listRule === "string" && params.listRule.trim() ? params.listRule.trim() : undefined,
					charset: str(params.charset) || undefined,
					dump: ["none", "snippet", "full"].includes(str(params.dump)) ? str(params.dump) : "snippet",
					dumpMax: params.dumpMax,
				});
				return result;
			},
		},
	];
}
