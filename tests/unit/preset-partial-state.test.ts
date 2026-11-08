import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore, type SettingsPreset } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

const normalizedFields = [
	"reviewPrompt",
	"reviewDisabledSkills",
	"retryMaxAttempts",
	"softCapTokens",
	"softCapByModel",
	"subagentAutoWakeMaxTurns",
] as const;

describe("ClientStateStore partial preset persistence", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-preset-partial-state-"));
		file = join(dir, "client-state.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not add absent settings when loading and saving a prompt-only preset", () => {
		const preset: SettingsPreset = { name: "prompt only", customSystemPrompt: "Keep answers concise." };
		new ClientStateStore(file).savePresets("writer", [preset]);

		const reopened = new ClientStateStore(file);
		const loaded = reopened.getPresets("reader");
		expect(loaded).toEqual([preset]);
		for (const key of normalizedFields) expect(Object.hasOwn(loaded[0], key)).toBe(false);

		reopened.savePresets("reader", loaded);
		expect(new ClientStateStore(file).getPresets("another reader")).toEqual([preset]);
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		expect(persisted.__settings__.presets).toEqual([preset]);
	});

	it("normalizes only fields actually present in persisted presets", () => {
		const values = {
			reviewPrompt: { input: null, output: "" },
			reviewDisabledSkills: { input: null, output: [] },
			retryMaxAttempts: { input: "123.9", output: 100 },
			softCapTokens: { input: "300k", output: 300_000 },
			softCapByModel: {
				input: { " provider/model ": "1.5m", disabled: 0 },
				output: { "provider/model": 1_500_000 },
			},
			subagentAutoWakeMaxTurns: { input: "8.9", output: 8 },
		};
		writeFileSync(
			file,
			JSON.stringify({
				__settings__: {
					projects: [],
					presets: normalizedFields.map((key) => ({ name: key, [key]: values[key].input })),
				},
			}),
		);

		const store = new ClientStateStore(file);
		const loaded = store.getPresets("reader");
		const expected = normalizedFields.map((key) => ({ name: key, [key]: values[key].output }));
		expect(loaded).toEqual(expected);
		for (const [index, key] of normalizedFields.entries()) {
			for (const field of normalizedFields) expect(Object.hasOwn(loaded[index], field)).toBe(field === key);
		}
		store.savePresets("reader", loaded);
		expect(new ClientStateStore(file).getPresets("reader")).toEqual(expected);
	});

	it("preserves explicit empty and disabled settings across a file round trip", () => {
		const preset: SettingsPreset = {
			name: "explicit resets",
			reviewPrompt: "",
			reviewDisabledSkills: [],
			retryMaxAttempts: 0,
			softCapTokens: 0,
			softCapByModel: {},
			subagentAutoWakeMaxTurns: 0,
		};
		new ClientStateStore(file).savePresets("writer", [preset]);
		expect(new ClientStateStore(file).getPresets("reader")).toEqual([preset]);
	});

	it("applies only carried settings and never merges dependency metadata into runtime settings", async () => {
		const store = new ClientStateStore(file);
		store.saveSettings("c", {
			retryMaxAttempts: 7,
			softCapTokens: 100_000,
			reviewPrompt: "keep existing review",
			disabledAgentTools: ["browser_page"],
		});
		store.savePresets("c", [
			{ name: "partial", promptTemplate: "{{tools}}", plugins: [{ id: "notes", source: "owner/repo" }] },
		]);
		const before = store.getSettings("c");
		const host: SettingsHost = {
			clientId: "c",
			stateStore: store,
			emit: () => {},
			flushSnapshot: () => {},
			isDisposed: () => false,
			getSession: () => {
				throw new Error("no active session");
			},
			cwd: () => dir,
			agentDir: () => dir,
			isStreaming: () => false,
			reloadSession: async () => {},
			applyRetryOverrides: () => {},
			applyCompactionOverrides: () => {},
			applyToolGating: () => {},
			promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		};
		const service = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
		await service.applyPreset("partial");
		const after = store.getSettings("c");
		expect(after.promptTemplate).toBe("{{tools}}");
		for (const field of [
			"retryMaxAttempts",
			"softCapTokens",
			"reviewPrompt",
			"disabledAgentTools",
			"terminalToolsEnabled",
		] as const)
			expect(after[field]).toEqual(before[field]);
		expect(after).not.toHaveProperty("plugins");
		host.reloadSession = async () => {
			throw new Error("reload rejected");
		};
		await expect(service.applyPreset("partial")).rejects.toThrow("reload rejected");
		expect(store.getPresets("c")[0].name).toBe("partial");
	});

	it("round-trips plugin dependency metadata without adding settings", () => {
		const preset: SettingsPreset = {
			name: "plugin prompt",
			customSystemPrompt: "Use the required plugin.",
			plugins: [
				{ id: "example", name: "Example", source: "https://example.com/plugin.git", version: "1.2.3" },
				{ id: "minimal" },
			],
		};
		new ClientStateStore(file).savePresets("writer", [preset]);
		const reopened = new ClientStateStore(file);
		const loaded = reopened.getPresets("reader");
		expect(loaded).toEqual([preset]);
		reopened.savePresets("reader", loaded);
		expect(new ClientStateStore(file).getPresets("reader")).toEqual([preset]);
		expect(JSON.parse(readFileSync(file, "utf8")).__settings__.presets).toEqual([preset]);
	});
});
