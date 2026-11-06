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

	it("git-extension → pi update git:<host/path> (issue #178)", () => {
		expect(buildUpdateCommand([{ name: "sol-pi", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi" }])).toBe(
			"pi update git:github.com/NVlabs/SoL-Pi",
		);
	});

	it("git-extension source with git: prefix is not doubled", () => {
		expect(
			buildUpdateCommand([{ name: "sol-pi", kind: "git-extension", source: "git:github.com/NVlabs/SoL-Pi" }]),
		).toBe("pi update git:github.com/NVlabs/SoL-Pi");
	});

	it("git-extension without source falls back to name", () => {
		expect(buildUpdateCommand([{ name: "github.com/acme/widgets", kind: "git-extension" }])).toBe(
			"pi update git:github.com/acme/widgets",
		);
	});

	it("plugin (UI plugin) → pi-web-ui install <source> --name <id> --force", () => {
		expect(
			buildUpdateCommand([
				{
					name: "webmail",
					kind: "plugin",
					source: "xing-shuyin/pi-web-ui/plugins/webmail",
					pluginId: "webmail",
				},
			]),
		).toBe("pi-web-ui install xing-shuyin/pi-web-ui/plugins/webmail --name webmail --force");
	});

	it("chains mixed npm + git targets with `;`", () => {
		expect(
			buildUpdateCommand([
				{ name: "foo", kind: "package" },
				{ name: "sol-pi", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi" },
			]),
		).toBe("pi update npm:foo; pi update git:github.com/NVlabs/SoL-Pi");
	});
});
