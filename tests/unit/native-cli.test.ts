import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import {
	MAX_NATIVE_CLI_PASTE,
	prepareNativeCliPaste,
	resolveNativeCliLaunch,
	validateNativeCliConfig,
} from "../../server/native-cli.js";
import type { NativeCliConfig, PromptAttachment, ServerMessage } from "../../server/protocol.js";
import { TerminalManager } from "../../server/terminals.js";
import { saveUpload } from "../../server/uploads.js";
import { fakeClientSession } from "../helpers/fake-session.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, statSync: vi.fn(fs.statSync) };
});

let root: string;
const managers: TerminalManager[] = [];
let onExit: (event: { exitCode: number }) => void;
let onData: (data: string) => void;
let pty: {
	write: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	onData: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-native-cli-"));
	vi.stubEnv("PI_WEB_DATA_DIR", join(root, "data"));
	pty = {
		write: vi.fn(),
		kill: vi.fn(),
		resize: vi.fn(),
		onData: vi.fn((callback) => {
			onData = callback;
			return { dispose: vi.fn() };
		}),
		onExit: vi.fn((callback) => {
			onExit = callback;
			return { dispose: vi.fn() };
		}),
	};
	vi.mocked(spawn)
		.mockReset()
		.mockReturnValue(pty as any);
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.killAll();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function manager(ownerKind: "client" | "conversation" = "client", messages: ServerMessage[] = []) {
	const tm = new TerminalManager((message) => messages.push(message), root, undefined, ownerKind);
	managers.push(tm);
	return tm;
}
function config(): NativeCliConfig {
	return { preset: "custom", executable: process.execPath, args: ["interactive.js"] };
}
function session(tm: TerminalManager) {
	return fakeClientSession({
		getUserTerminalManager: vi.fn(() => tm),
		getTerminalManager: vi.fn(() => tm),
		findTerminalManager: vi.fn(() => tm),
		getTerminalCwd: vi.fn(() => root),
	}) as unknown as DispatchSession;
}

describe("native CLI configuration and argv", () => {
	it.each(["pi", "claude", "codex", "agy"] as const)(
		"uses %s with no injected output, auth or permission flags",
		(preset) => {
			const file = join(root, `${preset}${process.platform === "win32" ? ".exe" : ""}`);
			writeFileSync(file, "CLI fixture", { mode: 0o755 });
			const args: string[] = [];
			expect(resolveNativeCliLaunch({ preset, args }, { env: { PATH: root } })).toEqual({ file, args });
		},
	);
	it("uses dsh-tui with no injected output, auth or permission flags", () => {
		const file = join(root, `dsh-tui${process.platform === "win32" ? ".exe" : ""}`);
		writeFileSync(file, "CLI fixture", { mode: 0o755 });
		const args: string[] = [];
		expect(resolveNativeCliLaunch({ preset: "dsh", args }, { env: { PATH: root } })).toEqual({ file, args });
	});
	it.each(["pi", "claude", "codex", "agy"] as const)(
		"launches %s with its supported captured model options",
		(preset) => {
			const file = join(root, `${preset}${process.platform === "win32" ? ".exe" : ""}`);
			writeFileSync(file, "CLI fixture", { mode: 0o755 });
			const model = { provider: "selected-provider", id: "selected-model" };
			const launch = resolveNativeCliLaunch({ preset, model, args: ["--verbose"] }, { env: { PATH: root } });
			expect(launch).toEqual({
				file,
				args: [...(preset === "pi" ? ["--provider", model.provider] : []), "--model", model.id, "--verbose"],
			});
		},
	);

	it.each([["--model", "explicit"], ["--model=explicit"], ["-m", "explicit"], ["-m=explicit"]])(
		"keeps explicit model arguments %j instead of adding another model",
		(...args) => {
			const file = join(root, `codex${process.platform === "win32" ? ".exe" : ""}`);
			writeFileSync(file, "CLI fixture", { mode: 0o755 });
			expect(
				resolveNativeCliLaunch(
					{ preset: "codex", args, model: { provider: "openai", id: "inherited" } },
					{
						env: { PATH: root },
					},
				),
			).toEqual({ file, args });
		},
	);

	it("preserves an explicit Pi provider and treats text after -- as positional arguments", () => {
		const file = join(root, `pi${process.platform === "win32" ? ".exe" : ""}`);
		writeFileSync(file, "CLI fixture", { mode: 0o755 });
		const args = ["--provider=explicit-provider", "--", "--model=positional-text"];
		expect(
			resolveNativeCliLaunch(
				{ preset: "pi", args, model: { provider: "inherited-provider", id: "inherited-model" } },
				{
					env: { PATH: root },
				},
			),
		).toEqual({ file, args: ["--model", "inherited-model", ...args] });
	});

	it("automatically finds a preset in the user's native install directory without PATH", () => {
		const directory = join(root, ".local", "bin");
		mkdirSync(directory, { recursive: true });
		const file = join(directory, `claude${process.platform === "win32" ? ".exe" : ""}`);
		writeFileSync(file, "CLI fixture", { mode: 0o755 });
		expect(
			resolveNativeCliLaunch(
				{ preset: "claude", args: ["literal argument"] },
				{ env: {}, homeDir: root, nodeExecutable: join(root, "node", "node.exe") },
			),
		).toEqual({ file, args: ["literal argument"] });
	});
	it.skipIf(process.platform === "win32")("starts detected POSIX npm scripts without relying on node in PATH", () => {
		const directory = join(root, ".local", "bin");
		mkdirSync(directory, { recursive: true });
		const script = join(root, "cli.js");
		writeFileSync(script, "#!/usr/bin/env node\n", { mode: 0o755 });
		symlinkSync(script, join(directory, "codex"));
		const options = { env: {}, homeDir: root };
		expect(resolveNativeCliLaunch({ preset: "codex", args: ["a b"] }, options)).toEqual({
			file: process.execPath,
			args: [script, "a b"],
		});
		const localNode = join(directory, "node");
		writeFileSync(localNode, "Node fixture", { mode: 0o755 });
		expect(resolveNativeCliLaunch({ preset: "codex" }, options)).toEqual({ file: localNode, args: [script] });
	});
	it("keeps argv separate and copies the configuration", () => {
		const args = ["a b", 'a"b', "$(touch nope); & echo nope", "", "%PATH%", "`id`"];
		const value = { preset: "custom", executable: "/tmp/cli with spaces", args } as const;
		const checked = validateNativeCliConfig(value);
		args.push("later");
		expect(checked.args).toHaveLength(6);
		expect(resolveNativeCliLaunch(checked, { platform: "darwin" })).toEqual({
			file: value.executable,
			args: args.slice(0, 6),
		});
	});
	it.each([
		null,
		[],
		{},
		{ preset: "unknown" },
		{ preset: "durable" },
		{ preset: "durable", args: [] },
		{ preset: "durable", args: [" ", "ignored-profile"] },
		{ preset: "durable", args: ["tui"] },
		{ preset: "custom" },
		{ preset: "claude", executable: " " },
		{ preset: "claude", executable: "a\nb" },
		{ preset: "claude", executable: "a".repeat(4097) },
		{ preset: "codex", args: "--json" },
		{ preset: "claude", args: [12] },
		{ preset: "claude", args: ["a\x00b"] },
		{ preset: "claude", args: ["\x1b[31m"] },
		{ preset: "claude", args: ["\x85"] },
		{ preset: "claude", args: Array(129).fill("a") },
		{ preset: "claude", args: ["a".repeat(4097)] },
		{ preset: "claude", args: Array(9).fill("a".repeat(4096)) },
		{ preset: "claude", resume: true },
		{ preset: "claude", model: { provider: "anthropic", id: "" } },
		{ preset: "pi", model: { provider: "x\n", id: "model" } },
		{ preset: "codex", model: { provider: "openai", id: "model", key: "secret" } },
		{ preset: "custom", executable: "cli", model: { provider: "openai", id: "model" } },
		{ preset: "dsh", args: ["terminal"], model: { provider: "deepseek", id: "model" } },
	])("rejects malformed configuration %#", (value) => {
		expect(() => validateNativeCliConfig(value)).toThrow();
	});
	it.skipIf(process.platform !== "win32")(
		"resolves a Windows npm cmd shim to Node and preserves untrusted args literally",
		() => {
			const script = join(root, "node_modules", "cli", "bin.js");
			mkdirSync(join(root, "node_modules", "cli"), { recursive: true });
			writeFileSync(script, "// cli");
			const args = ["a b", 'a" & echo injected', "%PATH%", "$(id)"];
			// 第三种前缀是 npm 11+（cmd-shim 9）的逐字输出，`pi.cmd` / `claude.cmd` 现在都是这个形状。
			for (const prefix of [
				"",
				"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ",
				"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & ",
			]) {
				writeFileSync(
					join(root, "claude.cmd"),
					`@ECHO off\r\nSET "_prog=node"\r\n${prefix}"%_prog%" "%dp0%\\node_modules\\cli\\bin.js" %*\r\n`,
				);
				expect(resolveNativeCliLaunch({ preset: "claude", args }, { env: { Path: root }, cwd: root })).toEqual({
					file: process.execPath,
					args: [script, ...args],
				});
			}
			writeFileSync(join(root, "node.exe"), "node");
			expect(resolveNativeCliLaunch({ preset: "claude" }, { env: { PATH: root } }).file).toBe(join(root, "node.exe"));
		},
	);
	it.skipIf(process.platform !== "win32")(
		"resolves a Windows npm native executable shim without Node or shell argument expansion",
		() => {
			const binDir = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin with spaces");
			mkdirSync(binDir, { recursive: true });
			const args = ["a b", 'a" & echo injected', "%PATH%", "$(id)", ""];
			for (const extension of ["exe", "com"]) {
				const executable = join(binDir, `claude.${extension}`);
				writeFileSync(executable, "native executable");
				writeFileSync(
					join(root, "claude.cmd"),
					`@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin with spaces\\claude.${extension}"   %*\r\n`,
				);
				expect(resolveNativeCliLaunch({ preset: "claude", args }, { env: { Path: root } })).toEqual({
					file: executable,
					args,
				});
			}
		},
	);
	it.skipIf(process.platform !== "win32")(
		"rejects native shim invocations requiring batch expansion or extra commands",
		() => {
			for (const invocation of [
				'"%dp0%\\cli.exe" %* & calc.exe',
				'"%dp0%\\cli.exe" --injected %*',
				'"%dp0%\\%TARGET%.exe" %*',
				'"%dp0%\\cli.cmd" %*',
				'"%dp0%\\cli.js" %*',
			]) {
				writeFileSync(join(root, "claude.cmd"), `@ECHO off\r\n${invocation}\r\n`);
				expect(() => resolveNativeCliLaunch({ preset: "claude" }, { env: { Path: root } })).toThrow(/Unsupported/);
			}
		},
	);
	it.skipIf(process.platform !== "win32")("rejects arbitrary batch commands and missing Windows executables", () => {
		writeFileSync(join(root, "custom.cmd"), "@echo malicious & calc.exe");
		expect(() => resolveNativeCliLaunch({ preset: "custom", executable: join(root, "custom.cmd") })).toThrow(
			/Unsupported/,
		);
		writeFileSync(join(root, "custom.bat"), "@echo malicious");
		expect(() => resolveNativeCliLaunch({ preset: "custom", executable: join(root, "custom.bat") })).toThrow(
			/executable/,
		);
		expect(() =>
			resolveNativeCliLaunch({ preset: "custom", executable: "missing-native-cli-fixture" }, { env: { PATH: root } }),
		).toThrow(/not found/);
	});
});

describe("native CLI terminal lifecycle", () => {
	it("starts a real interactive PTY, retains metadata on list/attach/exit, and uses existing cleanup", () => {
		const messages: ServerMessage[] = [];
		const tm = manager("client", messages);
		const nativeCli = config();
		vi.stubEnv("ANTHROPIC_API_KEY", "inherited-key");
		vi.stubEnv("OPENAI_BASE_URL", "https://inherited.example");
		expect(tm.create("native", root, 120, 40, root, "CLI", { nativeCli })).toMatchObject({
			nativeCli,
			ownerKind: "client",
			running: true,
		});
		expect(spawn).toHaveBeenCalledWith(
			process.execPath,
			["interactive.js"],
			expect.objectContaining({
				cwd: root,
				cols: 120,
				rows: 40,
				useConptyDll: process.platform === "win32",
				env: expect.objectContaining({
					ANTHROPIC_API_KEY: "inherited-key",
					OPENAI_BASE_URL: "https://inherited.example",
				}),
			}),
		);
		expect(pty.write).not.toHaveBeenCalled();
		expect(tm.countUserBlockingLive()).toBe(1);
		nativeCli.args!.push("mutated");
		const listed = tm.list()[0];
		listed.nativeCli!.args!.push("also mutated");
		expect(tm.list()[0].nativeCli!.args).toEqual(["interactive.js"]);
		onData("native screen");
		expect(tm.attach("native", 90, 25)).toBe(true);
		expect(tm.list()[0]).toMatchObject({ nativeCli: config(), cols: 90, rows: 25 });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(pty.write).not.toHaveBeenCalled();
		onExit({ exitCode: 7 });
		expect(tm.list()[0]).toMatchObject({ nativeCli: config(), running: false, exitCode: 7 });
		expect(tm.getNativeCliTerminal("native")).toBeUndefined();
		expect(tm.pasteNativeCli("native", "draft")).toBe(false);
		tm.kill("native");
		expect(tm.list()).toEqual([]);
		expect(manager().list()).toEqual([]);
	});
	it("reports invalid configuration and spawn failures through the existing notice", () => {
		const messages: ServerMessage[] = [];
		const tm = manager("conversation", messages);
		expect(tm.create("bad", root, 80, 24, root, "bad", { nativeCli: { preset: "custom" } })).toBeNull();
		expect(spawn).not.toHaveBeenCalled();
		expect(messages).toContainEqual(expect.objectContaining({ type: "notice", level: "error" }));
		expect(messages.at(-1)).toMatchObject({ type: "terminal_list", terminals: [] });
		vi.mocked(spawn).mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		expect(tm.create("missing", root, 80, 24, root, "bad", { nativeCli: config() })).toBeNull();
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "notice",
				level: "error",
				textEn: expect.stringContaining("ENOENT"),
			}),
		);
		expect(messages.at(-1)).toMatchObject({ type: "terminal_list", terminals: [] });
		expect(tm.list()).toEqual([]);
	});
	it("resolves fresh inherited credentials on every launch and keeps them out of terminal metadata", async () => {
		let key = "first-test-key";
		const resolveModel = vi.fn(async () => ({ baseUrl: "https://provider.test/anthropic", apiKey: key }));
		const messages: ServerMessage[] = [];
		const tm = new TerminalManager((message) => messages.push(message), root, undefined, "conversation", resolveModel);
		managers.push(tm);
		const nativeCli: NativeCliConfig = {
			preset: "claude",
			executable: process.execPath,
			model: { provider: "selected-provider", id: "selected-model" },
		};
		expect(await tm.createNativeCli("cli", root, 80, 24, root, "CLI", { nativeCli })).not.toBeNull();
		expect(spawn).toHaveBeenLastCalledWith(
			process.execPath,
			["--model", "selected-model"],
			expect.objectContaining({ env: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: key }) }),
		);
		expect(JSON.stringify(tm.list())).not.toContain(key);
		expect(JSON.stringify(messages)).not.toContain(key);
		onExit({ exitCode: 0 });
		key = "rotated-test-key";
		expect(await tm.createNativeCli("cli", root, 80, 24, root, "CLI", { nativeCli })).not.toBeNull();
		expect(resolveModel).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenLastCalledWith(
			process.execPath,
			["--model", "selected-model"],
			expect.objectContaining({ env: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: key }) }),
		);
	});

	it.each(["terminal", "conversation"])("cancels pending CLI authentication when its %s closes", async (owner) => {
		let finish!: (value: { baseUrl: string; apiKey: string }) => void;
		const resolveModel = () => new Promise<{ baseUrl: string; apiKey: string }>((resolve) => (finish = resolve));
		const tm = new TerminalManager(() => {}, root, undefined, "conversation", resolveModel);
		managers.push(tm);
		const nativeCli: NativeCliConfig = {
			preset: "claude",
			executable: process.execPath,
			model: { provider: "selected", id: "model" },
		};
		const starting = tm.createNativeCli("pending", root, 80, 24, root, "CLI", { nativeCli });
		if (owner === "terminal") tm.kill("pending");
		else tm.killAll();
		finish({ baseUrl: "https://provider.test", apiKey: "test-key" });
		expect(await starting).toBeNull();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects synchronous SSH CLI creation without starting a local process", () => {
		const messages: ServerMessage[] = [];
		const remote = "ssh://user@example.test:22/project";
		const tm = new TerminalManager((message) => messages.push(message), remote, undefined, "client");
		managers.push(tm);
		expect(tm.create("remote", remote, 80, 24, remote, "CLI", { nativeCli: config() })).toBeNull();
		expect(spawn).not.toHaveBeenCalled();
		expect(messages).toContainEqual(
			expect.objectContaining({ type: "notice", textEn: "Remote CLI requires asynchronous startup" }),
		);
		expect(messages.at(-1)).toMatchObject({ type: "terminal_list", terminals: [] });
	});
	it("preserves the plain shell path and never restores CLI state in a new manager", () => {
		const tm = manager();
		tm.create("shell", root, 80, 24, root);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(tm.list()[0].nativeCli).toBeUndefined();
		expect(tm.getNativeCliTerminal("shell")).toBeUndefined();
		expect(tm.pasteNativeCli("shell", "draft")).toBe(false);
		expect(tm.countUserBlockingLive()).toBe(0);
		expect(manager().list()).toEqual([]);
	});
	it("dispatches native creation into the existing client/conversation owner routing", () => {
		const user = manager();
		const conversation = manager("conversation");
		const cs = session(user);
		cs.getTerminalManager = vi.fn(() => conversation);
		const create = {
			type: "terminal_create",
			terminalId: "cli",
			cwd: root,
			cols: 80,
			rows: 24,
			nativeCli: config(),
			conversationId: "conv",
		} as const;
		expect(handleTerminalMessage(create, cs)).toBe(true);
		expect(cs.getUserTerminalManager).toHaveBeenCalledOnce();
		expect(user.list()[0]).toMatchObject({ nativeCli: config(), ownerKind: "client" });
		handleTerminalMessage({ ...create, agentBash: true }, cs);
		expect(cs.getTerminalManager).toHaveBeenCalledWith("conv");
		expect(conversation.list()[0]).toMatchObject({ nativeCli: config(), ownerKind: "conversation", agentBash: true });
		handleTerminalMessage(
			{ type: "terminal_attach", terminalId: "cli", cols: 90, rows: 30, ownerKind: "client", conversationId: "conv" },
			cs,
		);
		expect(cs.findTerminalManager).toHaveBeenLastCalledWith("cli", "conv", "client");
	});
});

