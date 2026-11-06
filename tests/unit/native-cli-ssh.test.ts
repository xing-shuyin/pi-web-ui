import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { TerminalManager } from "../../server/terminals.js";
import { handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";
import { resolveRemoteNativeCliLaunch } from "../../server/remote-native-cli.js";
import { prepareRemoteNativeCliPaste } from "../../server/native-cli-remote-files.js";
import { remoteNativeCliCleanupQueue } from "../../server/native-cli-remote-cleanup.js";
import { getGlobalRemoteSshService, setGlobalRemoteSshService } from "../../server/remote-ssh-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../server/remote-native-cli.js", () => ({ resolveRemoteNativeCliLaunch: vi.fn() }));
vi.mock("../../server/native-cli-remote-files.js", () => ({
	prepareRemoteNativeCliPaste: vi.fn(),
	cleanupRemoteNativeCliFiles: vi.fn(),
}));

const cwd = "ssh://tester@example.test:22/workspace";
const config = { preset: "claude" } as const;
const managers: TerminalManager[] = [];
let originalService: ReturnType<typeof getGlobalRemoteSshService>;
let service: any;
let pty: any;

function remotePty(): any {
	const result: any = {
		pid: 0,
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(() => result.exit?.({ exitCode: 0 })),
		onData: vi.fn((callback) => {
			result.data = callback;
			return { dispose() {} };
		}),
		onExit: vi.fn((callback) => {
			result.exit = callback;
			return { dispose() {} };
		}),
	};
	return result;
}
function manager(ownerKind: "client" | "conversation" = "conversation"): TerminalManager {
	const result = new TerminalManager(() => {}, cwd, undefined, ownerKind);
	managers.push(result);
	return result;
}
function start(tm: TerminalManager) {
	return tm.createNativeCli("cli", cwd, 80, 24, cwd, "Remote CLI", { nativeCli: config });
}
function paste(tm: TerminalManager, materializeAttachments?: any, dataDir?: string) {
	const send = vi.fn();
	const cs = fakeClientSession({ findTerminalManager: () => tm }) as any;
	handleTerminalMessage(
		{
			type: "terminal_cli_paste",
			requestId: "paste-remote",
			terminalId: "cli",
			ownerKind: "conversation",
			conversationId: "remote",
			data: "read this",
		},
		cs,
		{ clientId: "remote-cli-test", dataDir, settings: {}, send, materializeAttachments },
	);
	return send;
}

beforeEach(() => {
	vi.clearAllMocks();
	originalService = getGlobalRemoteSshService();
	pty = remotePty();
	service = { createCommandPty: vi.fn(async () => pty) };
	setGlobalRemoteSshService(service);
	vi.mocked(resolveRemoteNativeCliLaunch).mockReset().mockResolvedValue({ file: "/remote/bin/claude", args: [] });
	vi.mocked(prepareRemoteNativeCliPaste).mockReset();
});
afterEach(() => {
	for (const tm of managers.splice(0)) tm.killAll();
	remoteNativeCliCleanupQueue.dispose();
	setGlobalRemoteSshService(originalService as any);
	vi.restoreAllMocks();
});

