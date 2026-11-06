import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pluginsDir = join(__dirname, "..", "..", "plugins");

function manifests(): { id: string; json: Record<string, unknown> }[] {
	return readdirSync(pluginsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(pluginsDir, e.name, "manifest.json"))
		.filter((p) => {
			try {
				readFileSync(p, "utf8");
				return true;
			} catch {
				return false;
			}
		})
		.map((p) => ({ id: p.split(/[/\\]/).slice(-2, -1)[0]!, json: JSON.parse(readFileSync(p, "utf8")) }));
}

describe("plugin manifest icons", () => {
	it("每个插件 manifest 都有非空顶层 icon", () => {
		const list = manifests();
		expect(list.length).toBeGreaterThan(0);
		for (const { id, json } of list) {
			expect(typeof json.icon, `${id}.icon`).toBe("string");
			expect((json.icon as string).trim().length, `${id}.icon`).toBeGreaterThan(0);
		}
	});

	it("市场目录里的插件：manifest 图标与目录一致", () => {
		const catalog = JSON.parse(readFileSync(join(pluginsDir, "catalog.json"), "utf8")) as {
			id: string;
			icon?: string;
		}[];
		const byId = new Map(manifests().map((m) => [(m.json.id as string) ?? m.id, m.json]));
		let checked = 0;
		for (const entry of catalog) {
			const m = byId.get(entry.id);
			if (!m || !entry.icon) continue;
			expect(m.icon, `${entry.id}.icon`).toBe(entry.icon);
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("所有内置业务插件均已在 catalog.json 市场清单中收录", () => {
		const catalog = JSON.parse(readFileSync(join(pluginsDir, "catalog.json"), "utf8")) as { id: string }[];
		const catalogIds = new Set(catalog.map((e) => e.id));
		const EXEMPTIONS = new Set(["demo-mailbox"]);

		const list = manifests();
		for (const { id } of list) {
			if (EXEMPTIONS.has(id)) continue;
			expect(catalogIds.has(id), `内置插件 plugins/${id} 必须在 plugins/catalog.json 中登记上架`).toBe(true);
		}
	});
});
