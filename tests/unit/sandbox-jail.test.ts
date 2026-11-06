import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxInfo } from "../../server/protocol.js";
import { evaluateSandboxJail, type SandboxJailPolicy } from "../../server/sandbox-service.js";

describe("copy sandbox capability policy", () => {
	let base: string;
	let root: string;
	let outside: string;
	let sandbox: SandboxInfo;
	const trusted: SandboxJailPolicy = { trustedTool: true };
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "sandbox-jail-"));
		root = join(base, "copy");
		outside = join(base, "credentials");
		mkdirSync(root);
		mkdirSync(join(root, "src"));
		mkdirSync(outside);
		writeFileSync(join(root, "src", "task.js"), "process.exit(0)");
		writeFileSync(join(outside, "token"), "secret");
		sandbox = { id: "jail-test", path: root, sourcePath: outside } as SandboxInfo;
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));
	const decide = (name: string, params: Record<string, unknown> = {}, policy = trusted) =>
		evaluateSandboxJail(sandbox, name, params, root, policy);

	it.each([
		"node task.js",
		"bash task.sh",
		"eval 'cat ~/.ssh/id_rsa'",
		"python -c 'import os'",
		"npm test",
		"npm run build",
		"echo ok > local.txt",
		"ls",
		"",
	])("refuses all host execution: %s", (command) => {
		expect(decide("bash", { command })?.reasonEn).toContain("secure OS-isolated backend");
	});

	it.each([
		"codemode",
		"exec",
		"terminal",
		"terminal_input",
		"terminal_key",
		"remote_term",
		"sftp",
		"mail",
		"browser_use",
		"browser_page",
		"desktop_type",
		"wechat_send",
		"plugin",
		"mcp__server__write",
		"load_tools",
		"invented_readonly_tool",
	])("denies unclassified capability %s even if caller trusts its origin", (name) => {
		expect(decide(name, { action: "list", dryRun: true })).not.toBeNull();
	});

	it.each(["read", "grep", "find", "write", "edit", "edit_soft", "patch", "sandbox", "subagent"])(
		"does not trust a tool named %s without host ownership",
		(name) => {
			expect(decide(name, { path: "src/task.js", action: "list" }, {})).not.toBeNull();
		},
	);

	it("fails closed for a DSH plugin bridge without host provenance, including builtin names", () => {
		for (const name of ["write", "read", "grep", "find", "sandbox", "mcp__files__write"]) {
			expect(evaluateSandboxJail(sandbox, name, { path: "src/task.js", action: "list" }, root)).not.toBeNull();
		}
	});

	it.each(["read", "write", "edit", "edit_soft"])("allows bounded basic file operation %s", (name) => {
		expect(decide(name, { path: "src/task.js" })).toBeNull();
		expect(decide(name, { file_path: "src/new-file.ts" })).toBeNull();
		expect(decide(name, { path: join(root, "src", "nested", "new.ts") })).toBeNull();
	});

	it.each(["read", "write", "edit", "edit_soft", "grep", "find"])("checks all paths of %s", (name) => {
		for (const path of [
			outside,
			"../credentials/token",
			"~/.ssh/id_rsa",
			"src/task.js:stream",
			"src/\0oops",
			" src/task.js ",
			"",
			null,
		]) {
			expect(decide(name, { path }), String(path)).not.toBeNull();
		}
	});

	it("rejects SDK-normalized alternate paths before execution", () => {
		for (const path of [
			"@../credentials/token",
			"@/etc/passwd",
			"src/\u00a0task.js",
			"file:///etc/passwd",
			"\\\\?\\C:\\secret",
			"src/task.js:stream",
		]) {
			expect(decide("read", { path })).not.toBeNull();
		}
	});

	it("validates both file aliases and refuses missing or evidence pseudo paths", () => {
		expect(decide("read", { path: "src/task.js", file_path: join(outside, "token") })).not.toBeNull();
		expect(decide("read", {})).not.toBeNull();
		expect(decide("read", { path: "context-evidence:index" })).not.toBeNull();
		expect(decide("write", { path: 42 })).not.toBeNull();
	});

	it.each(["grep", "find"])("refuses host %s even with trusted ownership and bounded paths", (name) => {
		expect(decide(name, { pattern: "*.js", glob: "**/*.js" })?.reasonEn).toContain("safe backend");
		expect(decide(name, { path: "src", pattern: "--pre=evil" })).not.toBeNull();
		expect(decide(name, { path: "missing", pattern: "*" })).not.toBeNull();
	});

	it("checks patch sources, rename destinations and empty target extraction", () => {
		expect(decide("patch", { patch: "[src/task.js]\nADD after EOF\n+hello" })).toBeNull();
		expect(decide("patch", { patch: "[src/task.js]\nMV src/moved.js" })).toBeNull();
		expect(decide("patch", { patch: "[src/task.js]\nMV ../credentials/token" })).not.toBeNull();
		expect(
			decide("patch", { patch: "*** Update File: src/task.js\n*** Move to: ../credentials/token" }),
		).not.toBeNull();
		expect(decide("patch", { patch: "[../credentials/token]\nREM" })).not.toBeNull();
		expect(decide("patch", { patch: "unrecognized patch" })).not.toBeNull();
		expect(decide("patch", {})).not.toBeNull();
	});

	it("bounds every presented file and refuses external media URLs", () => {
		expect(decide("present_files", { items: [{ path: "src/task.js" }] })).toBeNull();
		expect(decide("present_files", { items: [{ path: "src/task.js" }, { path: outside }] })).not.toBeNull();
		expect(decide("present_files", { items: [{ path: "https://example.com/secret" }] })).not.toBeNull();
		expect(decide("present_files", { items: [null] })).not.toBeNull();
		expect(decide("present_files", { items: [] })).not.toBeNull();
	});

	it("rejects symlink and dangling-link file operations and recursive discovery", () => {
		symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		for (const name of ["read", "write", "edit", "edit_soft", "grep", "find"]) {
			expect(decide(name, { path: "escape/token" })).not.toBeNull();
		}
		expect(decide("write", { path: "escape/new-file" })).not.toBeNull();
		expect(decide("grep", { pattern: "secret" })).not.toBeNull();
		expect(decide("find", { pattern: "*" })).not.toBeNull();
		expect(decide("grep", { path: "src", pattern: "process" })).not.toBeNull();
		rmSync(outside, { recursive: true });
		expect(decide("write", { path: "escape/new-file" })).not.toBeNull();
	});

	it("refuses hardlinks to outside credentials", () => {
		linkSync(join(outside, "token"), join(root, "shared-token"));
		expect(decide("read", { path: "shared-token" })).not.toBeNull();
		expect(decide("write", { path: "shared-token" })).not.toBeNull();
		expect(decide("grep", { pattern: "secret" })).not.toBeNull();
	});

	it("requires a live root and a bounded cwd for ordinary tools", () => {
		expect(evaluateSandboxJail(sandbox, "write", { path: join(root, "new.txt") }, outside, trusted)).not.toBeNull();
		rmSync(root, { recursive: true });
		expect(decide("write", { path: "new.txt" })).not.toBeNull();
	});

	it("preserves explicit sandbox management actions while rejecting unknown ones", () => {
		for (const action of ["list", "create", "diff", "reset", "persist", "promote", "apply_to_source", "destroy"]) {
			expect(decide("sandbox", { action })).toBeNull();
		}
		expect(decide("sandbox", { action: "execute" })).not.toBeNull();
		expect(decide("sandbox", {})).not.toBeNull();
	});

	it("allows subagents only when host-enforced inheritance is explicit", () => {
		expect(decide("subagent", { action: "spawn" })).not.toBeNull();
		expect(decide("subagent", { action: "spawn" }, { inheritedSandboxSubagent: true })).not.toBeNull();
		expect(decide("subagent", { action: "spawn" }, { ...trusted, inheritedSandboxSubagent: true })).toBeNull();
	});
});
