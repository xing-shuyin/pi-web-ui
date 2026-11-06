import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as nodeResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeReadDirTool,
	prepareReadArguments,
	resolvePathForDirCheck,
	withReadDirSupport,
} from "../../server/read-tool.js";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-read-dir-"));
	mkdirSync(join(root, "nested"));
	writeFileSync(join(root, "b.txt"), "beta\n");
	writeFileSync(join(root, "a.txt"), "alpha\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function readText(
	tool: { execute: (...args: never[]) => Promise<unknown> },
	params: Record<string, unknown>,
	cwd = root,
): Promise<string> {
	const res = (await (tool.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
		"t1",
		params,
		undefined,
		undefined,
		{ cwd },
	)) as { content: { type: string; text?: string }[] };
	return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("resolvePathForDirCheck", () => {
	it("相对路径按 cwd 解析，绝对路径原样，@ 前缀剥掉", () => {
		const cwd = process.cwd();
		expect(resolvePathForDirCheck("server", cwd)).toBe(nodeResolve(cwd, "server"));
		expect(resolvePathForDirCheck(join(cwd, "server"), cwd)).toBe(join(cwd, "server"));
		expect(resolvePathForDirCheck("@server", cwd)).toBe(nodeResolve(cwd, "server"));
	});
});

describe("read 覆盖：目录", () => {
	it("目录 → 头部 + 条目（目录带 / 后缀，排序与 SDK ls 一致）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: "." });
		expect(text).toContain("[Directory: .]");
		expect(text).toContain("nested/");
		expect(text).toContain("a.txt");
		expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("b.txt"));
	});

	it("相对 cwd 的目录路径（ctx.cwd 优先于创建时的 fallbackCwd）", async () => {
		const tool = makeReadDirTool("/definitely/not/here");
		const text = await readText(tool as never, { path: "nested" }, root);
		expect(text).toContain("[Directory: nested]");
		expect(text).toContain("(empty directory)");
	});

	it("目录模式下 limit 是条目上限（并给出 SDK 的续读提示）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: ".", limit: 1 });
		expect(text).toContain("1 entries limit reached");
		expect(text.match(/a\.txt|b\.txt|nested\//g)?.length).toBe(1);
	});

	it("开关关掉 → 交回内置 read（目录报错，不再列目录）", async () => {
		const tool = makeReadDirTool(root, { dirEnabled: () => false });
		await expect(readText(tool as never, { path: "." })).rejects.toThrow();
	});

	it("开关实时读取：同一定义关掉后立刻恢复内置行为", async () => {
		let on = true;
		const tool = makeReadDirTool(root, { dirEnabled: () => on });
		expect(await readText(tool as never, { path: "." })).toContain("[Directory: .]");
		on = false;
		await expect(readText(tool as never, { path: "." })).rejects.toThrow();
	});
});

describe("read 覆盖：file_path 别名", () => {
	it("只给 file_path → 与 path 等价（文件）", async () => {
		const tool = makeReadDirTool(root);
		expect(await readText(tool as never, { file_path: "a.txt" })).toBe("alpha\n");
	});

	it("只给 file_path → 目录也列条目", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { file_path: "." });
		expect(text).toContain("[Directory: .]");
		expect(text).toContain("nested/");
	});

	it("path 与 file_path 都给 → path 优先", async () => {
		const tool = makeReadDirTool(root);
		expect(await readText(tool as never, { path: "a.txt", file_path: "b.txt" })).toBe("alpha\n");
	});

	it("prepareArguments 归一：只有 file_path 时补出 path（schema 里 path 必填）", () => {
		expect(prepareReadArguments({ file_path: "x/y.ts" })).toEqual({ path: "x/y.ts", file_path: "x/y.ts" });
		expect(prepareReadArguments({ path: "a", file_path: "b" })).toEqual({ path: "a", file_path: "b" });
		expect(prepareReadArguments({ path: "   ", file_path: "b" })).toEqual({ path: "b", file_path: "b" });
		expect(prepareReadArguments({ path: "a", offset: 2, limit: 5 })).toEqual({ path: "a", offset: 2, limit: 5 });
		expect(prepareReadArguments(null)).toEqual({});
		expect(prepareReadArguments("nonsense")).toEqual({});
	});

	it("两者都不给 → 抛错（不静默读 cwd）", async () => {
		const tool = makeReadDirTool(root);
		await expect(readText(tool as never, {})).rejects.toThrow();
	});
});

