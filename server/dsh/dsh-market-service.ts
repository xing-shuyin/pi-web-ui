import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DshMarketPlugin } from "../protocol.js";

const DSH_MARKET_URL = "https://awesome-dsh-plugin.com/plugins.json";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface DshMarketDataResult {
	count: number;
	updated: string;
	categories: Record<string, { en: string; zh: string }>;
	plugins: DshMarketPlugin[];
}

const SEED_CATEGORIES: Record<string, { en: string; zh: string }> = {
	model: { en: "Models & Providers", zh: "模型与账号接入" },
	ui: { en: "UI Enhancements", zh: "UI 增强" },
	memory: { en: "Memory", zh: "记忆" },
	workflow: { en: "Workflow & Automation", zh: "工作流与自动化" },
	skills: { en: "Skills", zh: "技能" },
	tools: { en: "Tools & Capabilities", zh: "工具与能力" },
	market: { en: "Plugin Markets & Managers", zh: "插件市场与管理器" },
};

const SEED_PLUGINS: DshMarketPlugin[] = [
	{
		name: "dsh-our-free-model",
		owner: "Ebony-Vinyl",
		url: "https://github.com/Ebony-Vinyl/dsh-our-free-model",
		category: "model",
		description: {
			zh: "无需登录或 API Key，聚合 DeepSeek V4.1 Flash、Kimi K3 及 13 个主流渠道账号池，完全免费。",
			en: "Frontier models without login or API key: DeepSeek V4.1 Flash, Kimi K3, and 13 channel pools. Completely free.",
		},
		npm: "dsh-our-free-model",
		version: "2.1.0",
		stars: 3820,
		downloads: 185000,
		capabilities: ["net", "env"],
	},
	{
		name: "dshmarket",
		owner: "dsh-market",
		url: "https://github.com/dsh-market/dsh-market",
		category: "market",
		description: {
			zh: "DSH 可视化插件市场：逛一逛，点一下，装好。4500+ 社区插件一键发现与管理。",
			en: "Visual plugin market inside DeepSeek Harness: browse, search, and one-click install 4500+ community plugins.",
		},
		npm: "dshmarket",
		version: "1.66.20",
		stars: 4950,
		downloads: 320000,
		capabilities: ["fs-write", "net"],
	},
	{
		name: "dsh-better-sidebar",
		owner: "omdsh-dev",
		url: "https://github.com/omdsh-dev/dsh-better-sidebar",
		category: "ui",
		description: {
			zh: "侧边栏工作台增强，集成文件渲染、代码编辑、终端、Git 与子代理多标签管理。",
			en: "Full sidebar workbench with file rendering, editing, terminal, Git, and subagents tab management.",
		},
		npm: "@omdsh/dsh-better-sidebar",
		version: "0.21.1",
		stars: 3710,
		downloads: 265800,
		capabilities: ["ui", "fs-read"],
	},
	{
		name: "dsh-project-memory",
		owner: "00080000",
		url: "https://github.com/00080000/dsh-project-memory",
		category: "memory",
		description: {
			zh: "持久化项目级记忆系统：任务清单与阅读文件自动沉淀为跨会话记忆，开发工作流可切换续接。",
			en: "Project memory for dsh: session todos and file reads auto-condense into cross-session task records.",
		},
		npm: "@00080000/dsh-project-memory",
		version: "0.4.0",
		stars: 2150,
		downloads: 142000,
		capabilities: ["fs-write", "fs-read"],
	},
	{
		name: "dsh-task-board",
		owner: "zhu1090093659",
		url: "https://github.com/zhu1090093659/dsh-task-board",
		category: "workflow",
		description: {
			zh: "侧边栏多列看板与定时任务，在后台实时执行并支持 Cron 周期计划调度。",
			en: "Task board for dsh web GUI: multi-column kanban and cron expression execution.",
		},
		npm: "dsh-task-board",
		version: "0.4.1",
		stars: 1840,
		downloads: 177400,
		capabilities: ["fs-write", "timer"],
	},
	{
		name: "dsh-skill-explorer",
		owner: "zhu1090093659",
		url: "https://github.com/zhu1090093659/dsh-skill-explorer",
		category: "skills",
		description: {
			zh: "技能中心：浏览所有已加载技能，按来源分组管理，支持启用/停用与模型调用权限控制。",
			en: "Skill center for dsh web GUI: browse and manage all loaded skills grouped by source.",
		},
		npm: "dsh-skill-explorer",
		version: "0.4.1",
		stars: 1980,
		downloads: 178500,
		capabilities: ["fs-read"],
	},
	{
		name: "dsh-answer-reviewer",
		owner: "bycall",
		url: "https://github.com/bycall/dsh-answer-reviewer",
		category: "workflow",
		description: {
			zh: "智能体答案复审器：独立大模型对助手最终回复打分并提供纠错反馈，低于阈值自动返工。",
			en: "Agentic answer reviewer for DeepSeek Harness: scores turns 1-100 and steers agent with feedback.",
		},
		npm: "dsh-answer-reviewer",
		version: "0.3.5",
		stars: 1250,
		downloads: 98000,
		capabilities: ["llm"],
	},
];

