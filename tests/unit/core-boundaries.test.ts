import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const coreDir = join(root, "packages", "keel", "src");

const LAYERS = ["contracts", "kernel", "domains", "adapters", "app"] as const;
type Layer = (typeof LAYERS)[number];

/** 老树里禁止被新树引用的模块：引了就说明新树又长回了上帝对象。 */
const FORBIDDEN_LEGACY = [
	"server/agent-service.ts",
	"server/agent-service-daemon.ts",
	"server/index.ts",
	"server/dispatch-domain-handlers.ts",
	"server/dispatch-plugin-handlers.ts",
];

const MAX_CORE_FILE_LINES = 600;

/**
 * 老叶子搬入预算表：P1 从 `server/` 搬进来的模块**搬之前就超过 600 行**，只许降不许升。
 * 不在这张表里的文件一律受 600 行限制；把这里的数字改大 = 又长出一个巨型模块。
 */
const LEGACY_LEAF_BUDGET: Record<string, number> = {
	"packages/keel/src/protocol.ts": 4124,
	"packages/keel/src/subagents.ts": 2183,
	// P2 给 write/edit 注入远程工作区操作（+1 行）：仍是只许降，下一个改它的人请顺手压回去。
	"packages/keel/src/tool-guards.ts": 912,
	"packages/keel/src/hashline-engine.ts": 876,
	// 工具目录（纯数据 + 纯函数，P2 从 server/tool-manager.ts 整份搬入）。
	"packages/keel/src/tool-catalog.ts": 748,
	"packages/keel/src/subagent-templates.ts": 732,
};

/** 只允许这些路径碰 SDK 与喂轮出口；其余层只认 `contracts/session.ts` 的窄面。 */
const SDK_BOUNDARY = [
	"packages/keel/src/domains/turns/feed.ts",
	"packages/keel/src/adapters/sdk/",
	"packages/keel/src/adapters/models/",
	"packages/keel/src/adapters/tools/",
];

/**
 * P1 搬进来的老叶子**原本就直连 SDK**（搬之前住在 `server/`，不受本守卫扫描）：
 * 搬入不是新授权，这张表只许变短——每条都要么被端口反转掉，要么被改造成只认 `contracts/` 的窄面。
 */
const LEGACY_LEAF_SDK = new Set([
	"packages/keel/src/agent-formatters.ts",
	"packages/keel/src/ask-user-question-tool.ts",
	"packages/keel/src/browser-page-tool.ts",
	"packages/keel/src/engine-catalog.ts",
	"packages/keel/src/serialize.ts",
	"packages/keel/src/session-branch.ts",
	"packages/keel/src/session-list-scan.ts",
	"packages/keel/src/session-open.ts",
	"packages/keel/src/session-parser.ts",
	"packages/keel/src/session-projection.ts",
	"packages/keel/src/session-search.ts",
	"packages/keel/src/session-turns.ts",
	"packages/keel/src/subagent-security-gate.ts",
	"packages/keel/src/subagents.ts",
	"packages/keel/src/tool-guards.ts",
	"packages/keel/src/tool-overrides.ts",
]);

function inSdkBoundary(rel: string): boolean {
	return SDK_BOUNDARY.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

/** 老叶子 = `packages/keel/src/<m>.ts`（直接躺在 src 根，不属于五个分层）。 */
function isLegacyLeaf(rel: string): boolean {
	const parts = rel.split("/");
	return parts[2] === "src" && parts.length === 4 && !(LAYERS as readonly string[]).includes(parts[3]);
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function specifiers(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]);
	for (const m of source.matchAll(/^\s*export\s+\*\s+from\s*["']([^"']+)["']/gm)) out.push(m[1]);
	return out;
}

function toRepoPath(file: string, spec: string): string | undefined {
	if (!spec.startsWith(".")) return undefined;
	const abs = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
	return relative(root, abs).split(sep).join("/");
}

function layerOf(rel: string): Layer | undefined {
	const parts = rel.split("/");
	return parts[0] === "packages" && parts[1] === "keel" && parts[2] === "src" && LAYERS.includes(parts[3] as Layer)
		? (parts[3] as Layer)
		: undefined;
}

function domainOf(rel: string): string | undefined {
	const parts = rel.split("/");
	return parts[3] === "domains" && parts.length > 5 ? parts[4] : undefined;
}

const files = walk(coreDir).map((file) => ({ abs: file, rel: relative(root, file).split(sep).join("/") }));

