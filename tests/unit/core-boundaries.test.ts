import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const coreDir = join(root, "server", "core");

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

/** 只允许这些路径碰 SDK 与喂轮出口；其余层只认 `contracts/session.ts` 的窄面。 */
const SDK_BOUNDARY = [
	"server/core/domains/turns/feed.ts",
	"server/core/adapters/sdk/",
	"server/core/adapters/models/",
	"server/core/adapters/tools/",
];

function inSdkBoundary(rel: string): boolean {
	return SDK_BOUNDARY.some((prefix) => rel === prefix || rel.startsWith(prefix));
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
	return parts[0] === "server" && parts[1] === "core" && LAYERS.includes(parts[2] as Layer)
		? (parts[2] as Layer)
		: undefined;
}

function domainOf(rel: string): string | undefined {
	const parts = rel.split("/");
	return parts[2] === "domains" && parts.length > 4 ? parts[3] : undefined;
}

const files = walk(coreDir).map((file) => ({ abs: file, rel: relative(root, file).split(sep).join("/") }));

const ALLOWED_EDGES: Record<Layer, readonly Layer[]> = {
	contracts: ["contracts"],
	kernel: ["contracts", "kernel"],
	domains: ["contracts", "kernel", "domains"],
	adapters: ["contracts", "kernel", "adapters"],
	app: ["contracts", "kernel", "domains", "adapters", "app"],
};

describe("server/core 分层边界", () => {
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
			if (inSdkBoundary(file.rel)) continue;
			const text = readFileSync(file.abs, "utf8");
			if (/@earendil-works\/pi-coding-agent/.test(text)) violations.push(`${file.rel}（直接依赖 SDK）`);
			if (/session-turns\.js/.test(text)) violations.push(`${file.rel}（直接依赖喂轮出口）`);
		}
		expect(violations).toEqual([]);
	});

	it("单个文件不超过 600 行（新树不许再长出巨型模块）", () => {
		const big = files
			.map((f) => ({ rel: f.rel, lines: readFileSync(f.abs, "utf8").split("\n").length }))
			.filter((f) => f.lines > MAX_CORE_FILE_LINES)
			.map((f) => `${f.rel}: ${f.lines}`);
		expect(big).toEqual([]);
	});
});
