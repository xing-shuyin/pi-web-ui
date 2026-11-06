export const AI_FIX_MESSAGE_TYPE = "legado:ai-fix";

const SCENE_TEXT = {
	content: "阅读正文失败",
	toc: "目录加载失败",
	detail: "详情/目录加载失败",
	search: "搜索失败",
	explore: "发现页加载失败",
	source: "手动修复（书源页）",
	check: "书源检测不通过",
	new: "新建书源（只给了网站链接）",
};

export function isAiFixMessage(data) {
	return Boolean(data && typeof data === "object" && data.type === AI_FIX_MESSAGE_TYPE);
}

export function normalizeFixContext(raw) {
	const ctx = raw && typeof raw === "object" ? raw : {};
	const s = (v, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
	const scene = s(ctx.scene, 20);
	return {
		scene: scene in SCENE_TEXT ? scene : "source",
		sourceUrl: s(ctx.sourceUrl),
		sourceName: s(ctx.sourceName, 120),
		bookName: s(ctx.bookName, 120),
		bookUrl: s(ctx.bookUrl),
		url: s(ctx.url),
		error: s(ctx.error, 1500),
		reason: s(ctx.reason, 800),
		steps: s(ctx.steps, 800),
		rules: ctx.rules && typeof ctx.rules === "object" ? ctx.rules : undefined,
	};
}

function constraintLines() {
	return [
		"硬约束：",
		"- 不要修改阅读插件的任何文件（app/、client/、server/、*.mjs 等）：它是安装产物，更新时会被整目录覆盖，改了也会丢；本机也可能没有它的源码；",
		"- 不要手工编辑书源文件本身，用 legado_book_sources 工具改（大文件、要保证落盘格式）；",
		"- 若判断是站点整体失效/需要 WebJS 渲染/引擎不支持的写法，直接说明并给出**等价规则**的绕法（例如单引号 ,{...} 改双引号、POST 补 Content-Type），做不到就建议换源或删源；不要试图改引擎代码。",
	];
}

function buildNewSourcePrompt(c, dirs) {
	const site = c.sourceUrl || c.url || "(未提供)";
	const dataDir = typeof dirs.dataDir === "string" ? dirs.dataDir.trim() : "";
	const sourcesFile =
		typeof dirs.sourcesFile === "string" && dirs.sourcesFile.trim()
			? dirs.sourcesFile.trim()
			: dataDir
				? `${dataDir}/sources.json`
				: "";
	const pluginDir = typeof dirs.pluginDir === "string" ? dirs.pluginDir.trim() : "";
	const rulesFile =
		typeof dirs.rulesFile === "string" && dirs.rulesFile.trim()
			? dirs.rulesFile.trim()
			: pluginDir
				? `${pluginDir}/rules.md`
				: "";
	const lines = [
		"【AI 新建书源】请为下面这个网站新建一个 Legado 文本书源（bookSourceType=0）并存盘。只加书源数据，不要改阅读插件本身。",
		"",
		`- 网站：${site}`,
	];
	if (c.error) lines.push(`- 备注：${c.error}`);
	if (sourcesFile) lines.push(`- 书源文件（要加进去的就是它）：${sourcesFile}`);
	if (rulesFile) lines.push(`- 规则速查（只读）：${rulesFile}`);
	if (dataDir) lines.push(`- 工作目录：${dataDir}（书源/书架/检测数据都在这儿）`);
	if (pluginDir) lines.push(`- 阅读插件目录（**只读，不要修改**）：${pluginDir}`);
	lines.push("");
	lines.push("请自己抓页分析，不要问我站点结构。按顺序做：");
	lines.push("1) legado_rules 看规则语义（等价于读上面那个规则速查文件）；");
	lines.push(
		`2) legado_run_rule 抓首页看结构（url=${site}，rule="html" 或 dump="snippet"），找到搜索入口（form action / /search?q= / /s?q= 等）、书籍链接与章节链接的写法；`,
	);
	lines.push(
		"3) 写出 searchUrl + ruleSearch（bookList / name / author / bookUrl），用 legado_run_rule（条目级用 listRule）验证能解析出书名与详情地址；",
	);
	lines.push(
		"4) 再定 ruleBookInfo（name/author/intro/tocUrl）、ruleToc（chapterList/chapterName/chapterUrl）、ruleContent（content），每一步都在真实页面上用 legado_run_rule 验证；",
	);
	lines.push('5) legado_source_probe 跑一遍完整链路（搜索→详情→目录→正文，dump="none"）确认可用；');
	lines.push(
		"6) legado_book_sources 的 add 保存整份书源：bookSourceUrl 用站点根地址、bookSourceType 0、enabled true，名称自拟（带站点特征，便于辨认）；",
	);
	lines.push("");
	lines.push(
		"最后告诉我：源名、bookSourceUrl、写出的各规则字段，以及哪一步不确定（需要 WebJS 渲染/需要登录/接口要签名的要明说，不要硬凑规则）。",
	);
	lines.push("");
	lines.push(...constraintLines());
	return lines.join("\n");
}

export function buildFixPrompt(rawContext, dirs = {}) {
	const c = normalizeFixContext(rawContext);
	if (c.scene === "new") return buildNewSourcePrompt(c, dirs);
	const dataDir = typeof dirs.dataDir === "string" ? dirs.dataDir.trim() : "";
	const sourcesFile =
		typeof dirs.sourcesFile === "string" && dirs.sourcesFile.trim()
			? dirs.sourcesFile.trim()
			: dataDir
				? `${dataDir}/sources.json`
				: "";
	const pluginDir = typeof dirs.pluginDir === "string" ? dirs.pluginDir.trim() : "";
	const rulesFile =
		typeof dirs.rulesFile === "string" && dirs.rulesFile.trim()
			? dirs.rulesFile.trim()
			: pluginDir
				? `${pluginDir}/rules.md`
				: "";
	const lines = ["【AI 修复书源】请诊断并修好下面这个 Legado 书源。只改书源数据，不要改阅读插件本身。", ""];
	lines.push(`- 书源：${c.sourceName || "(未命名)"}（${c.sourceUrl || "URL 未知"}）`);
	lines.push(`- 场景：${SCENE_TEXT[c.scene]}`);
	if (c.bookName) lines.push(`- 书籍：${c.bookName}${c.bookUrl ? `（${c.bookUrl}）` : ""}`);
	if (c.url && c.url !== c.bookUrl) lines.push(`- 出错地址：${c.url}`);
	if (c.error) lines.push(`- 报错原文：${c.error}`);
	if (c.reason) lines.push(`- 检测结论：${c.reason}`);
	if (c.steps) lines.push(`- 检测各步：${c.steps}`);
	if (c.rules && Object.keys(c.rules).length) {
		lines.push(`- 当前相关规则：`);
		for (const [k, v] of Object.entries(c.rules)) lines.push(`  - ${k} = ${JSON.stringify(v)}`);
	}
	if (sourcesFile) lines.push(`- 书源文件（要改的就是它）：${sourcesFile}`);
	if (rulesFile) lines.push(`- 规则速查（只读）：${rulesFile}`);
	if (dataDir) lines.push(`- 工作目录：${dataDir}（书源/书架/检测数据都在这儿）`);
	if (pluginDir) lines.push(`- 阅读插件目录（**只读，不要修改**）：${pluginDir}`);
	lines.push("");
	lines.push("按顺序做：");
	lines.push("1) 先 legado_rules 看规则语义（等价于读上面那个规则速查文件）；");
	lines.push('2) 再 legado_source_probe（dump="snippet"）定位断在哪一步；');
	lines.push(
		"3) 用 legado_run_rule 在真实页面上试修正后的规则；确认有效后用 legado_book_sources 的 update 只改坏掉的字段；",
	);
	lines.push("4) 最后告诉我改了哪个字段、依据是什么，我会刷新阅读页验证。");
	lines.push("");
	lines.push("硬约束：");
	lines.push(
		"- 不要修改阅读插件的任何文件（app/、client/、server/、*.mjs 等）：它是安装产物，更新时会被整目录覆盖，改了也会丢；本机也可能没有它的源码；",
	);
	lines.push("- 不要手工编辑书源文件本身，用 legado_book_sources 工具改（大文件、要保证落盘格式）；");
	lines.push(
		"- 若判断是站点整体失效/需要 WebJS 渲染/引擎不支持的写法，直接说明并给出**等价规则**的绕法（例如单引号 ,{...} 改双引号、POST 补 Content-Type），做不到就建议换源或删源；不要试图改引擎代码。",
	);
	return lines.join("\n");
}
