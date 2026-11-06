import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVerificationCommand } from "../../server/device-center/local-verification.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(processes.spawn).mockReset();
});
function fakeChild(code: number, authenticatedReceipt = false) {
	vi.mocked(processes.spawn).mockImplementation(((_command: unknown, _args: unknown, options: any) => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 424242,
			kill: vi.fn(),
		});
		if (authenticatedReceipt)
			child.stdin.once("data", (secret) => {
				const socket = connect(`\\\\.\\pipe\\${options.env.PI_LOCAL_VERIFICATION_PIPE}`, () =>
					socket.end(`${secret.toString().trim()}:0\n`),
				);
				socket.once("close", () => child.emit("close", code));
				socket.on("error", () => child.emit("close", code));
			});
		else queueMicrotask(() => child.emit("close", code));
		return child;
	}) as any);
}

describe("verification supervisor proof", () => {
	it.skipIf(process.platform !== "win32")(
		"does not equate normal supervisor exit with a missing stop receipt",
		async () => {
			fakeChild(0);
			await expect(
				runVerificationCommand("unused", { cwd: process.cwd(), env: process.env, stopTimeoutMs: 25 }),
			).rejects.toMatchObject({ stopUnconfirmed: true });
		},
	);
	it.skipIf(process.platform !== "win32")(
		"rejects authenticated success evidence when supervisor actually exits abnormally",
		async () => {
			fakeChild(7, true);
			await expect(
				runVerificationCommand("unused", { cwd: process.cwd(), env: process.env, stopTimeoutMs: 1000 }),
			).rejects.toMatchObject({ stopUnconfirmed: true });
		},
	);
	it.skipIf(process.platform === "win32")(
		"retains unknown process-group state instead of treating EPERM as ordinary command failure",
		async () => {
			fakeChild(0);
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("not permitted"), { code: "EPERM" });
			});
			await expect(runVerificationCommand("unused", { cwd: process.cwd(), env: process.env })).rejects.toMatchObject({
				stopUnconfirmed: true,
			});
		},
	);
});
