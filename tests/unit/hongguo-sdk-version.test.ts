import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { depRange, depRangeSatisfied } from "../../server/plugin-facilities.js";

const PLUGIN_DIR = join(fileURLToPath(new URL("../..", import.meta.url)), "plugins", "hongguo");

function pluginPkg(): { version: string; dependencies: Record<string, string> } {
	return JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
}

function entrySource(): string {
	return readFileSync(join(PLUGIN_DIR, "index.mjs"), "utf8");
}

describe("hongguo 匿名 SDK 版本（issue #995）", () => {
	it("package.json 声明的是 range，不是钉死的单版本", () => {
		const range = pluginPkg().dependencies.openhongguo;
		expect(range).toBeTruthy();
		expect(range).toMatch(/^[~^]/);
		expect(range).not.toMatch(/^\d/);
	});

	it("range 覆盖 V5 播放取址协议（0.3.1 起的修复）所在的大版本", () => {
		const range = pluginPkg().dependencies.openhongguo;
		expect(depRangeSatisfied("0.4.0", range)).toBe(true);
		// 0.1.0 只有旧接口 video_model/v1，换回它就是这条 issue 复发。
		expect(depRangeSatisfied("0.1.0", range)).toBe(false);
	});

	it("range 不用 caret：宿主把 spec 原样交给 cmd.exe，^ 会被当转义符吃掉", () => {
		expect(pluginPkg().dependencies.openhongguo).not.toContain("^");
	});

	it("ensureDeps 的 spec 与 package.json 单源一致（不另写第二份版本号）", () => {
		const source = entrySource();
		const specs = [...source.matchAll(/openhongguo@([^\s"'\]]+)/g)].map((m) => m[1]);
		expect(specs).toHaveLength(1);
		expect(specs[0]).toBe(pluginPkg().dependencies.openhongguo);
		expect(`${depRange(`openhongguo@${specs[0]}`)}`).toBe(pluginPkg().dependencies.openhongguo);
	});

	it("manifest / catalog 版本一致（改代码必须递增）", () => {
		const version = pluginPkg().version;
		const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")) as { version: string };
		const catalog = JSON.parse(readFileSync(join(PLUGIN_DIR, "..", "catalog.json"), "utf8")) as {
			id: string;
			version: string;
		}[];
		expect(manifest.version).toBe(version);
		expect(catalog.find((entry) => entry.id === "hongguo")?.version).toBe(version);
	});
});
