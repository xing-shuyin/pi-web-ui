import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import { describe, expect, it } from "vitest";
import {
	createDispatchSurfaceAdapter,
	DISPATCH_VALUE_MEMBERS,
	type DispatchFunctionMember,
	type DispatchHandler,
	type NonFunctionMember,
} from "../../packages/keel/src/adapters/wire/dispatch-adapter.js";
import {
	createDispatchSurfaceAdapter as createFromBarrel,
	DISPATCH_SURFACE as SURFACE_FROM_BARREL,
} from "../../packages/keel/src/adapters/wire/index.js";
import {
	DISPATCH_OPTIONAL_MEMBERS,
	DISPATCH_SURFACE,
	type DispatchSessionMember,
} from "../../packages/keel/src/adapters/wire/dispatch-surface.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { DispatchSession } from "../../server/engine-service.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const generatorPath = join(root, "scripts", "gen-core-dispatch-surface.mjs");
const surfacePath = join(root, "packages", "keel", "src", "adapters", "wire", "dispatch-surface.ts");
const engineServicePath = join(root, "server", "engine-service.ts");
const generatedHeader = "// 生成物，勿手改：node scripts/gen-core-dispatch-surface.mjs";
const workspace = "D:/ws";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const surfaceCoversInterface: MutuallyAssignable<DispatchSessionMember, keyof DispatchSession> = true;
const functionMembersExcludeValues: MutuallyAssignable<
	DispatchFunctionMember,
	Exclude<keyof DispatchSession, NonFunctionMember>
> = true;
const noValueMemberGap: Record<Exclude<NonFunctionMember, (typeof DISPATCH_VALUE_MEMBERS)[number]>, true> = {};

