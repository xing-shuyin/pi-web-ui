import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_PLANE_DISABLE_IDS,
	PRESET_DEFAULT_ID,
	buildPresetPlanePatch,
	generatePresetClones,
	resolvePackageEntryFileUrl,
	rewriteBareNames,
} from "../../server/dsh/preset-clones";

describe("resolvePackageEntryFileUrl", () => {
	const mkScope = () => {
		const root = mkdtempSync(join(tmpdir(), "preset-scope-"));
		const scope = join(root, "node_modules", "@deepseek-ai");
		const pkg = (name: string, manifest: unknown, files: string[]) => {
			mkdirSync(join(scope, name, "lib"), { recursive: true });
			writeFileSync(join(scope, name, "package.json"), JSON.stringify(manifest));
			for (const f of files) writeFileSync(join(scope, name, f), "// entry\n");
		};
		pkg("dsh-persona", { main: "lib/index.js", exports: { ".": "./lib/index.js" } }, ["lib/index.js"]);
		pkg("dsh-tool-subagent-control", { exports: { ".": "./lib/index.js", "./list-agents": "./lib/list-agents.js" } }, [
			"lib/index.js",
			"lib/list-agents.js",
		]);
		return { root, scope };
	};
	it("主入口走 exports→main；子路径走 exports 子项", () => {
		const { root, scope } = mkScope();
		try {
			const main = resolvePackageEntryFileUrl(scope, "@deepseek-ai/dsh-persona");
			expect(main).toContain("dsh-persona/lib/index.js");
			const sub = resolvePackageEntryFileUrl(scope, "@deepseek-ai/dsh-tool-subagent-control/list-agents");
			expect(sub).toContain("dsh-tool-subagent-control/lib/list-agents.js");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("缺包/缺文件 → null", () => {
		const { root, scope } = mkScope();
		try {
			expect(resolvePackageEntryFileUrl(scope, "@deepseek-ai/nope")).toBeNull();
			expect(resolvePackageEntryFileUrl(scope, "not-a-package")).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("rewriteBareNames", () => {
	const toFile = (bare: string) => `file:///rt/${bare.slice("@deepseek-ai/".length)}/lib/index.js`;
	it("改写单/双引号裸包名", () => {
		const src = "- id: a\n  name: '@deepseek-ai/dsh-persona'\n- id: b\n  name: \"@deepseek-ai/dsh-tool-bash\"\n";
		const { text: out, unresolved } = rewriteBareNames(src, toFile);
		expect(unresolved).toEqual([]);
		expect(out).toContain(`name: 'file:///rt/dsh-persona/lib/index.js'`);
		expect(out).toContain(`name: "file:///rt/dsh-tool-bash/lib/index.js"`);
		expect(out).not.toContain("'@deepseek-ai/dsh-persona'");
	});
	it("解析失败的行保留原文并记 unresolved", () => {
		const { text, unresolved } = rewriteBareNames("  name: '@deepseek-ai/dsh-nope'\n", () => null);
		expect(text).toContain("'@deepseek-ai/dsh-nope'");
		expect(unresolved).toEqual(["@deepseek-ai/dsh-nope"]);
	});
	it("不动 cordis:group、相对路径与 !!js", () => {
		const src = [
			"- id: g",
			"  name: cordis:group",
			"- id: r",
			"  name: ./refuses.mjs",
			"  disabled: !!js process.platform === 'win32'",
			'  shell: !!js "@deepseek-ai/not-a-name"',
		].join("\n");
		expect(rewriteBareNames(src, toFile).text).toBe(src);
	});
	it("行尾注释保留", () => {
		const { text: out } = rewriteBareNames("  name: '@deepseek-ai/dsh-agent' # 注释", toFile);
		expect(out).toBe(`  name: 'file:///rt/dsh-agent/lib/index.js' # 注释`);
	});
});

describe("buildPresetPlanePatch", () => {
	it("含 disable 全表 + roster（shipped 关、clone system 根）", () => {
		const p = buildPresetPlanePatch("C:\\data\\dsh-preset-clones");
		for (const id of AGENT_PLANE_DISABLE_IDS) expect(p).toContain(`- id: ${id}\n  disabled: true`);
		expect(p).toContain("id: agent-presets");
		expect(p).toContain(`default: ${PRESET_DEFAULT_ID}`);
		expect(p).toContain("includeShippedRoot: false");
		expect(p).toContain(JSON.stringify("C:\\data\\dsh-preset-clones"));
		expect(p).toContain("trust: system");
	});
});

describe("generatePresetClones (fixture)", () => {
	const mkFixture = () => {
		const root = mkdtempSync(join(tmpdir(), "preset-clones-"));
		const scope = join(root, "node_modules", "@deepseek-ai");
		const shipped = join(scope, "dsh-agent-presets", "presets");
		mkdirSync(join(scope, "dsh-persona", "lib"), { recursive: true });
		writeFileSync(join(scope, "dsh-persona", "package.json"), JSON.stringify({ main: "lib/index.js" }));
		writeFileSync(join(scope, "dsh-persona", "lib", "index.js"), "// entry\n");
		for (const id of ["standard", "minimal"]) {
			mkdirSync(join(shipped, id, "skills", "demo"), { recursive: true });
			writeFileSync(
				join(shipped, id, "agent.cordis.yml"),
				`- id: persona\n  name: '@deepseek-ai/dsh-persona'\n- id: g\n  name: cordis:group\n`,
			);
			writeFileSync(join(shipped, id, "preset.yml"), `name: ${id}\norder: 1\n`);
			writeFileSync(join(shipped, id, "skills", "demo", "SKILL.md"), "# demo\n");
		}
		mkdirSync(join(shipped, "empty"));
		return { root, shipped, dataDir: join(root, "data") };
	};
	it("拷贝+改写+写 patch；相对行与 skills 原样保留", () => {
		const { shipped, dataDir, root } = mkFixture();
		try {
			const res = generatePresetClones(dataDir, shipped);
			expect(res).not.toBeNull();
			expect(res!.presetIds).toEqual(["minimal", "standard"]);
			const comp = readFileSync(join(res!.clonesDir, "standard", "agent.cordis.yml"), "utf8");
			expect(comp).toContain("dsh-persona/lib/index.js'");
			expect(comp).not.toContain("'@deepseek-ai/");
			expect(res!.warnings).toEqual([]);
			expect(comp).toContain("name: cordis:group");
			expect(readFileSync(join(res!.clonesDir, "standard", "preset.yml"), "utf8")).toContain("name: standard");
			expect(readFileSync(join(res!.clonesDir, "standard", "skills", "demo", "SKILL.md"), "utf8")).toContain("# demo");
			const patch = readFileSync(res!.patchFile, "utf8");
			expect(patch).toContain("id: agent-presets");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("缺 default 预设 / 源目录缺失 → null（调用方回落 legacy）", () => {
		const { shipped, dataDir, root } = mkFixture();
		try {
			rmSync(join(shipped, "standard"), { recursive: true, force: true });
			expect(generatePresetClones(dataDir, shipped)).toBeNull();
			expect(generatePresetClones(dataDir, join(root, "nope"))).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
