import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HOST_PROVIDED = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
];

const USED = ["@earendil-works/pi-coding-agent", "typebox"];

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
	packages: Record<
		string,
		{
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			optional?: boolean;
		}
	>;
};

describe("扩展宿主提供包（issue #553）", () => {
	it("dependencies 里不许出现宿主提供的包（pi 扩展加载器只看这个字段）", () => {
		const offenders = Object.keys(manifest.dependencies ?? {}).filter((name) => HOST_PROVIDED.includes(name));
		expect(offenders).toEqual([]);
	});

	it("用到的两个包声明成 peer（`*`）+ optional peer（宿主没装也不报警）", () => {
		for (const name of USED) {
			expect(manifest.peerDependencies?.[name]).toBe("*");
			expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
		}
	});

	it("同时挂在 optionalDependencies 上：npm 默认照装，自带副本（PI_WEB_SDK=bundled）不丢", () => {
		for (const name of USED) {
			expect(manifest.optionalDependencies?.[name]).toBeTruthy();
		}
	});

	it("package-lock 与 package.json 同口径（锁文件不残留旧归属）", () => {
		const root = lock.packages[""];
		expect(root).toBeTruthy();
		for (const name of USED) {
			expect(root.dependencies?.[name]).toBeUndefined();
			expect(root.optionalDependencies?.[name]).toBeTruthy();
		}
		expect(lock.packages["node_modules/typebox"]?.optional).toBe(true);
		expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"]?.optional).toBe(true);
	});
});
