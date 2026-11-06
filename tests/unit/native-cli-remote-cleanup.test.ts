import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteNativeCliCleanupQueue } from "../../server/native-cli-remote-cleanup.js";

let queue: RemoteNativeCliCleanupQueue;
const cwd = "ssh://user@example.test:22/project";
const first = "/tmp/pi-native-cli-12345678-1234-1234-1234-123456789abc";
const second = "/tmp/pi-native-cli-22345678-1234-1234-1234-123456789abc";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	queue?.dispose();
	vi.useRealTimers();
});

describe("remote CLI staging cleanup retries", () => {
	it("retains failed paths, deduplicates them and stops after a successful reconnect", async () => {
		const cleanup = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
		queue = new RemoteNativeCliCleanupQueue(cleanup);
		const service = {} as any;
		queue.enqueue(service, cwd, [first, first]);
		await vi.advanceTimersByTimeAsync(30000);
		expect(cleanup).toHaveBeenCalledTimes(1);
		queue.enqueue(service, cwd, [first]);
		await vi.advanceTimersByTimeAsync(59000);
		expect(cleanup).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(cleanup).toHaveBeenCalledTimes(2);
		expect(cleanup).toHaveBeenLastCalledWith(service, cwd, [first]);
		await vi.advanceTimersByTimeAsync(3600000);
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
	it("does not delay new cleanup behind an older path backoff and cancels its timer on disposal", async () => {
		const cleanup = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
		queue = new RemoteNativeCliCleanupQueue(cleanup);
		const service = {} as any;
		queue.enqueue(service, cwd, [first]);
		await vi.advanceTimersByTimeAsync(30000);
		queue.enqueue(service, cwd, [second]);
		await vi.advanceTimersByTimeAsync(30000);
		expect(cleanup).toHaveBeenCalledTimes(2);
		expect(cleanup).toHaveBeenLastCalledWith(service, cwd, [second]);
		queue.dispose();
		await vi.advanceTimersByTimeAsync(3600000);
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
});