interface RawMarketResponse {
	count?: number;
	updated?: string;
	categories?: Record<string, { en: string; zh: string }>;
	plugins?: Record<string, any> | any[];
}

export async function loadDshMarketData(dataDir: string, force = false): Promise<DshMarketDataResult> {
	const cachePath = join(dataDir, "dsh-market-cache.json");

	if (!force && existsSync(cachePath)) {
		try {
			const raw = readFileSync(cachePath, "utf8");
			const cached = JSON.parse(raw);
			if (cached.savedAt && Date.now() - cached.savedAt < CACHE_TTL_MS && Array.isArray(cached.plugins)) {
				return {
					count: cached.count ?? cached.plugins.length,
					updated: cached.updated ?? "",
					categories: cached.categories ?? SEED_CATEGORIES,
					plugins: cached.plugins,
				};
			}
		} catch {}
	}

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);
		const resp = await fetch(DSH_MARKET_URL, {
			signal: controller.signal,
			headers: { "User-Agent": "pi-web-ui/dsh-market" },
		});
		clearTimeout(timeoutId);

		if (resp.ok) {
			const json = (await resp.json()) as RawMarketResponse;
			const categories = json.categories && typeof json.categories === "object" ? json.categories : SEED_CATEGORIES;

			const pluginList: DshMarketPlugin[] = [];
			if (json.plugins) {
				const entries = Array.isArray(json.plugins) ? json.plugins : Object.values(json.plugins);
				for (const p of entries) {
					if (!p || typeof p !== "object" || !p.name) continue;
					pluginList.push({
						name: String(p.name),
						owner: p.owner ? String(p.owner) : undefined,
						url: p.url ? String(p.url) : undefined,
						category: p.category ? String(p.category) : undefined,
						description:
							typeof p.description === "object" && p.description
								? {
										zh: p.description.zh ? String(p.description.zh) : undefined,
										en: p.description.en ? String(p.description.en) : undefined,
									}
								: undefined,
						npm: p.npm ? String(p.npm) : undefined,
						version: p.version ? String(p.version) : undefined,
						stars: typeof p.stars === "number" ? p.stars : 0,
						downloads: typeof p.downloads === "number" ? p.downloads : 0,
						capabilities: Array.isArray(p.capabilities) ? p.capabilities.map(String) : [],
						install: p.install ? String(p.install) : undefined,
					});
				}
			}

			pluginList.sort((a, b) => (b.downloads ?? 0) + (b.stars ?? 0) * 10 - ((a.downloads ?? 0) + (a.stars ?? 0) * 10));

			const result: DshMarketDataResult = {
				count: pluginList.length,
				updated: json.updated ?? new Date().toISOString().slice(0, 10),
				categories,
				plugins: pluginList,
			};

			try {
				writeFileSync(cachePath, JSON.stringify({ ...result, savedAt: Date.now() }), "utf8");
			} catch {}

			return result;
		}
	} catch (err) {
		console.warn(`[dsh-market] 拉取远程市场失败: ${(err as Error).message}，使用缓存或种子数据`);
	}

	if (existsSync(cachePath)) {
		try {
			const cached = JSON.parse(readFileSync(cachePath, "utf8"));
			if (Array.isArray(cached.plugins)) {
				return {
					count: cached.count ?? cached.plugins.length,
					updated: cached.updated ?? "",
					categories: cached.categories ?? SEED_CATEGORIES,
					plugins: cached.plugins,
				};
			}
		} catch {}
	}

	return {
		count: SEED_PLUGINS.length,
		updated: new Date().toISOString().slice(0, 10),
		categories: SEED_CATEGORIES,
		plugins: SEED_PLUGINS,
	};
}
