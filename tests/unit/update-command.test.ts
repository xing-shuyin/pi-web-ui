/**
 * buildUpdateCommand 单测：pi 扩展走 `pi update npm:<name>`（装在
 * <agentDir>/npm），pi-core/webui 走 `npm i -g`；多目标 `;` 连接；空数组。
 */
import { describe, expect, it } from "vitest";
import { buildUpdateCommand } from "../../web/src/update-command.js";

describe("buildUpdateCommand", () => {
	it("package (pi extension) → pi update npm:<name>", () => {
		expect(buildUpdateCommand([{ name: "foo", kind: "package" }])).toBe("pi update npm:foo");
	});

	it("scoped package", () => {
		expect(buildUpdateCommand([{ name: "@scope/bar", kind: "package" }])).toBe("pi update npm:@scope/bar");
	});

	it("pi-core → npm i -g (globally installed)", () => {
		expect(buildUpdateCommand([{ name: "@earendil-works/pi-coding-agent", kind: "pi-core" }])).toBe(
			"npm i -g @earendil-works/pi-coding-agent@latest",
		);
	});

	it("chains multiple targets with `;`", () => {
		expect(
			buildUpdateCommand([
				{ name: "@earendil-works/pi-coding-agent", kind: "pi-core" },
				{ name: "foo", kind: "package" },
				{ name: "pi-x", kind: "package" },
			]),
		).toBe("npm i -g @earendil-works/pi-coding-agent@latest; pi update npm:foo; pi update npm:pi-x");
	});

	it("empty list → empty command", () => {
		expect(buildUpdateCommand([])).toBe("");
	});
});
