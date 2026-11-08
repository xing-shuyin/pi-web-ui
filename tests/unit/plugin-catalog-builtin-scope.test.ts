import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const IN_TREE_SOURCE = /^xing-shuyin\/pi-web-ui\/plugins\/([A-Za-z0-9_-]+)$/;

type Entry = { id?: unknown; source?: unknown; preinstall?: unknown };

const catalog = JSON.parse(readFileSync(join(ROOT, "plugins", "catalog.json"), "utf8")) as Entry[];

const labels = (entries: Entry[]): string[] => entries.map((e) => `${String(e.id)} -> ${String(e.source)}`);

describe("插件市场 builtin 清单只收本仓库自带的插件", () => {
	it("每条 source 都指向本仓库 plugins/<id>（第三方插件登记到社区清单仓库）", () => {
		const offenders = catalog.filter((e) => {
			const match = IN_TREE_SOURCE.exec(String(e.source ?? ""));
			return !match || match[1] !== e.id;
		});
		expect(labels(offenders)).toEqual([]);
	});

	it("每条都能在本仓库 plugins/<id>/manifest.json 找到本体（清单不引用未随包发布的插件）", () => {
		const missing = catalog.filter(
			(e) => typeof e.id === "string" && !existsSync(join(ROOT, "plugins", e.id, "manifest.json")),
		);
		expect(missing.map((e) => String(e.id))).toEqual([]);
	});

	it("id 唯一", () => {
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const e of catalog) {
			const id = String(e.id ?? "");
			if (seen.has(id)) dupes.push(id);
			seen.add(id);
		}
		expect(dupes).toEqual([]);
	});
});