describe("native CLI prompt paste and attachments", () => {
	const context = () => ({ clientId: "cli-test", settings: {}, send: vi.fn() });
	it("writes one bracketed paste, returns success ack, and leaves Enter to terminal_input", () => {
		const tm = manager();
		tm.create("cli", root, 80, 24, root, "CLI", { nativeCli: config() });
		const cs = session(tm);
		const ctx = context();
		expect(
			handleTerminalMessage(
				{
					type: "terminal_cli_paste",
					requestId: "paste-1",
					terminalId: "cli",
					conversationId: "conv",
					ownerKind: "client",
					data: "hello\r\nworld\x03\x1b[201~",
				},
				cs,
				ctx,
			),
		).toBe(true);
		expect(cs.findTerminalManager).toHaveBeenCalledWith("cli", "conv", "client");
		expect(pty.write).toHaveBeenCalledExactlyOnceWith("\x1b[200~hello\nworld[201~\x1b[201~");
		expect(ctx.send).toHaveBeenCalledExactlyOnceWith({
			type: "terminal_cli_paste_result",
			requestId: "paste-1",
			terminalId: "cli",
			ok: true,
		});
		handleTerminalMessage({ type: "terminal_input", terminalId: "cli", ownerKind: "client", data: "\r" }, cs);
		expect(pty.write).toHaveBeenLastCalledWith("\r");
	});
	it("saves actual image/file bytes and resolves project files relative to CLI cwd", () => {
		const file = join(root, "project.txt");
		writeFileSync(file, "project");
		const ctx = context();
		const text = prepareNativeCliPaste(
			"inspect",
			[
				{ path: "project.txt", mode: "lines", lines: { start: 1, end: 2 } },
				{ path: "", imageData: Buffer.from("image bytes").toString("base64"), name: "photo.png" },
				{ path: "", fileData: Buffer.from("upload bytes").toString("base64"), name: "upload.txt" },
				{ path: "", mode: "quote", quote: { text: "quoted\x03 text", role: "user", messageId: "m1" } },
			],
			root,
			ctx,
		);
		const paths = [...text.matchAll(/File path: ("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]) as string);
		expect(paths[0]).toBe(file);
		expect(text).toContain("(lines 1-2)");
		expect(readFileSync(paths[1], "utf8")).toBe("image bytes");
		expect(readFileSync(paths[2], "utf8")).toBe("upload bytes");
		expect(text).toContain("Quoted text:\nquoted text");
		expect(text).not.toContain("imageData");
		expect(prepareNativeCliPaste("restore", [{ path: "", uploadPath: paths[1] }], root, ctx)).toContain(
			JSON.stringify(paths[1]),
		);
	});
	it("uses the resolved instance data directory instead of an unrelated environment upload root", () => {
		const dataDir = join(root, "explicit-instance-data");
		const upload = saveUpload("cli-test", "materialized.txt", Buffer.from("materialized reference"), dataDir);
		const ctx = { ...context(), dataDir };
		expect(prepareNativeCliPaste("read", [{ path: "", uploadPath: upload.abs }], root, ctx)).toContain(
			JSON.stringify(upload.abs),
		);
		const inline = prepareNativeCliPaste(
			"read",
			[{ path: "", name: "inline.txt", fileData: Buffer.from("inline").toString("base64") }],
			root,
			ctx,
		);
		const savedPath = JSON.parse(inline.split("File path: ")[1]);
		expect(savedPath.startsWith(dataDir)).toBe(true);
		expect(readFileSync(savedPath, "utf8")).toBe("inline");
	});

	it("accepts workspace directories as directory paths while uploaded references remain files only", () => {
		const directory = join(root, "source");
		mkdirSync(directory);
		expect(prepareNativeCliPaste("inspect", [{ path: "source" }], root, context())).toContain(
			`Directory path: ${JSON.stringify(directory)}`,
		);
		const saved = saveUpload("cli-test", "placeholder.txt", Buffer.from("file"));
		const uploadedDirectory = join(saved.abs, "..", "directory");
		mkdirSync(uploadedDirectory);
		expect(() =>
			prepareNativeCliPaste("inspect", [{ path: "", uploadPath: uploadedDirectory }], root, context()),
		).toThrow("Uploaded attachment is not a file");
	});
	it("accepts explicitly selected absolute files/directories outside cwd but rejects relative and symlink escapes", () => {
		const cwd = join(root, "workspace");
		const extra = join(root, "extra-root");
		mkdirSync(cwd);
		mkdirSync(extra);
		const file = join(extra, "outside.txt");
		writeFileSync(file, "explicitly selected file");
		const ctx = context();
		const text = prepareNativeCliPaste(
			"inspect",
			[{ path: file, mode: "lines", lines: { start: 2, end: 3 } }, { path: extra }],
			cwd,
			ctx,
		);
		expect(text).toContain(`File path: ${JSON.stringify(file)} (lines 2-3)`);
		expect(text).toContain(`Directory path: ${JSON.stringify(extra)}`);
		expect(() => prepareNativeCliPaste("inspect", [{ path: "../extra-root/outside.txt" }], cwd, ctx)).toThrow(
			/outside/,
		);
		const link = join(cwd, "linked-extra");
		symlinkSync(extra, link, process.platform === "win32" ? "junction" : "dir");
		expect(() => prepareNativeCliPaste("inspect", [{ path: "linked-extra/outside.txt" }], cwd, ctx)).toThrow(/outside/);
	});
	it("rejects workspace special files on every platform", () => {
		const path = join(root, "special");
		writeFileSync(path, "placeholder");
		// Model a device, socket or FIFO without requiring platform-specific filesystem privileges.
		vi.mocked(statSync).mockReturnValueOnce({ isFile: () => false, isDirectory: () => false } as any);
		expect(() => prepareNativeCliPaste("inspect", [{ path }], root, context())).toThrow(
			"Native CLI attachment is not a file or directory",
		);
	});
	it("accepts empty file uploads and unpadded base64 as actual saved files", () => {
		const text = prepareNativeCliPaste(
			"read",
			[
				{ path: "", fileData: "", name: "empty.txt" },
				{ path: "", fileData: "YQ", name: "one-byte.txt" },
			],
			root,
			context(),
		);
		const paths = [...text.matchAll(/File path: ("(?:[^"\\\\]|\\\\.)*")/g)].map(
			(match) => JSON.parse(match[1]) as string,
		);
		expect(readFileSync(paths[0])).toHaveLength(0);
		expect(readFileSync(paths[1], "utf8")).toBe("a");
	});
	it("rejects cross-client uploads, paths outside cwd, unsupported references and bad upload data", () => {
		const ctx = context();
		const foreign = saveUpload("other-client", "secret.txt", Buffer.from("secret")).abs;
		expect(() => prepareNativeCliPaste("hi", [{ path: "", uploadPath: foreign }], root, ctx)).toThrow(/outside/);
		expect(() => prepareNativeCliPaste("hi", [{ path: "../outside.txt" }], root, ctx)).toThrow();
		for (const mode of ["canvas", "conversation", "page"] as const)
			expect(() => prepareNativeCliPaste("hi", [{ path: "ref", mode }], root, ctx)).toThrow(/does not support/);
		expect(() => prepareNativeCliPaste("hi", [{ path: "", fileData: "not base64" }], root, ctx)).toThrow(/base64/);
		expect(() => prepareNativeCliPaste("hi", [{ path: "", fileData: "YQ==", imageData: "YQ==" }], root, ctx)).toThrow(
			/Ambiguous/,
		);
		expect(() =>
			prepareNativeCliPaste("hi", [{ path: "", fileData: Buffer.alloc(1024 * 1024 + 1).toString("base64") }], root, {
				...ctx,
				settings: { chatUploadMaxMb: 1 },
			}),
		).toThrow(/limit/);
		expect(() => prepareNativeCliPaste("a".repeat(MAX_NATIVE_CLI_PASTE + 1), [], root, ctx)).toThrow(/too long/);
		expect(() => prepareNativeCliPaste("中".repeat(MAX_NATIVE_CLI_PASTE / 2), [], root, ctx)).toThrow(/too long/);
		expect(() => prepareNativeCliPaste("\x03", [], root, ctx)).toThrow(/empty/);
		expect(() => prepareNativeCliPaste("hi", "bad" as unknown as PromptAttachment[], root, ctx)).toThrow(/attachments/);
	});
	it("returns failure ack for a plain/exited/missing terminal, invalid attachments, and PTY write errors", () => {
		const tm = manager();
		const cs = session(tm);
		const ctx = context();
		const request = {
			type: "terminal_cli_paste",
			requestId: "paste-2",
			terminalId: "cli",
			ownerKind: "client",
			data: "keep draft",
		} as const;
		handleTerminalMessage(request, cs, ctx);
		expect(ctx.send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.any(String) }));
		tm.create("cli", root, 80, 24, root);
		handleTerminalMessage(request, cs, ctx);
		expect(ctx.send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
		tm.kill("cli");
		pty.write.mockClear();
		tm.create("cli", root, 80, 24, root, "CLI", { nativeCli: config() });
		handleTerminalMessage({ ...request, attachments: [{ path: "canvas", mode: "canvas" }] }, cs, ctx);
		expect(ctx.send).toHaveBeenLastCalledWith(
			expect.objectContaining({ ok: false, error: expect.stringContaining("does not support") }),
		);
		expect(pty.write).not.toHaveBeenCalled();
		pty.write.mockImplementationOnce(() => {
			throw new Error("closed PTY");
		});
		handleTerminalMessage(request, cs, ctx);
		expect(ctx.send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: "closed PTY" }));
		onExit({ exitCode: 0 });
		handleTerminalMessage(request, cs, ctx);
		expect(ctx.send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
		expect(existsSync(join(root, "data", "uploads"))).toBe(false);
	});
});
