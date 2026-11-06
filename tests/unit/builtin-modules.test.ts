import { describe, expect, it } from "vitest";
import { excludeBuiltinModules, isBuiltinModule } from "../../server/builtin-modules";
import { withPluginViewItems } from "../../web/src/ui-slots";

describe("host-owned module classification", () => {
	it("does not let a plugin claim host ownership through manifest metadata", () => {
		const plugins = [{ id: "superagent" }, { id: "github-workbench", builtin: true }];
		expect(isBuiltinModule("superagent")).toBe(true);
		expect(excludeBuiltinModules(plugins)).toEqual([plugins[1]]);
		expect(plugins).toHaveLength(2);
	});
	it("prevents legacy built-in module declarations from generating plugin tabs or layout entries", () => {
		const entries = withPluginViewItems([
			{
				id: "superagent",
				name: "Superagent",
				hasClient: true,
				view: true,
				ui: {
					arrange: [],
					items: [
						{ id: "old-open", slot: "topbar.primary", label: "Superagent", kind: "view", view: "plugin:superagent" },
					],
				},
			},
			{ id: "github-workbench", name: "GitHub", hasClient: true },
		]);
		expect(entries.map((entry) => entry.id)).toEqual(["github-workbench"]);
		expect(entries[0].ui?.items.some((item) => item.view === "plugin:github-workbench")).toBe(true);
	});
});
