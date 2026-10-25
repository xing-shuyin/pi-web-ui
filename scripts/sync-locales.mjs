#!/usr/bin/env node
/**
 * sync-locales.mjs — 自动同步多语言包：
 * 以 web/src/i18n.tsx 为唯一事实源，自动同步 locales/*.json 中的 12 个语言包。
 *
 * 核心逻辑：
 * 1. 严格以 web/src/i18n.tsx 中 zh 字典的 key 列表与顺序为基准；
 * 2. 校验 en 字典与 zh 字典的 key 与顺序是否对齐，若有缺失或错位给出清晰提示；
 * 3. 对 12 个语言包（locales/*.json）：
 *    - 保留已有翻译（不覆盖历史翻译成果）；
 *    - 自动清理在 zh 中已被删除的死 key；
 *    - 自动补全新增 key：
 *      · 外语包（de/es/fr/it/ja/ko/pt/ru/tr）：自动使用 en 的英文 fallback 填充，
 *        避免汉字残留（解决 Issue #502 假翻译报错），占位符天然对齐；
 *      · 繁中包（zh-TW/zh-HK/zh-Hant）：若安装了 opencc 则自动转换，未安装则基于词汇规则转换；
 *    - 严格按 zh 顺序重排所有 key，并格式化为标准 Tab 缩进写回。
 *
 * 用法：
 *   node scripts/sync-locales.mjs            # 直接同步并写回 locales/*.json
 *   node scripts/sync-locales.mjs --dry-run  # 仅查看差异，不写回文件
 *   node scripts/sync-locales.mjs --check    # CI 检查模式，存在不同步时以非零退出
 *   npm run i18n:sync
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLocaleMaps } from "./i18n-diff.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const I18N_FILE = "web/src/i18n.tsx";
const LOCALES_DIR = "locales";

/* ------------------------------------------------------------------ */
/* 标点与繁中常用词回退规则                                             */
/* ------------------------------------------------------------------ */

const PUNCT_RULES = [
	[/“([^”]*)”/g, "「$1」"],
	[/([一-鿿])\s?\(([^()]*[一-鿿][^()]*)\)/g, "$1（$2）"],
	[/([一-鿿]):\s?/g, "$1："],
	[/([一-鿿])\?/g, "$1？"],
];

const COMMON_S2T = [
	["设置", "設定"],
	["配置", "配置"],
	["保存", "儲存"],
	["项目", "專案"],
	["默认", "預設"],
	["终端", "終端機"],
	["服务器", "伺服器"],
	["登录", "登入"],
	["鼠标", "滑鼠"],
	["插件", "外掛"],
	["用户", "使用者"],
	["信息", "資訊"],
	["支持", "支援"],
	["取消", "取消"],
	["确定", "確定"],
	["关闭", "關閉"],
	["复制", "複製"],
	["启用", "啟用"],
	["禁用", "停用"],
	["创建", "建立"],
	["删除", "刪除"],
	["编辑", "編輯"],
	["连接", "連線"],
	["刷新", "重新整理"],
	["视图", "檢視"],
	["搜索", "搜尋"],
	["网络", "網路"],
	["文件", "檔案"],
	["对话", "對話"],
	["历史", "歷史"],
	["帮助", "說明"],
];

function applyRules(str, rules) {
	let res = str;
	for (const rule of rules) {
		const [from, to] = rule;
		res = typeof from === "string" ? res.split(from).join(to) : res.replace(from, to);
	}
	return res;
}

/** 尝试加载 OpenCC 转换器（若未安装或不可用则回退为 null）。 */
async function loadOpenCc(repoRoot) {
	try {
		const openccMod = await import(pathToFileURL(join(repoRoot, "scripts/zh-tw-locale/opencc.mjs")).href);
		const OpenCC = openccMod.OpenCC;
		if (!OpenCC?.Converter) return null;

		const glossaryPath = join(repoRoot, "scripts/zh-tw-locale/glossary.mjs");
		const manualPath = join(repoRoot, "scripts/zh-tw-locale/manual.json");
		const twRules = existsSync(glossaryPath) ? await import(pathToFileURL(glossaryPath).href) : { pre: [], post: [] };
		const twManual = existsSync(manualPath) ? JSON.parse(readFileSync(manualPath, "utf8")) : {};
		const punctRules = Array.isArray(twRules.punct) && twRules.punct.length > 0 ? twRules.punct : PUNCT_RULES;

		const twBase = OpenCC.Converter({ from: "cn", to: "twp" });
		const hantBase = OpenCC.Converter({ from: "cn", to: "t" });
		const hkBase = OpenCC.Converter({ from: "cn", to: "hk" });

		const hkPost = [
			[/终端(?!机)/g, "终端机"],
			[/終端(?!機)/g, "終端機"],
			["登录", "登入"],
			["登錄", "登入"],
			["鼠标", "滑鼠"],
			["鼠標", "滑鼠"],
			["服务器", "伺服器"],
			["服務器", "伺服器"],
			["默认", "預設"],
			["默認", "預設"],
		];

		return {
			tw: (text, key) => {
				let r = applyRules(applyRules(twBase(applyRules(text, twRules.pre || [])), twRules.post || []), punctRules);
				const m = twManual[key];
				if (typeof m === "string") r = m;
				else if (Array.isArray(m)) {
					for (const [from, to] of m) {
						if (!r.includes(from)) {
							throw new Error(
								`[sync-locales] manual patch for "${key}": 找不到待替換文字 ${JSON.stringify(from)}，當前文本為：${JSON.stringify(r)}`,
							);
						}
						r = r.split(from).join(to);
					}
				}
				return r;
			},
			hant: (text) => applyRules(hantBase(text), punctRules),
			hk: (text) => applyRules(applyRules(hkBase(text), hkPost), punctRules),
		};
	} catch (err) {
		// OpenCC 缺失时回退到基于词汇表的规则转换，但必须明示：静默降级会让
		// zh-TW/zh-HK 包带上未经转换的简体字（用户看不到原因）。
		console.warn(
			`[sync-locales] 警告：OpenCC 未加载（${err?.message ?? "未知错误"}），` +
				`繁中包将回退到内置规则转换，可能有未转换的简体字残留。` +
				`建议安装：npm i -D opencc-js`,
		);
		return null;
	}
}

