import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeFiles, isShim, sourceOf } from "../helpers/guard-roots.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SERVER = join(root, "server");

/** 路径边界不变量（「目标是否落在授权根内」）的唯一判定模块（#972 / #973）。 */
const SINGLE_SOURCE = sourceOf("path-boundary");

/**
 * 存量：还把「`relative()` 看 `..`」当越界判定的模块。这些都是本次 brief 之外的文件（各有归属），
 * **只许变短**：谁再新写一份词法边界实现就会在这里挂掉；迁移完请删掉对应行。
 */
const KNOWN_LEXICAL_DUPLICATES = new Set([
	"server/attachments.ts",
	"server/device-center/bot-memory.ts",
	"server/device-center/desktop-files-fs.ts",
	"server/device-center/execution-workspace.ts",
	"server/device-center/file-sync-paths.ts",
	"server/device-center/workspaces.ts",
	"server/files-service.ts",
	"server/hashline-engine.ts",
	"server/lsp-tool.ts",
	"server/native-cli-references.ts",
	"server/native-cli-remote-files.ts",
	"server/native-cli.ts",
	"server/remote-ssh-service.ts",
	"server/skill-maintenance.ts",
	"server/terminals.ts",
	"server/universal/universal-attachments.ts",
	"server/workspace-handle.ts",
]);

/** 两个源码根（老树 + keel）下的真实现文件，shim 与单源本身除外。 */
function guardSources(): string[] {
	return codeFiles().filter((file) => file !== SINGLE_SOURCE && !isShim(readFileSync(file, "utf8")));
}

/** 登记键统一回老树口径：同一个模块搬进 keel 后不换键，存量名单才不会因搬家而膨大。 */
function legacyId(file: string): string {
	return relative(root, file)
		.split("\\")
		.join("/")
		.replace(/^packages\/keel\/src\//, "server/");
}

/** `relative(...)` 之后紧跟 `startsWith("..")` 的写法，就是第二份「越界判定」。 */
function hasLexicalContainment(source: string): boolean {
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const window = lines.slice(i, i + 5).join("\n");
		if (/relative\(/.test(window) && /startsWith\(\s*[`"']\.\./.test(window)) return true;
	}
	return false;
}

/** 取一个具名函数/方法的声明起点到其后 `limit` 行，用来断言「包装函数只是转发、没有第二套实现」。 */
function definitionWindow(source: string, declaration: string, limit = 6): string {
	const at = source.indexOf(declaration);
	expect(at, `没找到声明：${declaration}`).toBeGreaterThan(-1);
	return source
		.slice(at, at + declaration.length + limit * 200)
		.split("\n")
		.slice(0, limit)
		.join("\n");
}

describe("路径边界判定只有一个单源（server/path-boundary.ts）", () => {
	it("path-boundary.ts 导出全部判定原语", () => {
		const source = readFileSync(SINGLE_SOURCE, "utf8");
		for (const name of ["realPathOrNearest", "isInsideRoots", "assertInsideRoots", "isInsideRootsLexical"]) {
			expect(source, `path-boundary 缺 ${name}`).toContain(`export function ${name}`);
		}
	});

	it("除单源外没有新增「relative + startsWith('..')」形态的越界判定", () => {
		const offenders: string[] = [];
		for (const file of guardSources()) {
			const rel = legacyId(file);
			if (!hasLexicalContainment(readFileSync(file, "utf8"))) continue;
			if (!KNOWN_LEXICAL_DUPLICATES.has(rel)) offenders.push(rel);
		}
		expect(
			offenders,
			`请改调 server/path-boundary.ts（isInsideRoots / realPathOrNearest），不要另写词法边界：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("旧的私有实现名已删光（isPathInsideRoot / assertRealInsideRoot）", () => {
		const offenders: string[] = [];
		for (const file of guardSources()) {
			const source = readFileSync(file, "utf8");
			for (const gone of ["isPathInsideRoot", "assertRealInsideRoot"]) {
				if (source.includes(gone)) offenders.push(`${relative(root, file)} (${gone})`);
			}
		}
		expect(offenders, `这两个私有判定应已删除并改调单源：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("保留的旧导出名只是转发到单源，不再自己解析路径", () => {
		const pluginProject = readFileSync(join(SERVER, "plugin-project.ts"), "utf8");
		expect(definitionWindow(pluginProject, "export function realPathOfNearest")).toContain("realPathOrNearest(");
		expect(definitionWindow(pluginProject, "export function realPathOfNearest")).not.toContain("realpathSync");
		expect(definitionWindow(pluginProject, "export function isInsideRoot(")).toContain("isInsideRoots(");
		expect(definitionWindow(pluginProject, "export function isInsideRoot(")).not.toContain("relative(");

		const plugins = readFileSync(join(SERVER, "plugins.ts"), "utf8");
		expect(definitionWindow(plugins, "isInsideWorkspace(abs: string)")).toContain("isInsideRoots(");
		expect(definitionWindow(plugins, "isInsideWorkspace(abs: string)")).not.toContain("relative(");
		expect(definitionWindow(plugins, "const assertRealInsideGrant = async", 4)).toContain("assertInsideRoots(");
		expect(definitionWindow(plugins, "const assertRealInsideGrant = async", 4)).not.toContain("realPathOfNearest");

		const facilities = readFileSync(join(SERVER, "plugin-facilities.ts"), "utf8");
		expect(definitionWindow(facilities, "private abs(rel: unknown): string {", 5)).toContain("isInsideRoots(");
		expect(facilities).not.toContain("realPathOfNearest");

		const sandbox = readFileSync(join(SERVER, "sandbox-service.ts"), "utf8");
		expect(definitionWindow(sandbox, "export function isStrictlyInsideSandbox", 40)).toContain("realPathOrNearest(");

		const guards = readFileSync(sourceOf("tool-guards"), "utf8");
		const workspaceRoots = definitionWindow(guards, "export function isInsideWorkspaceRoots", 14);
		expect(workspaceRoots).toContain("isInsideRoots(");
		expect(workspaceRoots).toContain("isInsideRootsLexical(");
		expect(workspaceRoots).not.toContain("resolve(");
	});

	it("worktree 切 cwd 前必须过注册校验（#973）", () => {
		const tool = readFileSync(join(SERVER, "worktree-tool.ts"), "utf8");
		const gateCalls = tool.match(/await assertRegisteredWorktree\(/g) ?? [];
		expect(gateCalls.length, "switch 与 create(switchTo) 两条路径都要过注册校验").toBe(2);
		const switchBody = tool.slice(tool.indexOf('case "switch":'), tool.indexOf('case "remove":'));
		expect(switchBody.indexOf("assertRegisteredWorktree(")).toBeGreaterThan(-1);
		expect(switchBody.indexOf("assertRegisteredWorktree(")).toBeLessThan(switchBody.indexOf("host.setCwd("));
		const createBody = tool.slice(tool.indexOf('case "create":'), tool.indexOf('case "switch":'));
		expect(createBody.indexOf("assertRegisteredWorktree(")).toBeGreaterThan(-1);
		expect(createBody.indexOf("assertRegisteredWorktree(")).toBeLessThan(createBody.indexOf("host.setCwd("));
	});
});
