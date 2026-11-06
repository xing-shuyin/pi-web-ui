import { describe, expect, it, vi, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import webuiExtension, { buildNodeArgs, running } from "../../extensions/webui.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

describe("webui extension: buildNodeArgs (#580)", () => {
	it("returns only entry when hookPath is not provided or does not exist", () => {
		expect(buildNodeArgs("/app/index.js", undefined, false)).toEqual(["/app/index.js"]);
		expect(buildNodeArgs("/app/index.js", "/non/existent/hook.js", false)).toEqual(["/app/index.js"]);
	});

	it("returns --import with file:// URL when hookPath exists", () => {
		const hook = "/path/to/resolve-global-sdk.js";
		const args = buildNodeArgs("/app/index.js", hook, true);
		expect(args).toEqual(["--import", pathToFileURL(hook).href, "/app/index.js"]);
		expect(args[1].startsWith("file://")).toBe(true);
	});

	it("converts Windows drive-letter paths to file:// URL to avoid ERR_UNSUPPORTED_ESM_URL_SCHEME", () => {
		const winHook =
			"C:\\Users\\Administrator\\.pi\\agent\\npm\\node_modules\\pi-web-ui\\dist\\server\\resolve-global-sdk.js";
		const args = buildNodeArgs("C:\\path\\index.js", winHook, true);
		expect(args[0]).toBe("--import");
		expect(args[1].startsWith("file:")).toBe(true);
		expect(args[1]).not.toMatch(/^[A-Za-z]:\\/);
		const parsedUrl = new URL(args[1]);
		expect(parsedUrl.protocol).toBe("file:");
	});
});

describe("webui extension: command lifecycle & notifications (#580)", () => {
	let registeredCommand:
		{ description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	let shutdownHandler: ((event: any, ctx: any) => Promise<void>) | undefined;

	beforeEach(() => {
		running.clear();
		const mockPi: ExtensionAPI = {
			registerCommand: (_name: string, def: any) => {
				registeredCommand = def;
			},
			on: (event: string, handler: any) => {
				if (event === "session_shutdown") shutdownHandler = handler;
			},
		} as unknown as ExtensionAPI;
		webuiExtension(mockPi);
	});

	function createMockContext(sid = "session-1") {
		const notifications: Array<{ msg: string; level?: string }> = [];
		const ctx: ExtensionCommandContext = {
			cwd: "/mock/cwd",
			sessionManager: {
				getSessionId: () => sid,
			},
			ui: {
				notify: (msg: string, level?: string) => {
					notifications.push({ msg, level });
				},
			},
		} as unknown as ExtensionCommandContext;
		return { ctx, notifications };
	}

	it("registers /webui command and session_shutdown hook", () => {
		expect(registeredCommand).toBeDefined();
		expect(registeredCommand?.description).toContain("/webui");
		expect(shutdownHandler).toBeDefined();
	});

	it("/webui status when not running informs user", async () => {
		const { ctx, notifications } = createMockContext();
		await registeredCommand!.handler("status", ctx);
		expect(notifications).toEqual([{ msg: "本机 pi-web-ui 未运行", level: "info" }]);
	});

	it("/webui stop when not running informs user", async () => {
		const { ctx, notifications } = createMockContext();
		await registeredCommand!.handler("stop", ctx);
		expect(notifications).toEqual([{ msg: "没有正在运行的本机 pi-web-ui 服务器", level: "info" }]);
	});

	it("/webui status reports running info and log path when alive", async () => {
		const { ctx, notifications } = createMockContext("s1");
		const mockProc = new EventEmitter() as any;
		mockProc.exitCode = null;
		mockProc.signalCode = null;
		mockProc.kill = vi.fn();

		running.set("s1", {
			proc: mockProc,
			port: 8787,
			cwd: "/test/cwd",
			url: "http://localhost:8787",
			logFile: "/test/cwd/.pi-web/webui.log",
			stop: () => {
				mockProc.kill("SIGTERM");
			},
		});

		await registeredCommand!.handler("status", ctx);
		expect(notifications.length).toBe(1);
		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("pi-web-ui 运行中 → http://localhost:8787");
		expect(notifications[0].msg).toContain("日志: /test/cwd/.pi-web/webui.log");
	});

	it("/webui status reports exit code and log path after process exited", async () => {
		const { ctx, notifications } = createMockContext("s2");
		const mockProc = new EventEmitter() as any;
		mockProc.exitCode = 1;
		mockProc.signalCode = null;
		mockProc.kill = vi.fn();

		running.set("s2", {
			proc: mockProc,
			port: 8787,
			cwd: "/test/cwd",
			url: "http://localhost:8787",
			logFile: "/test/cwd/.pi-web/webui.log",
			stop: () => {
				mockProc.kill("SIGTERM");
			},
		});

		await registeredCommand!.handler("status", ctx);
		expect(notifications.length).toBe(1);
		expect(notifications[0].level).toBe("warning");
		expect(notifications[0].msg).toContain("pi-web-ui 已退出 (exit=1)");
		expect(notifications[0].msg).toContain("日志: /test/cwd/.pi-web/webui.log");
	});

	it("/webui stop kills running process and cleans up", async () => {
		const { ctx, notifications } = createMockContext("s3");
		const mockProc = new EventEmitter() as any;
		mockProc.exitCode = null;
		mockProc.signalCode = null;
		mockProc.kill = vi.fn();

		let stopped = false;
		running.set("s3", {
			proc: mockProc,
			port: 8787,
			cwd: "/test/cwd",
			url: "http://localhost:8787",
			stop: () => {
				stopped = true;
				mockProc.kill("SIGTERM");
			},
		});

		await registeredCommand!.handler("stop", ctx);
		expect(stopped).toBe(true);
		expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(running.has("s3")).toBe(false);
		expect(notifications).toEqual([{ msg: "已停止 pi-web-ui (http://localhost:8787)", level: "info" }]);
	});

	it("session_shutdown stops child process and cleans up", async () => {
		const mockProc = new EventEmitter() as any;
		mockProc.exitCode = null;
		mockProc.signalCode = null;
		mockProc.kill = vi.fn();

		let stopped = false;
		running.set("s4", {
			proc: mockProc,
			port: 8787,
			cwd: "/test/cwd",
			url: "http://localhost:8787",
			stop: () => {
				stopped = true;
				mockProc.kill("SIGTERM");
			},
		});

		const { ctx } = createMockContext("s4");
		await shutdownHandler!({}, ctx);
		expect(stopped).toBe(true);
		expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(running.has("s4")).toBe(false);
	});
});
