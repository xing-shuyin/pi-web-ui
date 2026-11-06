import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverRemoteNativeClis, resolveRemoteNativeCliLaunch } from "../../server/remote-native-cli.js";
import { RemoteSshService, shellQuotePosix } from "../../server/remote-ssh-service.js";
import { EventEmitter } from "node:events";
import * as nodePty from "node-pty";

const uri = "ssh://tester@example.test/work";
let root: string;
const posix = (file: string) =>
	file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const shell =
	process.platform === "win32"
		? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
		: "/bin/sh";
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-native-cli-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});
async function executable(relative: string, body = "#!/bin/sh\nexit 0\n") {
	const target = path.join(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, body, { mode: 0o755 });
	await fs.chmod(target, 0o755);
	return posix(target);
}
function run(command: string, extraEnv: NodeJS.ProcessEnv = {}) {
	return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
		const child = spawn(
			shell,
			["-c", `PATH=${shellQuotePosix(`${posix(root)}/bin:/usr/bin:/bin`)}; export PATH; ${command}`],
			{
				env: { ...process.env, HOME: posix(root), PATH: `${posix(root)}/bin:/usr/bin:/bin`, ...extraEnv },
				windowsHide: true,
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
	});
}
function mockService(files: string[], remotePath = "/remote/node/bin:/usr/bin") {
	return {
		execInWorkspace: vi.fn(async (_uri: string, command: string) => ({
			stdout: `${/PI_WEB_DISCOVERY_[a-f0-9]{48}/.exec(command)![0]}\0${remotePath}\0${files.join("\0")}\0`,
			stderr: "",
			exitCode: 0,
		})),
	};
}

