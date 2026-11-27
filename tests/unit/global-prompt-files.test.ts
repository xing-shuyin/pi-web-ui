import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GlobalPromptConflictError,
	GlobalPromptCustomStore,
	GlobalPromptValidationError,
	MAX_GLOBAL_PROMPT_FILE_BYTES,
	listGlobalPromptFiles,
	writeGlobalPromptFile,
	type GlobalPromptEnvironment,
} from "../../server/global-prompt-files.js";

const ENV_KEYS = ["CODEX_HOME", "GEMINI_CLI_HOME", "QWEN_CODE_HOME", "XDG_CONFIG_HOME"] as const;

describe("global agent prompt files", () => {
	let root: string;
	let homeDir: string;
	let agentDir: string;
	let dataDir: string;
	let customStore: GlobalPromptCustomStore;
	let env: GlobalPromptEnvironment;
	let previousEnv: Record<string, string | undefined>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-global-prompts-"));
		homeDir = join(root, "home");
		agentDir = join(root, "agent");
		dataDir = join(root, "data");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
		previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		customStore = new GlobalPromptCustomStore(join(dataDir, "global-prompt-files.json"));
		env = { homeDir, agentDir, customStore };
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function put(path: string, content: string): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content, "utf8");
	}

	it("scans built-in global files and rule directories without scanning arbitrary paths", async () => {
		put(join(agentDir, "SYSTEM.md"), "pi global soul");
		put(join(homeDir, ".claude", "CLAUDE.md"), "claude global memory");
		put(join(homeDir, ".codex", "AGENTS.md"), "codex global instructions");
		put(join(homeDir, ".cursor", "rules", "a.mdc"), "---\nalwaysApply: true\n---\nrule a");
		put(join(homeDir, ".cursor", "rules", "b.md"), "rule b");
		put(join(homeDir, ".claude", "rules", "nested", "ignored.md"), "not a direct rule");
		put(join(homeDir, "unrelated", "SYSTEM.md"), "must not be discovered");

		const catalog = await listGlobalPromptFiles(env);
		const byId = new Map(catalog.files.map((file) => [file.id, file]));
		expect(byId.get("pi:system")?.content).toBe("pi global soul");
		expect(byId.get("claude:context")?.content).toBe("claude global memory");
		expect(byId.get("codex:context")?.content).toBe("codex global instructions");
		expect(byId.get("cursor:rules:a.mdc")?.content).toContain("rule a");
		expect(byId.get("cursor:rules:b.md")?.content).toBe("rule b");
		expect(byId.get("pi:append")).toMatchObject({ exists: false, revision: "missing", content: "" });
		expect(catalog.files.some((file) => file.path.includes("unrelated"))).toBe(false);
		expect(catalog.directories.find((directory) => directory.id === "cursor:rules")?.fileCount).toBe(2);
	});

	it("writes atomically, preserves mode, creates missing built-ins, and rejects stale revisions", async () => {
		const systemPath = join(agentDir, "SYSTEM.md");
		put(systemPath, "before");
		chmodSync(systemPath, 0o640);
		const first = await listGlobalPromptFiles(env);
		const file = first.files.find((item) => item.id === "pi:system");
		expect(file).toBeDefined();
		if (!file) return;

		const saved = await writeGlobalPromptFile(env, {
			id: file.id,
			content: "after",
			expectedRevision: file.revision,
		});
		expect(saved.content).toBe("after");
		expect(readFileSync(systemPath, "utf8")).toBe("after");
		expect(statSync(systemPath).mode & 0o777).toBe(0o640);

		await expect(
			writeGlobalPromptFile(env, { id: file.id, content: "stale", expectedRevision: file.revision }),
		).rejects.toBeInstanceOf(GlobalPromptConflictError);

		const created = await writeGlobalPromptFile(env, {
			id: "pi:append",
			content: "global append",
			expectedRevision: "missing",
		});
		expect(created).toMatchObject({ exists: true, content: "global append" });
		expect(readFileSync(join(agentDir, "APPEND_SYSTEM.md"), "utf8")).toBe("global append");
	});

	it.runIf(process.platform !== "win32")("rejects symlink escapes from registered directories", async () => {
		const outside = join(root, "outside.md");
		const linked = join(agentDir, "SYSTEM.md");
		put(outside, "outside content");
		symlinkSync(outside, linked, "file");

		const catalog = await listGlobalPromptFiles(env);
		expect(catalog.files.find((file) => file.id === "pi:system")).toMatchObject({
			exists: false,
			content: "",
			error: "Path resolves outside its registered directory",
		});
		await expect(
			writeGlobalPromptFile(env, { id: "pi:system", content: "overwrite", expectedRevision: "missing" }),
		).rejects.toBeInstanceOf(GlobalPromptValidationError);
		expect(readFileSync(outside, "utf8")).toBe("outside content");
	});

	it("registers, persists, and unregisters custom files without deleting them", async () => {
		const customPath = join(root, "custom-agent", "GLOBAL.md");
		put(customPath, "custom instructions");
		const added = await customStore.add(customPath, "My agent");
		expect(added).toMatchObject({ label: "My agent", path: realpathSync(customPath) });

		const reopened = new GlobalPromptCustomStore(join(dataDir, "global-prompt-files.json"));
		const catalog = await listGlobalPromptFiles({ ...env, customStore: reopened });
		expect(catalog.files.find((file) => file.id === added.id)).toMatchObject({
			agent: "custom",
			label: "My agent",
			content: "custom instructions",
			custom: true,
		});

		await reopened.remove(added.id);
		expect(existsSync(customPath)).toBe(true);
		const after = await listGlobalPromptFiles({ ...env, customStore: reopened });
		expect(after.files.some((file) => file.id === added.id)).toBe(false);
	});

	it("rejects duplicate, missing, non-file, and unsupported custom registrations", async () => {
		const customPath = join(root, "custom.md");
		put(customPath, "custom");
		await customStore.add(customPath);
		await expect(customStore.add(customPath)).rejects.toBeInstanceOf(GlobalPromptValidationError);
		await expect(customStore.add(join(root, "missing.md"))).rejects.toBeInstanceOf(GlobalPromptValidationError);
		await expect(customStore.add(join(root, "unsupported.json"))).rejects.toBeInstanceOf(GlobalPromptValidationError);
		await expect(customStore.add(root)).rejects.toBeInstanceOf(GlobalPromptValidationError);
	});

	it("marks oversized files as truncated and refuses to overwrite them", async () => {
		put(join(agentDir, "SYSTEM.md"), "x".repeat(MAX_GLOBAL_PROMPT_FILE_BYTES + 1));
		const catalog = await listGlobalPromptFiles(env);
		const file = catalog.files.find((item) => item.id === "pi:system");
		expect(file).toMatchObject({ exists: true, truncated: true, content: "" });
		await expect(
			writeGlobalPromptFile(env, {
				id: "pi:system",
				content: "replacement",
				expectedRevision: file?.revision ?? "",
			}),
		).rejects.toBeInstanceOf(GlobalPromptValidationError);
	});

	it("does not silently replace a foreign custom registry", async () => {
		const registryPath = join(dataDir, "global-prompt-files.json");
		writeFileSync(registryPath, JSON.stringify({ version: 999, files: [] }), "utf8");
		const customPath = join(root, "custom.md");
		put(customPath, "custom");
		const catalog = await listGlobalPromptFiles(env);
		expect(catalog.customStorageBlocked).toBe(true);
		await expect(customStore.add(customPath)).rejects.toThrow(/拒绝写入/);
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({ version: 999, files: [] });
	});
});
