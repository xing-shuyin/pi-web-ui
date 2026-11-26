/**
 * 引擎契约单源守卫（细则见 `docs/dsh-engine.md`「引擎分发」与 `docs/architecture-core.md`）。
 *
 * 判据三条：
 *   1. `DispatchSession` / `EngineService` / `TerminalManagerLike` 只声明在 `server/engine-service.ts`。
 *   2. 任何模块都不许再从 `server/index.ts` 取这三个契约——入口是装配代码，被服务模块当类型库
 *      import 会多出一条「服务 → 入口」的边，入口再 import 服务就成环，改动谁也说不清影响面。
 *   3. 五个引擎（pi / dsh / claude / codex / durable）都必须显式 `implements EngineService`，
 *      靠 `activeEngines()` 的数组赋值做隐式检查时，失败信息只指向装配处，看不出是哪个引擎掉了。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceOf } from "../helpers/guard-roots.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 契约唯一声明处（搬家前后由 sourceOf 解析）。 */
const CONTRACT = sourceOf("engine-service");
/** 打印用：相对仓库根（与扫描得到的 id 同一坐标系）。 */
const CONTRACT_ID = relative(ROOT, CONTRACT).split("\\").join("/");
const MOVED = ["DispatchSession", "EngineService", "TerminalManagerLike"];
const SKIP = new Set(["node_modules", ".git", "dist", "release", "artifacts", "vendor", "build"]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) walk(path, out);
		else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(path);
	}
	return out;
}

const sources = ["server", "packages/keel/src", "web", "desktop", "browser", "extensions", "tests"].flatMap((dir) =>
	walk(dir),
);
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("引擎契约单源", () => {
	it(`契约只声明在 ${CONTRACT_ID}`, () => {
		const contract = readFileSync(CONTRACT, "utf8");
		for (const name of MOVED) {
			expect(contract, name).toContain(`export interface ${name} {`);
			const declarers = sources.filter((path) => new RegExp(`export interface ${name} \\{`).test(read(path)));
			expect(declarers, name).toEqual([CONTRACT_ID]);
		}
	});

	it("没有任何模块再从 index.ts 取这三个契约", () => {
		const offenders: string[] = [];
		for (const path of sources) {
			for (const match of read(path).matchAll(/import (?:type )?\{([^}]*)\} from "[^"]*index\.js";/g)) {
				if (MOVED.some((name) => new RegExp(`\\b${name}\\b`).test(match[1]) && path !== CONTRACT_ID)) {
					offenders.push(path);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("所有引擎都显式 implements EngineService", () => {
		const engines: [string, string][] = [
			["pi", "packages/keel/src/app/core-engine.ts"],
			["dsh", "server/dsh/dsh-agent-service.ts"],
			["claude/codex", "server/universal/universal-service.ts"],
			["durable", "server/durable/durable-agent-service.ts"],
		];
		for (const [engine, path] of engines) {
			expect(read(path), engine).toMatch(/^export class \w+ implements EngineService\b/m);
		}
	});
});