describe("remote CLI resolution", () => {
	it("returns only standalone presets, availability and remote executable paths", async () => {
		const service = mockService(["/remote/bin/pi", "", "/remote/bin/codex", "/remote/bin/agy"]);
		const controller = new AbortController();
		const result = await discoverRemoteNativeClis(service, uri, controller.signal);
		expect(result.map((item) => item.preset)).toEqual(["pi", "claude", "codex", "agy"]);
		expect(result[0]).toEqual({ preset: "pi", available: true, executable: "/remote/bin/pi" });
		expect(result[1].available).toBe(false);
		expect(result[1].error).toContain("remote PATH");
		expect(service.execInWorkspace).toHaveBeenCalledWith(uri, expect.any(String), {
			cwd: "/",
			timeoutMs: 25_000,
			signal: controller.signal,
		});
	});
	it("uses only remote PATH and current model credentials and clears conflicting Claude login variables", async () => {
		const service = mockService(["/remote/npm/bin/claude"]);
		const launch = await resolveRemoteNativeCliLaunch(
			service,
			{ preset: "claude", model: { provider: "test", id: "remote-model" } },
			uri,
			{ baseUrl: "https://gateway.test/v1", apiKey: "api-key-only-in-env", headers: { "x-example": "header-secret" } },
		);
		expect(launch.file).toBe("/remote/npm/bin/claude");
		expect(launch.args).toEqual(["--model", "remote-model"]);
		expect(launch.env?.PATH).toBe("/remote/npm/bin:/remote/node/bin:/usr/bin");
		expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe("api-key-only-in-env");
		expect(launch.env?.ANTHROPIC_CUSTOM_HEADERS).toBe("x-example: header-secret");
		expect(launch.unsetEnv).toContain("ANTHROPIC_API_KEY");
		expect(launch.unsetEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(launch.env).not.toHaveProperty("HOME");
		expect(launch.args.join(" ")).not.toContain("api-key-only-in-env");
		expect(service.execInWorkspace.mock.calls[0][1]).not.toContain("api-key-only-in-env");
	});
	it("preserves Codex model options and puts credentials/headers solely in environment", async () => {
		const launch = await resolveRemoteNativeCliLaunch(
			mockService(["/remote/codex"]),
			{
				preset: "codex",
				args: ["--model=explicit"],
				model: { provider: "test", id: "fallback" },
			},
			uri,
			{ baseUrl: "https://gateway.test", apiKey: "private-key", headers: { "x.key": "private-header" } },
		);
		expect(launch.args).toContain("--model=explicit");
		expect(launch.args).not.toContain("fallback");
		expect(launch.env?.PI_WEB_CLI_API_KEY).toBe("private-key");
		expect(launch.env?.[`PI_WEB_CLI_HEADER_${0}`]).toBe("private-header");
		expect(launch.args.join(" ")).not.toContain("private-key");
		expect(launch.args.join(" ")).not.toContain("private-header");
	});
	it("rejects unavailable and Windows paths, malformed replies, unsupported hosts and cancellation", async () => {
		await expect(
			resolveRemoteNativeCliLaunch(mockService([""]), { preset: "custom", executable: "/missing" }, uri),
		).rejects.toThrow("unavailable");
		const service = mockService(["/remote/pi"]);
		await expect(
			resolveRemoteNativeCliLaunch(service, { preset: "custom", executable: "C:\\pi.exe" }, uri),
		).rejects.toThrow("POSIX");
		expect(service.execInWorkspace).not.toHaveBeenCalled();
		service.execInWorkspace.mockResolvedValue({ stdout: "malformed", stderr: "", exitCode: 0 });
		await expect(discoverRemoteNativeClis(service, uri)).rejects.toThrow("Invalid remote CLI discovery");
		service.execInWorkspace.mockResolvedValue({ stdout: "", stderr: "Windows", exitCode: 125 });
		await expect(discoverRemoteNativeClis(service, uri)).rejects.toThrow("Windows is unsupported");
		service.execInWorkspace.mockRejectedValue(new Error("cancelled"));
		await expect(discoverRemoteNativeClis(service, uri, new AbortController().signal)).rejects.toThrow("cancelled");
	});
});

describe("remote discovery scripts in a local POSIX shell", () => {
	it("finds local-bin, npm, nvm and agy installations without local server paths", async () => {
		await executable("bin/uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");
		const pi = await executable(".local/bin/pi");
		const claude = await executable(".npm-global/bin/claude");
		const codex = await executable(".nvm/versions/node/v24/bin/codex");
		const agy = await executable(".agy/bin/agy");
		const service = { execInWorkspace: vi.fn((_uri: string, command: string) => run(command)) };
		const result = await discoverRemoteNativeClis(service, uri);
		expect(result.map((item) => item.executable)).toEqual([pi, claude, codex, agy]);
		expect(result.every((item) => item.available)).toBe(true);
	});
	it("finds fnm and pnpm and expands quoted custom ~/ paths safely", async () => {
		await executable("bin/uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");
		const codex = await executable(".local/share/fnm/node-versions/v24/installation/bin/codex");
		const claude = await executable(".local/share/pnpm/claude");
		const custom = await executable(".local/bin/custom '$(touch injected)");
		const service = { execInWorkspace: vi.fn((_uri: string, command: string) => run(command)) };
		const result = await discoverRemoteNativeClis(service, uri);
		expect(result.find((item) => item.preset === "codex")?.executable).toBe(codex);
		expect(result.find((item) => item.preset === "claude")?.executable).toBe(claude);
		const launch = await resolveRemoteNativeCliLaunch(
			service,
			{ preset: "custom", executable: "~/.local/bin/custom '$(touch injected)", args: ["a b", "$(id)"] },
			uri,
		);
		expect(launch.file).toBe(custom);
		expect(launch.args).toEqual(["a b", "$(id)"]);
		await expect(fs.stat(path.join(root, "injected"))).rejects.toThrow();
	});
	it("explicitly rejects Windows uname even when a POSIX compatibility shell exists", async () => {
		await executable("bin/uname", "#!/bin/sh\nprintf '%s\\n' MINGW64_NT-10.0\n");
		await expect(discoverRemoteNativeClis({ execInWorkspace: (_uri, command) => run(command) }, uri)).rejects.toThrow(
			"Windows is unsupported",
		);
	});
	it("executes the constructed bootstrap with multiline quoted env and argv, not injected shell code", async () => {
		await executable("bin/uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");
		// A pipe has no termios; this local test substitutes only stty. The transport tests verify the ready gating.
		await executable("bin/stty", "#!/bin/sh\nif [ \"$1\" = -g ]; then printf '%s\\n' saved; fi\nexit 0\n");
		const target = await executable(
			"bin/target",
			'#!/bin/sh\n[ "${#SECRET}" -gt 10 ] || exit 21\n[ -z "${CONFLICT+x}" ] || exit 22\nprintf \'%s\\n\' "$1" "$2"\n',
		);
		const service = new RemoteSshService(root);
		let child: ReturnType<typeof spawn> | undefined;
		const client = Object.assign(new EventEmitter(), {
			exec: (command: string, _options: unknown, callback: any) => {
				child = spawn(
					shell,
					["-c", `PATH=${shellQuotePosix(`${posix(root)}/bin:/usr/bin:/bin`)}; export PATH; ${command}`],
					{
						env: { ...process.env, HOME: posix(root), PATH: `${posix(root)}/bin:/usr/bin:/bin`, CONFLICT: "old-login" },
						windowsHide: true,
					},
				);
				const channel = Object.assign(new EventEmitter(), {
					stderr: child.stderr!,
					write: (data: string) => child!.stdin!.write(data),
					close: () => child!.kill(),
					setWindow() {},
					pause() {},
					resume() {},
				});
				child.stdout!.on("data", (data) => channel.emit("data", data));
				child.on("close", (code) => channel.emit("close", code));
				child.on("error", (error) => channel.emit("error", error));
				callback(null, channel);
			},
		});
		const conn = { client, alive: false, activeOperations: 0 };
		vi.spyOn(service as any, "getOrConnectByUri").mockResolvedValue({ conn, parsed: { remotePath: posix(root) } });
		try {
			const pty = await service.createCommandPty(
				uri,
				{
					file: target,
					args: ["a b", "'$(touch injected)'"],
					env: { SECRET: "test'$(touch injected)\nsecond-line" },
					unsetEnv: ["CONFLICT"],
				},
				80,
				24,
			);
			let output = "";
			pty.onData((data) => {
				output += data;
			});
			await new Promise<void>((resolve) => pty.onExit(() => resolve()));
			expect(output).toBe("\na b\n'$(touch injected)'\n");
			expect(conn.activeOperations).toBe(0);
			await expect(fs.stat(path.join(root, "injected"))).rejects.toThrow();
		} finally {
			child?.kill();
		}
	});
	it("keeps credential payload out of actual PTY echo and restores terminal settings before exec", async () => {
		await executable("bin/uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");
		const target = await executable(
			"bin/target",
			'#!/bin/sh\n[ -z "${CONFLICT+x}" ] || exit 22\nprintf \'TARGET_ENV_LENGTH=%s\\n\' "${#SECRET}"\nstty -a\n',
		);
		const service = new RemoteSshService(root);
		const credential = "fake-credential-'$(touch injected)-unique\nsecond-line";
		let child: nodePty.IPty | undefined;
		let rawOutput = "";
		const client = Object.assign(new EventEmitter(), {
			exec: (command: string, _options: unknown, callback: any) => {
				child = nodePty.spawn(
					shell,
					["-c", `PATH=${shellQuotePosix(`${posix(root)}/bin:/usr/bin:/bin`)}; export PATH; ${command}`],
					{
						name: "xterm-256color",
						cols: 80,
						rows: 24,
						cwd: root,
						env: { ...process.env, HOME: posix(root), CONFLICT: "old-login" },
					},
				);
				const channel = Object.assign(new EventEmitter(), {
					stderr: new EventEmitter(),
					write: (data: string) => child!.write(data),
					close: () => child!.kill(),
					setWindow() {},
					pause() {},
					resume() {},
				});
				child.onData((data) => {
					rawOutput += data;
					channel.emit("data", Buffer.from(data));
				});
				child.onExit(({ exitCode }) => channel.emit("close", exitCode));
				callback(null, channel);
			},
		});
		const conn = { client, alive: false, activeOperations: 0 };
		vi.spyOn(service as any, "getOrConnectByUri").mockResolvedValue({ conn, parsed: { remotePath: posix(root) } });
		try {
			const pty = await service.createCommandPty(
				uri,
				{ file: target, args: [], env: { SECRET: credential }, unsetEnv: ["CONFLICT"] },
				80,
				24,
			);
			let output = "";
			pty.onData((data) => {
				output += data;
			});
			await new Promise<void>((resolve) => pty.onExit(() => resolve()));
			expect(rawOutput).not.toContain("fake-credential");
			expect(rawOutput).not.toContain("export SECRET");
			expect(output).toContain(`TARGET_ENV_LENGTH=${credential.length}`);
			expect(output).toMatch(/(?:^|[ ;\r\n])echo(?:[ ;\r\n]|$)/);
			expect(conn.activeOperations).toBe(0);
			await expect(fs.stat(path.join(root, "injected"))).rejects.toThrow();
		} finally {
			try {
				child?.kill();
			} catch {}
		}
	}, 15_000);
});
