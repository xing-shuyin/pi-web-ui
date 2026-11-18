import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDeviceGroupRefresh,
	deviceGroupErrorKind,
	deviceGroupRequest,
	DeviceGroupRequestError,
	type SidebarDeviceGroup,
} from "../../web/src/components/DeviceGroupSection";

const room: SidebarDeviceGroup = { id: "one", name: "One", botIds: [] };
const drain = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

afterEach(() => vi.unstubAllGlobals());

describe("device group sidebar refresh ownership", () => {
	it("coalesces changes into one fresh read, discarding the stale result", async () => {
		const pending: ((rooms: SidebarDeviceGroup[]) => void)[] = [];
		const load = vi.fn(() => new Promise<SidebarDeviceGroup[]>((resolve) => pending.push(resolve)));
		const result = vi.fn();
		const error = vi.fn();
		const poll = createDeviceGroupRefresh(load, result, error);
		poll.refresh();
		poll.refresh();
		poll.refresh();
		expect(load).toHaveBeenCalledTimes(1);
		pending[0]([room]);
		await drain();
		expect(result).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(2);
		pending[1]([{ ...room, name: "Updated" }]);
		await drain();
		expect(result).toHaveBeenCalledWith([{ ...room, name: "Updated" }]);
		expect(error).not.toHaveBeenCalled();
		poll.stop();
	});

	it("aborts hidden-page reads and restarts after they settle without overlap", async () => {
		let reject!: (error: Error) => void;
		const load = vi.fn(
			(signal: AbortSignal) =>
				new Promise<SidebarDeviceGroup[]>((_resolve, fail) => {
					reject = fail;
					expect(signal.aborted).toBe(false);
				}),
		);
		const result = vi.fn();
		const error = vi.fn();
		const poll = createDeviceGroupRefresh(load, result, error);
		poll.refresh();
		const signal = load.mock.calls[0][0];
		poll.pause();
		expect(signal.aborted).toBe(true);
		poll.refresh();
		expect(load).toHaveBeenCalledTimes(1);
		reject(new Error("aborted"));
		await drain();
		expect(load).toHaveBeenCalledTimes(2);
		expect(error).not.toHaveBeenCalled();
		poll.stop();
		reject(new Error("aborted"));
		await drain();
	});

	it("does not publish or restart a request after unmount", async () => {
		let resolve!: (rooms: SidebarDeviceGroup[]) => void;
		const load = vi.fn(
			() =>
				new Promise<SidebarDeviceGroup[]>((done) => {
					resolve = done;
				}),
		);
		const result = vi.fn();
		const poll = createDeviceGroupRefresh(load, result, vi.fn());
		poll.refresh();
		poll.refresh();
		poll.stop();
		poll.refresh();
		resolve([room]);
		await drain();
		expect(load).toHaveBeenCalledTimes(1);
		expect(result).not.toHaveBeenCalled();
	});
});

describe("device group sidebar errors", () => {
	it.each(["NOT_PAIRED", "REPAIR_REQUIRED", "DEVICE_CHANGED"])("shows binding guidance for %s", (code) => {
		expect(deviceGroupErrorKind(new DeviceGroupRequestError(409, code))).toBe("bind");
	});

	it("preserves the active-task rejection as a useful localized error", () => {
		expect(deviceGroupErrorKind(new DeviceGroupRequestError(409, "ACTIVE_TASKS"))).toBe("running");
		expect(deviceGroupErrorKind(new DeviceGroupRequestError(403, "HUB_FORBIDDEN"))).toBe("forbidden");
	});

	it("does not expose upstream text or credentials in an error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							code: "HUB_REJECTED",
							error: "secret Hub credential",
							detail: "secret Hub credential",
						}),
						{ status: 502 },
					),
			),
		);
		const error = await deviceGroupRequest("rooms", new AbortController().signal).catch((cause) => cause);
		expect(error).toBeInstanceOf(DeviceGroupRequestError);
		expect(String(error)).not.toContain("secret");
		// hub 通道上的 `detail` 也是上游文本，一律不接。
		expect((error as InstanceType<typeof DeviceGroupRequestError>).detail).toBe("");
		expect(deviceGroupErrorKind(error)).toBe("failed");
	});

	it("keeps the local Bot draft reason so the UI can show why drafting failed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							code: "DRAFT_FAILED",
							error: "400: Model cat-jam-free isn't included in OpenCode Go.",
							detail: "400: Model cat-jam-free isn't included in OpenCode Go.",
						}),
						{ status: 502 },
					),
			),
		);
		const error = await deviceGroupRequest("bot-drafts", new AbortController().signal, { request: "x" }).catch(
			(cause) => cause,
		);
		expect(error).toBeInstanceOf(DeviceGroupRequestError);
		expect((error as InstanceType<typeof DeviceGroupRequestError>).code).toBe("DRAFT_FAILED");
		expect((error as InstanceType<typeof DeviceGroupRequestError>).detail).toContain("isn't included in OpenCode Go");
	});
});