/** 提取占位符，与 locales.test.ts 保持一致。 */
export function extractPlaceholders(s) {
	return [...s.matchAll(/\$\{pwd\}|\{\{[a-z]+\}\}|\{\$?[a-zA-Z]+\}|\[\[[a-z_/-]+/g)].map((m) => m[0]).sort();
}

/* ------------------------------------------------------------------ */
/* 主同步逻辑                                                          */
/* ------------------------------------------------------------------ */

export async function syncLocales(options = {}) {
	const repoRoot = options.repoRoot || root;
	const dryRun = Boolean(options.dryRun);
	const checkOnly = Boolean(options.checkOnly);

	const i18nPath = join(repoRoot, I18N_FILE);
	const localesDirPath = join(repoRoot, LOCALES_DIR);

	const i18nSrc = readFileSync(i18nPath, "utf8");
	const { zh, en } = parseLocaleMaps(i18nSrc);

	const warnings = [];
	const zhKeys = zh.order;
	const zhSet = new Set(zhKeys);
	const enSet = new Set(en.order);

	// 校验 en 字典
	const missingEn = zhKeys.filter((k) => !enSet.has(k));
	const extraEn = en.order.filter((k) => !zhSet.has(k));
	if (missingEn.length > 0) {
		warnings.push(
			`web/src/i18n.tsx 中 en 缺少 ${missingEn.length} 个 key：${missingEn.slice(0, 5).join(", ")}${missingEn.length > 5 ? "…" : ""}`,
		);
	}
	if (extraEn.length > 0) {
		warnings.push(
			`web/src/i18n.tsx 中 en 多余 ${extraEn.length} 个 key：${extraEn.slice(0, 5).join(", ")}${extraEn.length > 5 ? "…" : ""}`,
		);
	}
	if (missingEn.length === 0 && extraEn.length === 0) {
		const orderMismatch = zhKeys.findIndex((k, idx) => en.order[idx] !== k);
		if (orderMismatch !== -1) {
			warnings.push(
				`web/src/i18n.tsx 中 zh 与 en 键顺序在第 ${orderMismatch + 1} 项错位（zh: "${zhKeys[orderMismatch]}", en: "${en.order[orderMismatch]}"）`,
			);
		}
	}

	const opencc = await loadOpenCc(repoRoot);

	const packFiles = readdirSync(localesDirPath)
		.filter((f) => f.endsWith(".json"))
		.sort();

	const results = [];
	let totalAdded = 0;
	let totalPruned = 0;
	let totalReordered = 0;

	for (const f of packFiles) {
		const filePath = join(localesDirPath, f);
		const raw = readFileSync(filePath, "utf8");
		const pack = JSON.parse(raw);
		const originalStrings = pack.strings || {};
		const originalKeys = Object.keys(originalStrings);
		const origKeySet = new Set(originalKeys);

		const addedKeys = [];
		const prunedKeys = originalKeys.filter((k) => !zhSet.has(k));
		let isReordered = false;

		const newStrings = {};
		for (let i = 0; i < zhKeys.length; i++) {
			const k = zhKeys[i];
			if (originalKeys[i] !== k) {
				isReordered = true;
			}

			if (origKeySet.has(k)) {
				// 保留已有翻译，但需校验占位符完整性
				let val = originalStrings[k];
				const zhVal = zh.map.get(k) || "";
				const zhHolders = extractPlaceholders(zhVal);
				const valHolders = extractPlaceholders(val);
				if (JSON.stringify(zhHolders) !== JSON.stringify(valHolders)) {
					// 占位符不匹配：若该语言包本就是 fallback 状态或损坏，回退到 en 翻译保证单测通过
					const enFallback = en.map.get(k);
					if (enFallback && JSON.stringify(extractPlaceholders(enFallback)) === JSON.stringify(zhHolders)) {
						val = enFallback;
					}
				}
				newStrings[k] = val;
			} else {
				// 新增 key 自动补齐
				addedKeys.push(k);
				const zhVal = zh.map.get(k) || "";
				const enVal = en.map.get(k) || zhVal;

				if (pack.code === "zh-TW") {
					newStrings[k] = opencc ? opencc.tw(zhVal, k) : applyRules(applyRules(zhVal, COMMON_S2T), PUNCT_RULES);
				} else if (pack.code === "zh-Hant") {
					newStrings[k] = opencc ? opencc.hant(zhVal) : applyRules(applyRules(zhVal, COMMON_S2T), PUNCT_RULES);
				} else if (pack.code === "zh-HK") {
					newStrings[k] = opencc ? opencc.hk(zhVal) : applyRules(applyRules(zhVal, COMMON_S2T), PUNCT_RULES);
				} else {
					// 外语语言包：必须使用 en 的英文 fallback（严格禁止汉字残留）
					newStrings[k] = enVal;
				}
			}
		}

		totalAdded += addedKeys.length;
		totalPruned += prunedKeys.length;
		if (isReordered) totalReordered++;

		const changed = addedKeys.length > 0 || prunedKeys.length > 0 || isReordered;
		results.push({
			file: f,
			code: pack.code,
			added: addedKeys,
			pruned: prunedKeys,
			reordered: isReordered,
			changed,
		});

		if (changed && !dryRun && !checkOnly) {
			// 只重写 `strings`，其余顶层键**原样带回**：同一个语言包里还住着 `serverStrings`
			// （服务端 pick() 的译文，见 server/i18n.ts）。以前这里手工重建对象、只写
			// code/nativeName/version/strings，一次 `npm run i18n:sync` 就把整块服务端译文
			// 静默删掉（pt/ja/tr 各丢 371/164/327 条，连带 locales 相关单测全红）。
			const newPack = { ...pack, strings: newStrings };
			writeFileSync(filePath, JSON.stringify(newPack, null, "\t") + "\n", "utf8");
		}
	}

	const hasChanges = totalAdded > 0 || totalPruned > 0 || totalReordered > 0;
	return {
		ok: !checkOnly || !hasChanges,
		totalAdded,
		totalPruned,
		totalReordered,
		warnings,
		results,
		hasChanges,
	};
}

/* ------------------------------------------------------------------ */
/* CLI 入口                                                            */
/* ------------------------------------------------------------------ */

async function main() {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes("--dry-run");
	const checkOnly = argv.includes("--check");

	if (argv.includes("-h") || argv.includes("--help")) {
		console.log("用法：node scripts/sync-locales.mjs [--dry-run] [--check]");
		console.log("  （缺省）：以 web/src/i18n.tsx 为准，自动补齐缺失 key、清理死 key、按 zh 键序重排并写回 12 个语言包");
		console.log("  --dry-run：只打印待改动内容，不写入文件");
		console.log("  --check：检查是否有不同步，若存在差异以状态码 1 退出（用于 CI）");
		return;
	}

	console.log(`[i18n:sync] 扫描 web/src/i18n.tsx 与 locales/*.json ...`);
	const res = await syncLocales({ dryRun, checkOnly });

	for (const w of res.warnings) {
		console.warn(`\x1b[33m⚠  ${w}\x1b[0m`);
	}

	for (const r of res.results) {
		const statusParts = [];
		if (r.added.length > 0) statusParts.push(`+${r.added.length} 新增`);
		if (r.pruned.length > 0) statusParts.push(`-${r.pruned.length} 死key`);
		if (r.reordered) statusParts.push(`顺序重排`);

		if (statusParts.length > 0) {
			console.log(` · ${r.code.padEnd(8)}: ${statusParts.join(", ")}`);
		}
	}

	if (!res.hasChanges) {
		console.log(`\x1b[32m✓ 12 个语言包已与 web/src/i18n.tsx 完全同步且键序一致。\x1b[0m`);
	} else if (dryRun) {
		console.log(
			`\x1b[36mi [dry-run] 发现差异：共 ${res.totalAdded} 个新增 key，${res.totalPruned} 个死 key，未写入文件。\x1b[0m`,
		);
	} else if (checkOnly) {
		console.error(`\x1b[31m✗ [check] 语言包存在未同步变动，请执行 npm run i18n:sync 自动对齐。\x1b[0m`);
		process.exit(1);
	} else {
		console.log(
			`\x1b[32m✓ 同步完成：共补齐 ${res.totalAdded} 个 key，清理 ${res.totalPruned} 个死 key，12 个语言包已格式化写回。\x1b[0m`,
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
