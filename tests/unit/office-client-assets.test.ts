import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Office browser module graph", () => {
	it("keeps every relative module dependency inside the served client directory", () => {
		const root = new URL("../../plugins/office/client/", import.meta.url);
		const visited = new Set<string>();
		function visit(url: URL) {
			expect(url.href.startsWith(root.href), `${url.href} escapes the client route`).toBe(true);
			if (visited.has(url.href)) return;
			visited.add(url.href);
			const source = readFileSync(fileURLToPath(url), "utf8");
			for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
				visit(new URL(match[1], url));
			}
		}
		visit(new URL("entry.mjs", root));
		expect(visited.has(new URL("preview.mjs", root).href)).toBe(true);
	});
});