describe("read 覆盖：非目录照旧", () => {
	it("普通文件 → 原样返回内容（不带目录头）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: "a.txt" });
		expect(text).toBe("alpha\n");
		expect(text).not.toContain("[Directory:");
	});

	it("不存在的路径 → 抛错（与内置 read 一致）", async () => {
		const tool = makeReadDirTool(root);
		await expect(readText(tool as never, { path: "nope.txt" })).rejects.toThrow();
	});

	it("中文 UI 语言 → 目录头用中文", async () => {
		const tool = makeReadDirTool(root, { getLang: () => "zh" });
		const text = await readText(tool as never, { path: "." });
		expect(text).toContain("[目录：.]");
	});
});

describe("withReadDirSupport：叠在扩展 read 之上（内置/扩展基底共用的目录能力）", () => {
	function extensionRead(seen: Record<string, unknown>[]): never {
		return {
			name: "read",
			label: "Read",
			description: "EXT-DESC anchor protocol",
			promptSnippet: "ext read",
			promptGuidelines: ["ext guideline"],
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, windows: { type: "array", items: { type: "object" } } },
				required: ["path"],
			},
			async execute(_id: string, params: unknown) {
				seen.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: `EXT:${String((params as { path?: string }).path)}` }] };
			},
		} as never;
	}

	const asBase = (extra: Record<string, unknown> = {}): never =>
		({ ...(extensionRead([]) as unknown as Record<string, unknown>), ...extra }) as never;

	it("基底定义原样保留：schema（扩展独有参数）、描述、prompt 指引、render 槽位", () => {
		const renderCall = (): string => "rc";
		const tool = withReadDirSupport(asBase({ renderCall }), root);
		expect(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
			"path",
			"windows",
		]);
		expect(tool.description.startsWith("EXT-DESC anchor protocol")).toBe(true);
		expect(tool.description).toContain("directory path");
		expect(tool.promptGuidelines).toEqual(["ext guideline", expect.stringContaining("directory")]);
		expect(tool.promptSnippet).toBe("ext read");
		expect((tool as { renderCall?: unknown }).renderCall).toBe(renderCall);
	});

	it("prepareArguments 继承基底（扩展自己的参数归一仍生效）", () => {
		const prepareArguments = (raw: unknown): unknown => ({ ...(raw as object), path: "normalized" });
		const tool = withReadDirSupport(asBase({ prepareArguments }), root);
		expect(tool.prepareArguments?.({ file_path: "x" } as never)).toEqual({ file_path: "x", path: "normalized" });
	});

	it("非目录 → 原样转发基底（我们不改写扩展的参数）", async () => {
		const seen: Record<string, unknown>[] = [];
		const tool = withReadDirSupport(extensionRead(seen), root);
		expect(await readText(tool as never, { path: "a.txt", windows: [{ offset: 1, limit: 2 }] })).toBe("EXT:a.txt");
		expect(seen).toEqual([{ path: "a.txt", windows: [{ offset: 1, limit: 2 }] }]);
	});

	it("目录 → 仍然列条目（pi-web-ui 的能力没丢），且不惊动基底", async () => {
		const seen: Record<string, unknown>[] = [];
		const tool = withReadDirSupport(extensionRead(seen), root);
		const text = await readText(tool as never, { path: "." });
		expect(text).toContain("[Directory: .]");
		expect(text).toContain("nested/");
		expect(seen).toEqual([]);
	});

	it("目录开关关掉 → 交回基底（扩展自己决定目录怎么办）", async () => {
		const seen: Record<string, unknown>[] = [];
		const tool = withReadDirSupport(extensionRead(seen), root, { dirEnabled: () => false });
		expect(await readText(tool as never, { path: "." })).toBe("EXT:.");
		expect(seen).toHaveLength(1);
	});
});