/** 独立取数：`?` 标记与成员声明都落在单 tab 缩进行，续行是 ≥2 tab，因此不复用生成脚本的括号配平。 */
function scanDeclarations(): { name: string; optional: boolean }[] {
	const lines = readFileSync(engineServicePath, "utf8").split("\n");
	const start = lines.indexOf(["export", "interface", "DispatchSession", "{"].join(" "));
	const end = lines.indexOf("}", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const declarations = new Map<string, boolean>();
	for (const line of lines.slice(start + 1, end)) {
		const match = /^\t(?!\t)(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*[:(<]/.exec(line);
		if (match && !declarations.has(match[1])) declarations.set(match[1], Boolean(match[2]));
	}
	return [...declarations].map(([name, optional]) => ({ name, optional }));
}

function functionMembers(): DispatchSessionMember[] {
	const valueMembers = new Set<string>(DISPATCH_VALUE_MEMBERS);
	return DISPATCH_SURFACE.filter((member) => !valueMembers.has(member));
}

function callable(adapter: DispatchSession, member: DispatchSessionMember): (...args: never[]) => unknown {
	return adapter[member] as unknown as (...args: never[]) => unknown;
}

function catchThrown(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("预期抛出 CoreEngineNotReadyError，实际没有抛");
}

function runCheck(): { status: number; stdout: string } {
	try {
		const stdout = execFileSync(process.execPath, [generatorPath, "--check"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "" };
	}
}

describe("dispatch-surface 生成物", () => {
	it("成员集合与 DispatchSession 完全一致（keyof 双向相等 + 源码计数）", () => {
		expect(surfaceCoversInterface).toBe(true);
		const declarations = scanDeclarations();
		expect(DISPATCH_SURFACE.length).toBe(declarations.length);
		expect(DISPATCH_SURFACE.length).toBeGreaterThan(100);
		expect([...DISPATCH_SURFACE]).toEqual(declarations.map((declaration) => declaration.name));
	});

	it("可选成员与源码的 ? 标记逐一对应", () => {
		const expected = scanDeclarations()
			.filter((declaration) => declaration.optional)
			.map((declaration) => declaration.name);
		expect([...DISPATCH_OPTIONAL_MEMBERS]).toEqual(expected);
	});

	it("成员不重复：接口里重复声明的 forkSession 只保留首个", () => {
		expect(DISPATCH_SURFACE.length).toBe(new Set(DISPATCH_SURFACE).size);
		expect(DISPATCH_SURFACE.filter((member) => member === "forkSession")).toHaveLength(1);
		expect(DISPATCH_OPTIONAL_MEMBERS.every((member) => DISPATCH_SURFACE.includes(member))).toBe(true);
	});

	it("首行是勿手改标记，行数在新树 600 行上限内", () => {
		const lines = readFileSync(surfacePath, "utf8").split("\n");
		expect(lines[0]).toBe(generatedHeader);
		expect(lines.length).toBeLessThanOrEqual(600);
	});

	it("node scripts/gen-core-dispatch-surface.mjs --check 通过（退出码 0）", () => {
		const check = runCheck();
		expect(check.stdout).toContain("dispatch-surface.ts");
		expect(check.status).toBe(0);
	});
});

describe("dispatch-adapter", () => {
	it("未提供 handler 的成员调用即抛 CoreEngineNotReadyError，消息含成员名", () => {
		const adapter = createDispatchSurfaceAdapter({ cwd: workspace });
		for (const member of ["prompt", "newChat", "setCwd", "listModels"] as const) {
			const thrown = catchThrown(() => callable(adapter, member)());
			expect(thrown).toBeInstanceOf(CoreEngineNotReadyError);
			expect(thrown.message).toContain(member);
		}
	});

	it("每个未实现的函数成员都 fail-closed，且报错各自带自己的名字", () => {
		const adapter = createDispatchSurfaceAdapter({ cwd: workspace });
		const members = functionMembers();
		expect(members.length).toBe(DISPATCH_SURFACE.length - DISPATCH_VALUE_MEMBERS.length);
		for (const member of members) {
			const fn = callable(adapter, member);
			expect(typeof fn).toBe("function");
			const thrown = catchThrown(() => fn());
			expect(thrown).toBeInstanceOf(CoreEngineNotReadyError);
			expect(thrown.message).toContain(member);
		}
	});

	it("handlers 里提供的成员直接透传：同一引用、原参数、原返回值", () => {
		const prompt: DispatchHandler = (...args) => `prompt:${args.join(",")}`;
		const adapter = createDispatchSurfaceAdapter({ cwd: workspace, prompt });
		expect(adapter.prompt).toBe(prompt);
		const result = (adapter.prompt as unknown as (...args: string[]) => string)("hi", "att");
		expect(result).toBe("prompt:hi,att");
	});

	it("已提供的成员照常工作，未提供的成员仍然 fail-closed", () => {
		const adapter = createDispatchSurfaceAdapter({ cwd: workspace, abort: () => "aborted" });
		expect((adapter.abort as unknown as () => string)()).toBe("aborted");
		const thrown = catchThrown(() => callable(adapter, "retryLast")());
		expect(thrown).toBeInstanceOf(CoreEngineNotReadyError);
		expect(thrown.message).toContain("retryLast");
	});

	it("cwd / workspaceRoots 是显式必需项，不走「调用即抛」", () => {
		expect(noValueMemberGap).toEqual({});
		expect([...DISPATCH_VALUE_MEMBERS]).toEqual(["cwd", "workspaceRoots"]);
		expect(functionMembersExcludeValues).toBe(true);
		const full = createDispatchSurfaceAdapter({ cwd: workspace, workspaceRoots: ["a", "b"] });
		expect(full.cwd).toBe(workspace);
		expect(full.workspaceRoots).toEqual(["a", "b"]);
		const bare = createDispatchSurfaceAdapter({ cwd: workspace });
		expect(bare.cwd).toBe(workspace);
		expect(bare.workspaceRoots).toBeUndefined();
	});

	it("适配器不是 Proxy，函数成员都是静态可枚举的普通函数", () => {
		const adapter = createDispatchSurfaceAdapter({ cwd: workspace });
		expect(isProxy(adapter)).toBe(false);
		const keys = new Set(Object.keys(adapter));
		for (const member of functionMembers()) expect(keys.has(member)).toBe(true);
	});

	it("wire barrel 导出同一份 surface 与同一个工厂", () => {
		expect(SURFACE_FROM_BARREL).toBe(DISPATCH_SURFACE);
		expect(createFromBarrel).toBe(createDispatchSurfaceAdapter);
	});
});
