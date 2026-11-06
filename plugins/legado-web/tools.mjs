const fail = (msg) => {
	throw new Error(msg);
};

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
	const writeCheck = (rec) => store.write("check", rec);
	const normCheckKey = (u) => String(u ?? "").replace(/[/#]+$/, "");

	return [
		{
			name: "legado_rules",
			label: "Legado 规则速查",
			description:
				"Legado book-source rule reference for this plugin: data structure (BookSource + ruleSearch/ruleBookInfo/ruleToc/ruleContent fields), evaluation semantics (CSS/XPath/JSONPath/JS, || && %%, ## replacement, @put/@get, {{}} templates, :N index), java.* bindings, known deviations, and the recommended repair workflow.",
			promptSnippet: "Legado rule syntax and semantics",
			promptGuidelines: [
				"Before fixing any Legado book source, call legado_rules to confirm rule semantics",
				"In this engine a single-segment CSS rule = selector + text extraction; output forms like `text`/`href` are also supported",
			],
			parameters: {
				type: "object",
				properties: {
					topic: {
						type: "string",
						description:
							"Only return sections containing this keyword (e.g. css / js / toc / content / workflow); omit for the full text",
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
			description:
				"Read/edit this plugin's Legado book-source file (<dataDir>/legado-web/sources.json): list (filter by name/url, with health), get (one source's JSON), update (deep-merge fields, e.g. only ruleContent.content), add (import/replace a whole source), remove, unmark (clear the dead/suspect mark after a verified fix, or the page keeps hiding it).",
			promptSnippet: "read/edit the book-source file",
			promptGuidelines: [
				"To edit a Legado book source use only legado_book_sources update (deep-merge by field); never overwrite the whole file or hand-edit the 5MB sources.json.",
				"After editing, verify with legado_source_probe, then unmark that source's dead/suspect mark (the page hides dead sources otherwise)",
				"Remind the user to reload the reader page afterwards (the browser copy is in-memory)",
			],
			parameters: {
				type: "object",
				required: ["action"],
				properties: {
					action: {
						type: "string",
						enum: ["list", "get", "update", "add", "remove", "unmark"],
						description:
							"Operation to run (unmark = clear the source's dead/suspect check mark; call after a verified fix)",
					},
					query: { type: "string", description: "list: filter by name or URL substring" },
					url: {
						type: "string",
						description: "bookSourceUrl (locates the source for get/update/remove; required for update)",
					},
					name: { type: "string", description: "Locate by book-source name substring (used when url is not given)" },
					fields: {
						type: "object",
						description: 'update: fields to merge into the source, e.g. { ruleContent: { content: "#content@text" } }',
					},
					source: {
						type: "object",
						description: "add: the full book-source JSON (replaced by bookSourceUrl, or appended)",
					},
					limit: { type: "number", description: "Max items returned by list, default 50" },
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

				if (action === "unmark") {
					const rec = readCheck();
					const gone = Object.keys(rec).filter((u) => normCheckKey(u) === normCheckKey(target.bookSourceUrl));
					for (const u of gone) delete rec[u];
					if (gone.length) writeCheck(rec);
					return {
						ok: true,
						url: target.bookSourceUrl,
						name: target.bookSourceName,
						unmarked: gone.length,
						note: gone.length
							? "已摘掉废源/可疑标记，书源/搜索/发现页会自动重读出现；提醒用户刷新阅读页"
							: "该源本来就没有检测标记，无需处理；提醒用户刷新阅读页",
					};
				}

				fail(`未知 action：${action}`);
			},
		},

		{
			name: "legado_source_probe",
			label: "Legado 书源诊断",
			description:
				"Run the Legado pipeline for one book source step by step (reach → search → info → TOC → content), reporting per step: request URLs, HTTP status, page size and snippets, parsed values, the exact rule strings used, and every rule failure.",
			promptSnippet: "diagnose a broken book source step by step",
			promptGuidelines: [
				'When a source returns no content, run legado_source_probe (dump="snippet") first to locate the break, then fix the rule; never rewrite a whole source from scratch.',
			],
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Book source bookSourceUrl (either url or name; url preferred)" },
					name: { type: "string", description: "Book-source name substring" },
					key: { type: "string", description: 'Search keyword, default "剑"' },
					mode: { type: "string", enum: ["reach", "search", "full"], description: "How far to run, default full" },
					step: {
						type: "string",
						enum: ["reach", "search", "info", "toc", "content"],
						description: "Test only this step (with bookUrl, earlier steps can be skipped)",
					},
					bookUrl: {
						type: "string",
						description:
							"Direct address: step=info gives the book page, step=toc the TOC page, step=content the chapter page",
					},
					dump: {
						type: "string",
						enum: ["none", "snippet", "full"],
						description:
							"Whether to return the page body (default snippet; very useful when working out how to write the rule)",
					},
					dumpMax: { type: "number", description: "Max page-body characters returned, default 4000" },
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
			description:
				"Fetch a page and evaluate a single Legado rule against it (optionally via a list rule for item-level child rules), returning request info, page snippet and the exact extracted values. Use it to verify a rule fix before saving.",
			promptSnippet: "try one rule against a fetched page",
			parameters: {
				type: "object",
				required: ["url", "rule"],
				properties: {
					url: { type: "string", description: "Page to fetch (from the source site)" },
					rule: { type: "string", description: 'Rule to try, e.g. "#content@text", ".title", "$.data.list"' },
					listRule: {
						type: "string",
						description:
							'Item-level child rule: items are selected by it, then rule is evaluated per item (e.g. "li.chapter")',
					},
					charset: { type: "string", description: "Site encoding (gbk etc.), default auto-detect" },
					body: {
						type: "string",
						description: "Without url, test the rule against this page body directly (rarely used)",
					},
					dump: {
						type: "string",
						enum: ["none", "snippet", "full"],
						description: "none | snippet | full (default snippet)",
					},
					dumpMax: { type: "number", description: "Max page-body characters returned, default 3000" },
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
