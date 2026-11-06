import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableTemplateCommands, expandTemplateCommand } from "../../web/src/template-commands";
import { parseStoredTemplate, registerPromptTemplateRoutes } from "../../server/prompt-templates";

const template = { id: "review", command: "pr", prompt: "Review {{input}}. Target: {{input}}" };

describe("template commands", () => {
	it("replaces every placeholder with literal multiline input", () => {
		expect(expandTemplateCommand("/pr 798\n$& {{input}}", [template])).toBe(
			"Review 798\n$& {{input}}. Target: 798\n$& {{input}}",
		);
	});
	it("supports empty arguments and appends arguments without a placeholder", () => {
		expect(expandTemplateCommand("/PR", [template])).toBe("Review . Target: ");
		expect(expandTemplateCommand("/pr 798", [{ ...template, prompt: "Review" }])).toBe("Review\n\n798");
	});
	it("expands dynamic variables like date, time, and datetime", () => {
		const fixedDate = new Date(2025, 4, 18, 14, 30, 45);
		const timeTpl = {
			id: "log",
			command: "log",
			prompt: "Log [{{date}} {{time}}] ({{datetime}} Y:{{year}}): {{input}}",
		};
		expect(expandTemplateCommand("/log Test note", [timeTpl], fixedDate)).toBe(
			"Log [2025-05-18 14:30:45] (2025-05-18 14:30:45 Y:2025): Test note",
		);
	});
	it("leaves unrelated messages intact and does not recursively expand", () => {
		for (const text of ["/unknown 798", "hello /pr 798", "/pr-extra 798"]) {
			expect(expandTemplateCommand(text, [template])).toBe(text);
		}
		expect(expandTemplateCommand("/pr /pr 799", [template])).toBe("Review /pr 799. Target: /pr 799");
	});
	it("preserves existing commands and suppresses duplicate aliases", () => {
		expect(availableTemplateCommands([template], [{ name: "PR" }])).toEqual([]);
		expect(availableTemplateCommands([template, { ...template, id: "second" }], [])).toEqual([template]);
		expect(availableTemplateCommands([{ ...template, command: "help" }], [])).toEqual([]);
	});
});

describe("stored templates", () => {
	it("persists per-template mutations and imports without overwriting server entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "prompt-templates-"));
		try {
			const handlers: Record<string, Function> = {};
			registerPromptTemplateRoutes(
				{
					get: (_path: string, handler: Function) => {
						handlers.get = handler;
					},
					post: (_path: string, handler: Function) => {
						handlers.post = handler;
					},
				} as any,
				dir,
			);
			let result: any;
			let status = 200;
			const response = {
				json: (data: unknown) => {
					result = data;
				},
				status: (code: number) => {
					status = code;
					return response;
				},
				setHeader: () => {},
			};
			const post = (body: object) => handlers.post({ body, is: () => true, headers: {} }, response);
			post({ action: "upsert", template: { ...template, title: "Review" } });
			post({
				action: "migrate",
				templates: [
					{ ...template, title: "Legacy" },
					{ id: "other", title: "Other", prompt: "Text" },
				],
			});
			expect(result.templates.map((t: any) => t.title)).toEqual(["Review", "Other"]);
			post({ action: "upsert", template: { id: "third", title: "Conflict", prompt: "Text", command: "pr" } });
			expect(status).toBe(400);
			expect(JSON.parse(readFileSync(join(dir, "prompt-templates.json"), "utf8"))).toHaveLength(2);
			post({ action: "remove", id: "review" });
			handlers.get({}, response);
			expect(result.templates.map((t: any) => t.id)).toEqual(["other"]);
			post({ action: "reset" });
			expect(JSON.parse(readFileSync(join(dir, "prompt-templates.json"), "utf8"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("normalizes commands and strips unknown fields", () => {
		expect(parseStoredTemplate({ ...template, title: "Review", command: "/PR", secret: true })).toEqual({
			...template,
			title: "Review",
			command: "pr",
		});
	});
	it("validates imported data and supports builtin removal markers", () => {
		expect(parseStoredTemplate({ id: "review", hidden: true, prompt: "ignored" })).toEqual({
			id: "review",
			hidden: true,
		});
		for (const invalid of [{}, { id: "a", title: "" }, { ...template, title: "Review", command: "pr bad" }]) {
			expect(() => parseStoredTemplate(invalid)).toThrow();
		}
	});
});
