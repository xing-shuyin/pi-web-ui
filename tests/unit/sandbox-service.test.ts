import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	SandboxManager,
	evaluateSandboxJail,
	extractPatchTargetPaths,
	isStrictlyInsideSandbox,
	withSandboxJailGate,
} from "../../server/sandbox-service.js";
import { makeSandboxTool } from "../../server/sandbox-tool.js";

describe("SandboxManager & Hard Jail Isolation", () => {
	let tempRoot: string;
	let dataDir: string;
	let sourceProjectDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-test-"));
		dataDir = join(tempRoot, "data");
		sourceProjectDir = join(tempRoot, "my-source-app");
		mkdirSync(sourceProjectDir, { recursive: true });
		mkdirSync(join(sourceProjectDir, "src"), { recursive: true });
		mkdirSync(join(sourceProjectDir, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(sourceProjectDir, ".git"), { recursive: true });
		writeFileSync(join(sourceProjectDir, "package.json"), '{"name":"my-source-app"}', "utf-8");
		writeFileSync(join(sourceProjectDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");
		writeFileSync(join(sourceProjectDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf-8");
		writeFileSync(join(sourceProjectDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("creates a blank ephemeral sandbox and persists or destroys it", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox, copiedFiles } = await mgr.create({
			name: "My Blank Lab",
			ephemeral: true,
		});
		expect(copiedFiles).toBe(0);
		expect(sandbox.name).toBe("My Blank Lab");
		expect(sandbox.ephemeral).toBe(true);
		expect(sandbox.sourcePath).toBeUndefined();
		expect(existsSync(sandbox.path)).toBe(true);
		expect(mgr.getByCwd(sandbox.path)?.id).toBe(sandbox.id);
		expect(mgr.getByCwd(join(sandbox.path, "nested", "dir"))?.id).toBe(sandbox.id);

		const persisted = mgr.persist(sandbox.id);
		expect(persisted.ephemeral).toBe(false);

		const mgr2 = new SandboxManager(dataDir);
		expect(mgr2.get(sandbox.id)?.ephemeral).toBe(false);

		await mgr2.destroy(sandbox.id);
		expect(existsSync(sandbox.path)).toBe(false);
		expect(mgr2.list()).toHaveLength(0);
	});

	it("imports an existing project without node_modules, isolates edits, resets, promotes, and syncs back", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox, copiedFiles } = await mgr.create({
			sourcePath: sourceProjectDir,
			ephemeral: false,
		});
		expect(copiedFiles).toBeGreaterThanOrEqual(2);
		expect(existsSync(join(sandbox.path, "package.json"))).toBe(true);
		expect(existsSync(join(sandbox.path, "src", "index.ts"))).toBe(true);
		expect(existsSync(join(sandbox.path, "node_modules"))).toBe(false);

		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 999;\n", "utf-8");
		writeFileSync(join(sandbox.path, "src", "new-file.ts"), "export const added = true;\n", "utf-8");
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "src", "new-file.ts"))).toBe(false);

		const formalDir = join(tempRoot, "promoted-app");
		const promoted = await mgr.promote(sandbox.id, formalDir);
		expect(promoted.copiedFiles).toBeGreaterThanOrEqual(3);
		expect(readFileSync(join(formalDir, "src", "new-file.ts"), "utf-8")).toBe("export const added = true;\n");
		expect(existsSync(join(formalDir, "node_modules"))).toBe(false);
		expect(existsSync(join(formalDir, ".git"))).toBe(false);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "src", "new-file.ts"))).toBe(false);
		expect(readFileSync(join(formalDir, "src", "index.ts"), "utf-8")).toBe("export const x = 999;\n");
		expect(readFileSync(join(formalDir, "src", "new-file.ts"), "utf-8")).toBe("export const added = true;\n");
		expect(existsSync(join(formalDir, "node_modules"))).toBe(false);
		expect(existsSync(join(formalDir, ".git"))).toBe(false);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "src", "new-file.ts"))).toBe(false);

		await mgr.reset(sandbox.id);
		expect(readFileSync(join(sandbox.path, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sandbox.path, "src", "new-file.ts"))).toBe(false);

		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 42;\n", "utf-8");
		mkdirSync(join(sandbox.path, ".git"), { recursive: true });
		writeFileSync(join(sandbox.path, ".git", "HEAD"), "corrupted\n", "utf-8");
		rmSync(join(sandbox.path, "package.json"));
		const diff = await mgr.diffWithSource(sandbox.id);
		await expect(mgr.applyToSource(sandbox.id)).rejects.toThrow(/revision required/i);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "package.json"))).toBe(true);
		const applyRes = await mgr.applyToSource(sandbox.id, diff.expectedRevision);
		expect(applyRes.deletedFiles).toBe(1);
		expect(existsSync(join(sourceProjectDir, "package.json"))).toBe(false);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 42;\n");
		expect(readFileSync(join(sourceProjectDir, ".git", "HEAD"), "utf-8")).toBe("ref: refs/heads/main\n");
	});

	it("refuses stale export previews without changing the source", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox } = await mgr.create({ sourcePath: sourceProjectDir, ephemeral: true });
		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 2;\n");
		const diff = await mgr.diffWithSource(sandbox.id);
		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 3;\n");
		await expect(mgr.applyToSource(sandbox.id, diff.expectedRevision)).rejects.toThrow(/refresh preview/i);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "package.json"))).toBe(true);
	});

	it("enforces hard jail isolation on write, edit, patch, bash, sftp, and mail", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox } = await mgr.create({
			sourcePath: sourceProjectDir,
			ephemeral: true,
		});

		expect(evaluateSandboxJail(sandbox, "write", { path: "src/index.ts" }, sandbox.path)).not.toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "write", { path: "src/index.ts" }, sandbox.path, { trustedTool: false }),
		).not.toBeNull();
		expect(isStrictlyInsideSandbox("src/index.ts", sandbox.path, sandbox.path)).toBe(true);
		expect(
			evaluateSandboxJail(sandbox, "write", { path: "src/index.ts" }, sandbox.path, { trustedTool: true }),
		).toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "edit", { path: join(sandbox.path, "README.md") }, sandbox.path, {
				trustedTool: true,
			}),
		).toBeNull();

		expect(isStrictlyInsideSandbox("../escape.txt", sandbox.path, sandbox.path)).toBe(false);
		expect(
			evaluateSandboxJail(sandbox, "write", { path: "../escape.txt" }, sandbox.path, { trustedTool: true }),
		).not.toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "edit", { path: join(sourceProjectDir, "src/index.ts") }, sandbox.path, {
				trustedTool: true,
			}),
		).not.toBeNull();

		const safePatch =
			"*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const x = 1;\n+export const x = 2;\n";
		const evilPatch = "*** Begin Patch\n*** Add File: ../outside.ts\n+evil\n";
		expect(extractPatchTargetPaths(safePatch)).toEqual(["src/index.ts"]);
		expect(evaluateSandboxJail(sandbox, "patch", { patch: safePatch }, sandbox.path, { trustedTool: true })).toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "patch", { patch: evilPatch }, sandbox.path, { trustedTool: true }),
		).not.toBeNull();

		for (const command of [
			"npm test",
			"echo ok > build.log",
			"npm test > /dev/null",
			"cd .. && ls",
			'cd "$HOME/.."',
			"rm -rf /etc/hosts",
			`cat "${sourceProjectDir}/package.json"`,
		]) {
			expect(evaluateSandboxJail(sandbox, "bash", { command }, sandbox.path, { trustedTool: true })).not.toBeNull();
		}
		for (const [tool, params] of [
			["sftp", { action: "plan" }],
			["sftp", { action: "sync", dryRun: true }],
			["sftp", { action: "sync", dryRun: false }],
			["sftp", { action: "rm", path: "/srv/app" }],
			["mail", { action: "list" }],
			["mail", { action: "send" }],
		] as const) {
			expect(evaluateSandboxJail(sandbox, tool, params, sandbox.path, { trustedTool: true })).not.toBeNull();
		}

		let executed = false;
		const dummyWriteTool = {
			name: "write",
			label: "write",
			description: "write",
			parameters: {} as any,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ok" }], details: {} } as any;
			},
		} satisfies ToolDefinition;

		const untrusted = withSandboxJailGate(
			dummyWriteTool,
			() => sandbox,
			() => sandbox.path,
			() => "en",
		);
		const untrustedResult = await untrusted.execute(
			"untrusted",
			{ path: "inside.txt", content: "good" } as never,
			undefined,
			undefined,
			{} as any,
		);
		expect(untrustedResult.isError).toBe(true);
		expect(executed).toBe(false);

		const gated = withSandboxJailGate(
			dummyWriteTool,
			() => sandbox,
			() => sandbox.path,
			() => "zh",
			{ trustedTool: true },
		);
		const deniedRes = (await gated.execute(
			"call-1",
			{ path: "../outside.txt", content: "bad" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(executed).toBe(false);
		expect(deniedRes.isError).toBe(true);
		expect(deniedRes.details?.sandboxDenied).toBe(true);

		const allowedRes = (await gated.execute(
			"call-2",
			{ path: "inside.txt", content: "good" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(executed).toBe(true);
		expect(allowedRes.isError).toBeUndefined();
	});

	it("AI sandbox tool supports create, list, diff, approval-gated apply_to_source, reset, and destroy", async () => {
		const mgr = new SandboxManager(dataDir);
		let currentCwd = sourceProjectDir;
		let approvalAllow = false;
		let approvalCalls = 0;
		const lifecycleCalls: string[] = [];

		const tool = makeSandboxTool(
			{
				sandboxes: mgr,
				getCwd: () => currentCwd,
				setCwd: async (next) => {
					currentCwd = next;
				},
				onSandboxesChanged: async () => {},
				resetSandbox: (target) => {
					lifecycleCalls.push("reset");
					return mgr.reset(target);
				},
				destroySandbox: (target) => {
					lifecycleCalls.push("destroy");
					return mgr.destroy(target);
				},
				applySandboxToSource: (target, revision) => {
					lifecycleCalls.push("apply");
					return mgr.applyToSource(target, revision);
				},
				askApproval: async () => {
					approvalCalls++;
					return approvalAllow ? { decision: "approve" } : { decision: "deny", reason: "Not ready yet" };
				},
			},
			() => "en",
		);

		const createRes = (await tool.execute(
			"c1",
			{ action: "create", mode: "import", name: "AI Refactor Lab", switchTo: true } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		const sbxId = createRes.details.sandbox.id;
		const sbxPath = createRes.details.sandbox.path;
		expect(currentCwd).toBe(sbxPath);

		writeFileSync(join(sbxPath, "src", "index.ts"), "export const x = 777;\n", "utf-8");
		writeFileSync(join(sbxPath, "src", "helper.ts"), "export const h = 1;\n", "utf-8");

		approvalAllow = true;
		for (const action of ["reset", "destroy", "apply_to_source"] as const) {
			const result = await tool.execute("self-" + action, { action, sandbox: sbxId }, undefined, undefined, {} as any);
			expect(result.isError).toBe(true);
		}
		expect(lifecycleCalls).toEqual([]);
		approvalCalls = 0;
		approvalAllow = false;
		expect(mgr.get(sbxId)).toBeDefined();
		expect(readFileSync(join(sbxPath, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "src", "helper.ts"))).toBe(false);

		currentCwd = sourceProjectDir;
		const diffRes = (await tool.execute(
			"c2",
			{ action: "diff", sandbox: sbxId } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(diffRes.details.added).toEqual(["src/helper.ts"]);
		expect(diffRes.details.modified).toEqual(["src/index.ts"]);
		expect(diffRes.details.deleted).toEqual([]);

		const deniedApply = (await tool.execute(
			"c3",
			{ action: "apply_to_source", sandbox: sbxId } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(approvalCalls).toBe(1);
		expect(deniedApply.isError).toBe(true);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");

		approvalAllow = true;
		const allowedApply = (await tool.execute(
			"c4",
			{ action: "apply_to_source", sandbox: sbxId } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(approvalCalls).toBe(2);
		expect(allowedApply.isError).toBeUndefined();
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");
		expect(existsSync(join(sourceProjectDir, "src", "helper.ts"))).toBe(true);

		writeFileSync(join(sbxPath, "src", "index.ts"), "sandbox-only\n");
		const resetRes = await tool.execute("reset", { action: "reset", sandbox: sbxId }, undefined, undefined, {} as any);
		expect(resetRes.isError).toBeUndefined();
		expect(readFileSync(join(sbxPath, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");

		const destroyRes = (await tool.execute(
			"c5",
			{ action: "destroy", sandbox: sbxId } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(destroyRes.isError).toBeUndefined();
		expect(currentCwd.replace(/\\/g, "/")).toBe(sourceProjectDir.replace(/\\/g, "/"));
		expect(existsSync(sbxPath)).toBe(false);
		expect(lifecycleCalls).toEqual(["apply", "reset", "destroy"]);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");
		expect(readFileSync(join(sourceProjectDir, "src", "helper.ts"), "utf-8")).toBe("export const h = 1;\n");
	});
});

describe("patch 围栏的 hashline 段头识别（0.104 审计）", () => {
	let tempRoot: string;
	let dataDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-hashline-"));
		dataDir = join(tempRoot, "data");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("extractPatchTargetPaths 识别 [path#TAG] / [path] 段头（patch 工具实际消费的格式）", () => {
		const hashlinePatch = "[src/index.ts#a1b2]\nDEL <1: 3\nPUT <1: export const x = 2;\n";
		expect(extractPatchTargetPaths(hashlinePatch)).toContain("src/index.ts");
		const newFilePatch = "[new-file.ts]\nPUT <1: hello\n";
		expect(extractPatchTargetPaths(newFilePatch)).toContain("new-file.ts");
	});

	it("hashline 补丁的越界目标被围栏硬拒（此前提取出 0 目标、检查空转）", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox } = await mgr.create({ name: "hashline-lab", ephemeral: true });
		const evilHashline = "[../escape.ts]\nPUT <1: evil\n";
		expect(
			evaluateSandboxJail(sandbox, "patch", { patch: evilHashline }, sandbox.path, { trustedTool: true }),
		).not.toBeNull();
		const goodHashline = "[inside.ts]\nPUT <1: ok\n";
		expect(
			evaluateSandboxJail(sandbox, "patch", { patch: goodHashline }, sandbox.path, { trustedTool: true }),
		).toBeNull();
	});
});