const ALLOWED_EDGES: Record<Layer, readonly Layer[]> = {
	contracts: ["contracts"],
	kernel: ["contracts", "kernel"],
	domains: ["contracts", "kernel", "domains"],
	adapters: ["contracts", "kernel", "adapters"],
	app: ["contracts", "kernel", "domains", "adapters", "app"],
};

describe("keel/src 分层边界", () => {
	it("新树里确实有文件（防止扫描器坏掉后静默通过）", () => {
		expect(files.length).toBeGreaterThanOrEqual(6);
	});

	it("分层依赖方向只有一条：contracts ← kernel ← domains ← app", () => {
		const violations: string[] = [];
		for (const file of files) {
			const from = layerOf(file.rel);
			if (!from) continue;
			for (const spec of specifiers(readFileSync(file.abs, "utf8"))) {
				const target = toRepoPath(file.abs, spec);
				if (!target) continue;
				const to = layerOf(target);
				if (!to || to === from) continue;
				if (!ALLOWED_EDGES[from].includes(to)) violations.push(`${file.rel} → ${target}（${from} 不允许依赖 ${to}）`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("域之间不互相 import（只许经过 contracts / kernel）", () => {
		const violations: string[] = [];
		for (const file of files) {
			const from = domainOf(file.rel);
			if (!from) continue;
			for (const spec of specifiers(readFileSync(file.abs, "utf8"))) {
				const target = toRepoPath(file.abs, spec);
				if (!target) continue;
				const to = domainOf(target);
				if (to && to !== from) violations.push(`${file.rel} → ${target}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("新树不得引用上帝对象相关的老模块", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const spec of specifiers(readFileSync(file.abs, "utf8"))) {
				const target = toRepoPath(file.abs, spec);
				if (target && FORBIDDEN_LEGACY.includes(target)) violations.push(`${file.rel} → ${target}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("SDK 与喂轮出口只在声明过的边界文件里出现", () => {
		const violations: string[] = [];
		for (const file of files) {
			if (inSdkBoundary(file.rel) || LEGACY_LEAF_SDK.has(file.rel)) continue;
			const text = readFileSync(file.abs, "utf8");
			if (/@earendil-works\/pi-coding-agent/.test(text)) violations.push(`${file.rel}（直接依赖 SDK）`);
			if (/session-turns\.js/.test(text)) violations.push(`${file.rel}（直接依赖喂轮出口）`);
		}
		expect(violations).toEqual([]);
	});

	it("老叶子 SDK 例外表只许变短（每条都必须真的还在 import SDK）", () => {
		const stale = [...LEGACY_LEAF_SDK].filter((rel) => {
			const abs = join(root, rel);
			return !readFileSync(abs, "utf8").includes("@earendil-works/pi-coding-agent");
		});
		expect(stale, `这些文件已经不碰 SDK 了，把例外行删掉：\n${stale.join("\n")}`).toEqual([]);
	});

	it("老叶子只能往下引（contracts 可以，kernel/domains/adapters/app 不行）", () => {
		const violations: string[] = [];
		for (const file of files) {
			if (!isLegacyLeaf(file.rel) || file.rel === "packages/keel/src/index.ts") continue;
			for (const spec of specifiers(readFileSync(file.abs, "utf8"))) {
				const target = toRepoPath(file.abs, spec);
				const layer = target ? layerOf(target) : undefined;
				// `contracts` 是最底层（纯类型），老叶子引它不算反向依赖；其余四层都不行。
				if (layer && layer !== "contracts") violations.push(`${file.rel} → ${target}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("单个文件不超过 600 行（老叶子搬入按预算表豁免，只许降）", () => {
		const big: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file.abs, "utf8").split("\n").length;
			const budget = LEGACY_LEAF_BUDGET[file.rel];
			if (budget === undefined) {
				if (lines > MAX_CORE_FILE_LINES) big.push(`${file.rel}: ${lines}`);
			} else if (lines > budget) big.push(`${file.rel}: ${lines} > 预算 ${budget}`);
		}
		expect(big).toEqual([]);
	});

	it("预算表只许变短（存量条目已降到预算以下时，把数字改小）", () => {
		const stale = Object.entries(LEGACY_LEAF_BUDGET)
			.filter(([rel, budget]) => readFileSync(join(root, rel), "utf8").split("\n").length < budget / 2)
			.map(([rel, budget]) => `${rel}: 预算 ${budget} 已远高于实际`);
		expect(stale).toEqual([]);
	});
});
