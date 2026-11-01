import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createGroupEvents } from "../../server/device-center/group-events.js";
import { projectTaskActivity, validTaskProgress } from "../../server/device-center/task-progress.js";

function fixture() {
	const state: any = {
		devices: [{ id: "device", accountId: "account" }],
		bots: [{ id: "bot", deviceId: "device", accountId: "account", enabled: true, revision: 1 }],
		rooms: [{ id: "room", accountId: "account", botIds: ["bot"] }],
		tasks: [
			{
				id: "task",
				deviceId: "device",
				accountId: "account",
				botId: "bot",
				botRevision: 1,
				roomId: "room",
				attemptId: "attempt",
				status: "running",
			},
		],
	};
	let changed = () => {};
	const unsubscribe = vi.fn();
	const events = createGroupEvents({
		snapshot: () => state,
		subscribe: (fn: () => void) => {
			changed = fn;
			return unsubscribe;
		},
	} as any);
	const response = () =>
		Object.assign(new EventEmitter(), {
			destroyed: false,
			set: vi.fn(),
			flushHeaders: vi.fn(),
			write: vi.fn((_chunk: string) => true),
			sendStatus: vi.fn(),
			end: vi.fn(),
			destroy: vi.fn(),
		});
	const frame = {
		taskId: "task",
		botId: "bot",
		attemptId: "attempt",
		sequence: 1,
		phase: "tool" as const,
		toolName: "read",
		text: "Reading source",
	};
	return { state, events, response, frame, changed: () => changed(), unsubscribe };
}
describe("group progress", () => {
	it("projects only bounded public fields and rejects oversized wire text", () => {
		const p = projectTaskActivity({
			phase: "tool",
			toolName: "read",
			text: "文".repeat(3000),
			arguments: { token: "secret" },
			approval: { id: "secret" },
		})!;
		expect(Buffer.byteLength(p.text!)).toBeLessThanOrEqual(2048);
		expect(Object.keys(p).sort()).toEqual(["phase", "text", "toolName"]);
		expect(validTaskProgress({ ...p, taskId: "t", botId: "b", attemptId: "a", sequence: 1 })).toBe(true);
		expect(
			validTaskProgress({ ...p, taskId: "t", botId: "b", attemptId: "a", sequence: 1, text: "x".repeat(2049) }),
		).toBe(false);
	});
	it("isolates accounts, devices and attempts, ignores replay, cleans terminal progress", () => {
		const f = fixture();
		const a = f.response();
		const denied = f.response();
		try {
			f.events.connect("other", "room", denied as any);
			expect(denied.sendStatus).toHaveBeenCalledWith(404);
			f.events.connect("account", "room", a as any, "device");
			a.write.mockClear();
			f.events.accept("other", f.frame);
			f.events.accept("device", { ...f.frame, attemptId: "old" });
			expect(a.write).not.toHaveBeenCalled();
			f.events.accept("device", { ...f.frame, arguments: { secret: "never" } } as any);
			expect(a.write).toHaveBeenCalledTimes(1);
			expect(a.write.mock.calls[0]?.[0]).not.toContain("secret");
			f.events.accept("device", f.frame);
			expect(a.write).toHaveBeenCalledTimes(1);
			f.state.tasks[0].status = "completed";
			f.changed();
			const reconnected = f.response();
			f.events.connect("account", "room", reconnected as any);
			expect(reconnected.write.mock.calls.flat().join("")).not.toContain("Reading source");
			reconnected.emit("close");
			f.state.devices = [];
			f.changed();
			expect(a.end).toHaveBeenCalled();
		} finally {
			a.emit("close");
			f.events.close();
		}
		expect(f.unsubscribe).toHaveBeenCalled();
	});
	it("invalidates only current members of the addressed room for interaction updates", () => {
		const f = fixture();
		const a = f.response();
		const b = f.response();
		f.state.rooms.push({ id: "other-room", accountId: "other-account", botIds: [] });
		try {
			f.events.connect("account", "room", a as any);
			f.events.connect("other-account", "other-room", b as any);
			a.write.mockClear();
			b.write.mockClear();
			f.events.invalidate("room");
			expect(a.write).toHaveBeenCalledTimes(1);
			expect(b.write).not.toHaveBeenCalled();
			f.state.rooms = [];
			f.events.invalidate("room");
			expect(a.write).toHaveBeenCalledTimes(1);
		} finally {
			a.emit("close");
			b.emit("close");
			f.events.close();
		}
	});
	it("disconnects slow clients and unsubscribes on close", () => {
		const f = fixture();
		const a = f.response();
		a.write.mockReturnValue(false);
		try {
			f.events.connect("account", "room", a as any);
			expect(a.destroy).toHaveBeenCalled();
		} finally {
			a.emit("close");
			f.events.close();
		}
	});
});
