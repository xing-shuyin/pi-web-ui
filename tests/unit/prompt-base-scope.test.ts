import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = join(ROOT, "server");

function serverSources(dir = SERVER, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) serverSources(full, acc);
		else if (entry.name.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const FORBIDDEN_FIELDS = [/\blastBaseSystemPrompt\b/, /\blastSdkAppendFiles\b/, /\blastSystemPromptBase\b/];

describe("提示词 base 作用域", () => {
	it("server/ 里不再有客户端级的 base 影子字段", () => {
		const offenders: string[] = [];
		for (const file of serverSources()) {
			const text = stripComments(readFileSync(file, "utf8"));
			for (const re of FORBIDDEN_FIELDS) {
				if (re.test(text)) offenders.push(`${file.replace(ROOT, "")} ← ${re.source}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("主会话 override 返回 base / 模板；灵魂槽位与 base 有无无关（issue #999）", () => {
		const store = readFileSync(join(SERVER, "prompt-base-store.ts"), "utf8");
		// 模板 replace 只在 soul handler 里决定，且不得再要求 base 非空。
		expect(store).toMatch(/const candidate = handlers\.soul\?\.\(\);/);
		expect(store).toMatch(/observed\.soul = override \?\? observedBase \?\? "";/);
		expect(store).toMatch(/return override \?\? observedBase;/);
		expect(store).toMatch(/handlers\.append \? handlers\.append\(base\) : base/);
		expect(store).not.toMatch(/base &&/);
	});
});