describe("SSH CLI terminal lifecycle", () => {
	it("starts through the remote command channel and preserves attach, output and exit history", async () => {
		const tm = manager();
		expect(await start(tm)).toMatchObject({ cwd, nativeCli: config, running: true });
		expect(resolveRemoteNativeCliLaunch).toHaveBeenCalledWith(service, config, cwd, undefined, expect.any(AbortSignal));
		expect(service.createCommandPty).toHaveBeenCalledWith(cwd, { file: "/remote/bin/claude", args: [] }, 80, 24, {
			signal: expect.any(AbortSignal),
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(tm.attach("cli", 100, 40)).toBe(true);
		expect(pty.resize).toHaveBeenCalledWith(100, 40);
		pty.data("remote output");
		pty.exit({ exitCode: 9 });
		expect(tm.list()[0]).toMatchObject({ cwd, running: false, exitCode: 9 });
		expect(tm.replay()[0].data).toContain("remote output");
		expect(tm.captureNativeCliPasteTarget("cli")).toBeUndefined();
	});

	it("shares one startup for repeated create requests and cancels before the remote spawn", async () => {
		let finish!: (value: any) => void;
		vi.mocked(resolveRemoteNativeCliLaunch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const tm = manager();
		const first = start(tm);
		const second = start(tm);
		expect(resolveRemoteNativeCliLaunch).toHaveBeenCalledTimes(1);
		const signal = vi.mocked(resolveRemoteNativeCliLaunch).mock.calls[0][4]!;
		tm.kill("cli");
		expect(signal.aborted).toBe(true);
		finish({ file: "/remote/bin/claude", args: [] });
		expect(await first).toBeNull();
		expect(await second).toBeNull();
		expect(service.createCommandPty).not.toHaveBeenCalled();
	});

	it.each(["client", "conversation"] as const)(
		"routes a pending %s terminal close through its actual owner",
		async (ownerKind) => {
			let finish!: (value: any) => void;
			service.createCommandPty.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const tm = manager(ownerKind);
			const cs = fakeClientSession({
				userTerminals: tm,
				getTerminalManager: () => tm,
				getTerminalCwd: () => cwd,
				getNativeCliConversation: () => ({ terminalId: "cli", config }),
			}) as any;
			handleTerminalMessage(
				{
					type: "terminal_create",
					terminalId: "cli",
					ownerKind,
					conversationId: "remote",
					cwd,
					cols: 80,
					rows: 24,
					nativeCli: config,
				},
				cs,
			);
			await vi.waitFor(() => expect(service.createCommandPty).toHaveBeenCalledOnce());
			const signal = service.createCommandPty.mock.calls[0][4].signal;
			handleTerminalMessage({ type: "terminal_kill", terminalId: "cli", ownerKind, conversationId: "remote" }, cs);
			expect(signal.aborted).toBe(true);
			finish(pty);
			await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledOnce());
			expect(tm.list()).toEqual([]);
		},
	);

	it("closes a late remote PTY after the owning conversation was closed", async () => {
		let finish!: (value: any) => void;
		service.createCommandPty.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const tm = manager();
		const starting = start(tm);
		await vi.waitFor(() => expect(service.createCommandPty).toHaveBeenCalledOnce());
		tm.killAll();
		finish(pty);
		expect(await starting).toBeNull();
		expect(pty.kill).toHaveBeenCalledOnce();
		expect(tm.list()).toEqual([]);
	});

	it("rejects another SSH host and never starts its command or a local process", async () => {
		const tm = manager();
		expect(
			await tm.createNativeCli("cli", "ssh://tester@other.test:22/workspace", 80, 24, cwd, "CLI", {
				nativeCli: config,
			}),
		).toBeNull();
		expect(resolveRemoteNativeCliLaunch).not.toHaveBeenCalled();
		expect(service.createCommandPty).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("closes only the remote channel without typing a shell exit command into the CLI", async () => {
		const tm = manager();
		await start(tm);
		tm.kill("cli");
		expect(pty.kill).toHaveBeenCalledOnce();
		expect(pty.write).not.toHaveBeenCalled();
		expect(tm.list()).toEqual([]);
	});
});

describe("remote references stay with their captured process", () => {
	it("retains staged files through paste and disposes them when that CLI closes", async () => {
		const dispose = vi.fn(async () => {});
		vi.mocked(prepareRemoteNativeCliPaste).mockResolvedValue({ text: "read /tmp/remote-file", paths: [], dispose });
		const tm = manager();
		await start(tm);
		const dataDir = "E:/tmp/explicit-instance-data";
		const send = paste(tm, undefined, dataDir);
		await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
		expect(prepareRemoteNativeCliPaste).toHaveBeenCalledWith(
			expect.objectContaining({ cwd, service, dataDir, signal: expect.any(AbortSignal) }),
			"read this",
			[],
		);
		expect(pty.write).toHaveBeenCalledWith("\x1b[200~read /tmp/remote-file\x1b[201~");
		expect(dispose).not.toHaveBeenCalled();
		tm.kill("cli");
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
	});

	it("does not upload or paste a late materialized reference into a restarted same-id CLI", async () => {
		let finish!: (value: any[]) => void;
		const materialize = vi.fn(
			() =>
				new Promise<any[]>((resolve) => {
					finish = resolve;
				}),
		);
		const tm = manager();
		await start(tm);
		const send = paste(tm, materialize);
		tm.kill("cli");
		pty = remotePty();
		await start(tm);
		finish([]);
		await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: false })));
		expect(prepareRemoteNativeCliPaste).not.toHaveBeenCalled();
		expect(pty.write).not.toHaveBeenCalled();
	});

	it("queues failed staging cleanup instead of forgetting uploaded paths", async () => {
		const paths = ["/tmp/pi-native-cli-12345678-1234-1234-1234-123456789abc"];
		const enqueue = vi.spyOn(remoteNativeCliCleanupQueue, "enqueue");
		vi.mocked(prepareRemoteNativeCliPaste).mockRejectedValue(Object.assign(new Error("upload failed"), { paths }));
		const tm = manager();
		await start(tm);
		const send = paste(tm);
		await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: false })));
		expect(enqueue).toHaveBeenCalledWith(service, cwd, paths);
		expect(pty.write).not.toHaveBeenCalled();
	});
});
