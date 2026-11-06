import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../server/terminals.js";
import {
	attachPersistentRemoteNativeCli,
	openPersistentRemoteNativeCli,
	probePersistentRemoteNativeCli,
} from "../../server/remote-cli-persistence.js";
import { resolveRemoteNativeCliLaunch } from "../../server/remote-native-cli.js";
import { getGlobalRemoteSshService, setGlobalRemoteSshService } from "../../server/remote-ssh-service.js";
import type { PreparedNativeCliSession } from "../../server/native-cli-runtime.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../server/remote-native-cli.js", () => ({ resolveRemoteNativeCliLaunch: vi.fn() }));
vi.mock("../../server/remote-cli-persistence.js", () => ({
	openPersistentRemoteNativeCli: vi.fn(),
	attachPersistentRemoteNativeCli: vi.fn(),
	probePersistentRemoteNativeCli: vi.fn(),
}));
const cwd = "ssh://tester@example.test:22/project";
const config = { preset: "claude", keepAlive: true } as const;
let original: ReturnType<typeof getGlobalRemoteSshService>;
let manager: TerminalManager;
let pty: any;
let handle: any;
let sessions: PreparedNativeCliSession[];
let events: any[];
let statuses: any[];
let report: (event: any) => void;

function makePty(): any {
	const pty: any = {
		pid: 0,
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(() => pty.exit?.({ exitCode: 0 })),
		onData: vi.fn((cb) => {
			pty.data = cb;
			return { dispose() {} };
		}),
		onExit: vi.fn((cb) => {
			pty.exit = cb;
			return { dispose() {} };
		}),
	};
	return pty;
}
function start() {
	return manager.createNativeCli("cli", cwd, 80, 24, cwd, "CLI", { nativeCli: config });
}

beforeEach(() => {
	vi.resetAllMocks();
	original = getGlobalRemoteSshService();
	setGlobalRemoteSshService({} as any);
	pty = makePty();
	handle = {
		pty,
		created: true,
		sessionName: "fixture",
		terminate: vi.fn(async () => {}),
		probe: vi.fn(async () => ({ alive: true })),
	};
	vi.mocked(openPersistentRemoteNativeCli).mockResolvedValue(handle);
	vi.mocked(attachPersistentRemoteNativeCli).mockImplementation(async () => ({
		...handle,
		pty: makePty(),
		created: false,
	}));
	vi.mocked(probePersistentRemoteNativeCli).mockResolvedValue({ alive: false });
	vi.mocked(resolveRemoteNativeCliLaunch).mockResolvedValue({ file: "/remote/bin/claude", args: [] });
	events = [];
	statuses = [];
	sessions = [];
	const ref = { key: randomUUID() };
	manager = new TerminalManager(() => {}, cwd);
	manager.nativeCliRuntime = {
		reference: () => ref,
		prepare: async (_id, config, _cwd, _signal, callback) => {
			report = callback;
			const session: PreparedNativeCliSession = {
				config,
				ref,
				capabilities: { resume: "exact", events: "hooks" },
				start: vi.fn(() => vi.fn()),
				flush: vi.fn(async () => {}),
				dispose: vi.fn(async () => {}),
			};
			sessions.push(session);
			return session;
		},
		onEvent: (_id, event) => events.push(event),
		onStatus: (_id, status) => statuses.push(status),
	};
});
afterEach(() => {
	manager.killAll({ shutdown: true });
	setGlobalRemoteSshService(original as any);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("persistent CLI lifecycle ownership", () => {
	it("keeps remote references and the process alive through detach and service shutdown", async () => {
		await start();
		const target = manager.captureNativeCliPasteTarget("cli")!;
		const cleanup = vi.fn(async () => {});
		target.retainCleanup(cleanup, ["/tmp/pi-native-cli-12345678-1234-1234-1234-123456789abc"]);
		manager.detachNativeCli("cli");
		expect(target.signal.aborted).toBe(true);
		expect(target.paste("old request")).toBe(false);
		expect(cleanup).not.toHaveBeenCalled();
		expect(handle.terminate).not.toHaveBeenCalled();
		expect(statuses.at(-1).phase).toBe("disconnected");
		manager.killAll({ shutdown: true });
		expect(cleanup).not.toHaveBeenCalled();
		expect(handle.terminate).not.toHaveBeenCalled();
		expect(sessions[0].dispose).toHaveBeenCalled();
	});

	it("cleans staged references only after an explicit remote stop was confirmed", async () => {
		await start();
		const cleanup = vi.fn(async () => {});
		manager.captureNativeCliPasteTarget("cli")!.retainCleanup(cleanup);
		manager.detachNativeCli("cli");
		await manager.stopNativeCli("cli");
		expect(handle.terminate).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
		expect(statuses.at(-1)).toMatchObject({ phase: "exited", exitCode: null });
	});

	it("keeps a failed stop retryable and invalidates references captured before the stop", async () => {
		await start();
		const old = manager.captureNativeCliPasteTarget("cli")!;
		handle.terminate.mockRejectedValueOnce(new Error("SSH offline"));
		await expect(manager.stopNativeCli("cli")).rejects.toThrow("offline");
		expect(old.signal.aborted).toBe(true);
		expect(old.paste("stale")).toBe(false);
		expect(manager.captureNativeCliPasteTarget("cli")!.paste("fresh")).toBe(true);
		expect(pty.write).toHaveBeenCalledWith("\x1b[200~fresh\x1b[201~");
		expect(statuses.some((state) => state.phase === "exited")).toBe(false);
		await manager.stopNativeCli("cli");
	});

	it("serializes an explicit stop against another reconnect to the same terminal", async () => {
		await start();
		manager.detachNativeCli("cli");
		let finish!: () => void;
		handle.terminate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const stopping = manager.stopNativeCli("cli");
		expect(await start()).toBeNull();
		expect(attachPersistentRemoteNativeCli).not.toHaveBeenCalled();
		finish();
		await stopping;
		expect(statuses.at(-1).phase).toBe("exited");
	});

	it("does not terminate an existing process when shutdown cancels a pending reattachment", async () => {
		await start();
		manager.detachNativeCli("cli");
		vi.mocked(probePersistentRemoteNativeCli).mockResolvedValue({ alive: true });
		let finish!: (value: any) => void;
		vi.mocked(attachPersistentRemoteNativeCli).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const attaching = start();
		await vi.waitFor(() => expect(attachPersistentRemoteNativeCli).toHaveBeenCalledOnce());
		manager.killAll({ shutdown: true });
		const late = makePty();
		finish({ ...handle, pty: late, created: false });
		expect(await attaching).toBeNull();
		expect(late.kill).toHaveBeenCalledOnce();
		expect(handle.terminate).not.toHaveBeenCalled();
	});

	it("drains the last official event before disposing a naturally completed remote process", async () => {
		vi.useFakeTimers();
		await start();
		handle.probe.mockResolvedValue({ alive: false, exitCode: 0 });
		vi.mocked(sessions[0].flush!).mockImplementation(async () => {
			report({ type: "done", eventId: "last-stop" });
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(events).toContainEqual({ type: "done", eventId: "last-stop" });
		expect(statuses.at(-1)).toMatchObject({ phase: "exited", exitCode: 0 });
		expect(sessions[0].dispose).toHaveBeenCalled();
		expect(manager.captureNativeCliPasteTarget("cli")).toBeUndefined();
	});
});
