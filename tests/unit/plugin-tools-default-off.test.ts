import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "../../server/client-state.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGINS_DIR = join(ROOT, "plugins");

// 与 validator 保持一致：缺省 false（默认关），只有显式 true 才是默认开。
function isDefaultOn(manifest: Record<string, unknown>): boolean {
	return manifest.agentToolsDefaultOn === true;
}

function readManifest(dir: string): Record<string, unknown> | null {
	const p = join(dir, "manifest.json");
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// 只收 agent 工具：先剔掉 registerCommand 块（/note /todo 这类斜杠命令不是工具），
// 再收剩余 name；变量式定义的工具（legado/tools.mjs 等）单独收。
function scanIndexTools(indexPath: string): string[] {
	let s = readFileSync(indexPath, "utf8");
	s = s.replace(/registerCommand\s*\(\s*\{.*?\}\s*\)/gs, "");
	const out = new Set<string>();
	for (const m of s.matchAll(/name\s*:\s*"([^"]+)"/g)) {
		const n = m[1]!;
		if (/^[a-z][a-z0-9_]{1,}$/.test(n)) out.add(n);
	}
	return [...out];
}

function scanHelperTools(file: string): string[] {
	const s = readFileSync(file, "utf8");
	const out = new Set<string>();
	for (const m of s.matchAll(/name\s*:\s*"([^"]+)"/g)) {
		const n = m[1]!;
		if (/^[a-z][a-z0-9_]{1,}$/.test(n)) out.add(n);
	}
	return [...out];
}

function collectDefaultOffTools(): { pluginId: string; tools: string[] }[] {
	const out: { pluginId: string; tools: string[] }[] = [];
	for (const entry of readdirSync(PLUGINS_DIR)) {
		const dir = join(PLUGINS_DIR, entry);
		if (!statSync(dir).isDirectory()) continue;
		const manifest = readManifest(dir);
		if (!manifest) continue;
		if (isDefaultOn(manifest)) continue;
		const names = new Set<string>();
		const indexPath = join(dir, "index.mjs");
		if (existsSync(indexPath)) for (const n of scanIndexTools(indexPath)) names.add(n);
		for (const helper of [join(dir, "tools.mjs"), join(dir, "server", "tools.mjs")]) {
			if (existsSync(helper)) for (const n of scanHelperTools(helper)) names.add(n);
		}
		if (names.size) out.push({ pluginId: entry, tools: [...names].sort() });
	}
	return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

describe("插件工具默认关（不声明即关）", () => {
	it("默认关插件的全部 agent 工具必须在出厂 disabledPluginTools 名单里", () => {
		const off = new Set(DEFAULT_CLIENT_SETTINGS.disabledPluginTools ?? []);
		const missing: string[] = [];
		for (const { pluginId, tools } of collectDefaultOffTools()) {
			for (const t of tools) {
				if (!off.has(t)) missing.push(`${pluginId}/${t}`);
			}
		}
		expect(
			missing,
			`以下默认关插件工具不在出厂名单里（新用户会默认开启烧 token）。请加入 server/client-state.ts 与 docs/examples/presets/dark-minimal.json，或在 manifest 里显式声明 "agentToolsDefaultOn": true：\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("bili-scroll 显式声明默认关", () => {
		const manifest = readManifest(join(PLUGINS_DIR, "bili-scroll"));
		expect(manifest?.agentToolsDefaultOn).toBe(false);
	});

	it("出厂名单包含本次补齐的默认关工具", () => {
		const off = new Set(DEFAULT_CLIENT_SETTINGS.disabledPluginTools ?? []);
		for (const t of [
			"browser_use",
			"desktop_drag",
			"desktop_scroll",
			"live2d",
			"music_control",
			"quota_status",
			"bili_ask",
			"bili_delivery",
		]) {
			expect(off.has(t), t).toBe(true);
		}
	});
});
