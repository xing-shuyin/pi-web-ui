import { expect, it } from "vitest";
import { consoleArguments } from "../../bin/desktop-cli.mjs";

it("checks without modifying sessions unless the exact explicit confirmation is provided", () => {
	expect(consoleArguments(["console"])).toEqual([]);
	expect(consoleArguments(["console", "--check"])).toEqual([]);
	expect(consoleArguments(["console", "--confirm"])).toEqual(["-Apply"]);
	for (const args of [[], ["console", "--yes"], ["console", "1"], ["console", "--confirm", "2"], ["unlock"]])
		expect(() => consoleArguments(args)).toThrow("Usage:");
});
