import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRESET_DEFAULT_ID = "standard";

export const PRESET_CLONES_DIRNAME = "dsh-preset-clones";

export const PRESET_PLANE_PATCH_FILENAME = "dsh-preset-plane.patch.yml";

export interface PresetCloneResult {
	clonesDir: string;
	patchFile: string;
	presetIds: string[];
	warnings: string[];
}

export function runtimeBaseCandidates(): string[] {
	const out: string[] = [];
	const explicit = process.env.PI_WEB_DSH_RUNTIME;
	if (explicit) out.push(resolve(explicit));
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		const nm = join(dir, "node_modules");
		if (existsSync(nm)) {
			out.push(resolve(nm));
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	out.push(join(dirname(process.execPath), "node_modules"));
	try {
		const prefixes = [
			process.env.NPM_CONFIG_PREFIX,
			process.env.npm_config_prefix,
			join(dirname(process.execPath), ".."),
		];
		for (const prefix of prefixes) {
			if (!prefix) continue;
			out.push(join(prefix, "lib", "node_modules"));
			out.push(join(prefix, "node_modules"));
		}
	} catch {}
	return [...new Set(out)];
}

function runtimeBaseFor(root: string): string | null {
	const flat = join(root, "@deepseek-ai");
	if (
		existsSync(join(flat, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(flat, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(root);
	}
	const nested = join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
	if (
		existsSync(join(nested, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(nested, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(join(root, "@deepseek-ai", "dsh", "node_modules"));
	}
	return null;
}

export function findShippedPresetsDir(): string | null {
	for (const root of runtimeBaseCandidates()) {
		const base = runtimeBaseFor(root);
		if (!base) continue;
		const dir = join(base, "@deepseek-ai", "dsh-agent-presets", "presets");
		if (existsSync(join(dir, "standard", "agent.cordis.yml"))) return dir;
	}
	return null;
}

export function resolvePackageEntryFileUrl(scopeDir: string, bare: string): string | null {
	const parts = bare.split("/");
	if (parts.length < 2 || !parts[0].startsWith("@") || !parts[1]) return null;
	const pkg = parts[1];
	const sub = parts.length > 2 ? parts.slice(2).join("/") : undefined;
	const pkgDir = join(scopeDir, pkg);
	let manifest: { main?: unknown; exports?: unknown } = {};
	try {
		manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as typeof manifest;
	} catch {
		return null;
	}
	const pickDefault = (v: unknown): string | null => {
		if (typeof v === "string") return v;
		if (v && typeof v === "object" && typeof (v as Record<string, unknown>).default === "string") {
			return (v as Record<string, string>).default;
		}
		return null;
	};
	const candidates: string[] = [];
	const exportsMap =
		manifest.exports && typeof manifest.exports === "object" ? (manifest.exports as Record<string, unknown>) : null;
	if (sub) {
		const hit = exportsMap?.[`./${sub}`];
		const mapped = pickDefault(hit);
		if (mapped) candidates.push(mapped);
		candidates.push(join("lib", `${sub}.js`), join("lib", sub, "index.js"));
	} else {
		const mapped = pickDefault(exportsMap?.["."]);
		if (mapped) candidates.push(mapped);
		if (typeof manifest.main === "string" && manifest.main) candidates.push(manifest.main);
		candidates.push(join("lib", "index.js"));
	}
	for (const rel of candidates) {
		const abs = resolve(pkgDir, rel);
		if (existsSync(abs)) return pathToFileURL(abs).href;
	}
	return null;
}

export interface RewriteResult {
	text: string;
	unresolved: string[];
}

export function rewriteBareNames(yamlText: string, resolve: (bare: string) => string | null): RewriteResult {
	const unresolved = new Set<string>();
	const text = yamlText.replace(
		/^([ \t]*name:[ \t]*)(['"])@deepseek-ai\/([^'"\s]+)\2([ \t]*(?:#.*)?)$/gim,
		(_m, prefix: string, quote: string, rest: string, suffix: string) => {
			const url = resolve(`@deepseek-ai/${rest}`);
			if (!url) {
				unresolved.add(`@deepseek-ai/${rest}`);
				return _m;
			}
			return `${prefix}${quote}${url}${quote}${suffix}`;
		},
	);
	return { text, unresolved: [...unresolved] };
}

export const AGENT_PLANE_DISABLE_IDS = [
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"tool-str-replace-editor",
	"skill-filesystem",
	"tool-skill",
	"command-goal",
	"tool-goal",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-result-pruner",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-worker-thread",
	"tool-workflow",
	"tool-ralph",
	"agent-instructions",
	"tool-todo",
	"tool-web",
] as const;

export function buildPresetPlanePatch(clonesDir: string): string {
	const disables = AGENT_PLANE_DISABLE_IDS.map((id) => `- id: ${id}\n  disabled: true`).join("\n");
	return (
		`# 由 server/dsh/preset-clones.ts 生成（每次 DSH 运行时启动前重写），勿手改。\n` +
		`# agent plane 下沉到预设：与官方 dsh-web-app/cordis.patch.yml 同表。\n` +
		`${disables}\n\n` +
		`# preset roster：clone 目录是唯一 system 根（同名 id 早根优先，shipped 原件被遮蔽）；\n` +
		`# user 根保留（自建预设照常上架；裸包名在 launcher boot 下不可解析是已知限制，见文档）。\n` +
		`- insert:\n` +
		`    - id: agent-presets\n` +
		`      name: '@deepseek-ai/dsh-agent-presets'\n` +
		`      config:\n` +
		`        default: ${PRESET_DEFAULT_ID}\n` +
		`        includeShippedRoot: false\n` +
		`        roots:\n` +
		`          - path: ${JSON.stringify(clonesDir)}\n` +
		`            trust: system\n`
	);
}

export function generatePresetClones(dataDir: string, shippedDir?: string): PresetCloneResult | null {
	const src = shippedDir ?? findShippedPresetsDir();
	if (!src) return null;
	let ids: string[];
	try {
		ids = readdirSync(src, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
			.map((e) => e.name)
			.filter((id) => existsSync(join(src, id, "agent.cordis.yml")))
			.sort();
	} catch {
		return null;
	}
	if (!ids.includes(PRESET_DEFAULT_ID)) return null;
	const clonesDir = join(dataDir, PRESET_CLONES_DIRNAME);
	rmSync(clonesDir, { recursive: true, force: true });
	mkdirSync(clonesDir, { recursive: true });
	const scopeDir = join(src, "..", "..");
	const warnings: string[] = [];
	try {
		for (const id of ids) {
			const dst = join(clonesDir, id);
			cpSync(join(src, id), dst, { recursive: true });
			const compFile = join(dst, "agent.cordis.yml");
			const raw = readFileSync(compFile, "utf8");
			const { text, unresolved } = rewriteBareNames(raw, (bare) => resolvePackageEntryFileUrl(scopeDir, bare));
			for (const u of unresolved) warnings.push(`${id}: ${u}`);
			writeFileSync(compFile, text);
		}
	} catch {
		rmSync(clonesDir, { recursive: true, force: true });
		return null;
	}
	const patchFile = join(dataDir, PRESET_PLANE_PATCH_FILENAME);
	writeFileSync(patchFile, buildPresetPlanePatch(clonesDir));
	return { clonesDir, patchFile, presetIds: ids, warnings };
}
