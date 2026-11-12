import { afterEach, expect, it, vi } from "vitest";
import { createDesktopPreview } from "../../server/device-center/desktop-preview.js";

afterEach(() => {
	vi.useRealTimers();
});
function fixture() {
	vi.useFakeTimers();
	const captures: {
		options: Parameters<Parameters<typeof createDesktopPreview>[0]>[0];
		close: ReturnType<typeof vi.fn>;
	}[] = [];
	const start = vi.fn((options: Parameters<Parameters<typeof createDesktopPreview>[0]>[0]) => {
		const capture = { options, close: vi.fn() };
		captures.push(capture);
		return capture;
	});
	return { preview: createDesktopPreview(start), captures, start };
}
it("shares concurrent requests, caches only fresh frames and stops idle capture", async () => {
	const { preview, captures, start } = fixture();
	const controller = new AbortController();
	const first = preview.read(controller.signal),
		second = preview.read(controller.signal);
	expect(start).toHaveBeenCalledTimes(1);
	expect(captures[0].options).toMatchObject({ readOnly: true, preview: true });
	const jpeg = Buffer.from("jpeg");
	captures[0].options.onFrame(jpeg);
	expect((await first).jpeg).toBe(jpeg);
	expect((await second).jpeg).toBe(jpeg);
	expect((await preview.read(controller.signal)).jpeg).toBe(jpeg);
	await vi.advanceTimersByTimeAsync(6500);
	expect(captures[0].close).toHaveBeenCalledTimes(1);
	preview.close();
});
it("uses live frames without starting another helper and resumes previews after live disconnects", async () => {
	const { preview, captures, start } = fixture();
	const signal = new AbortController().signal;
	const first = preview.read(signal);
	const key = {};
	preview.liveStarted(key);
	expect(captures[0].close).toHaveBeenCalledTimes(1);
	captures[0].options.onFrame(Buffer.from("stale"));
	preview.liveFrame(key, Buffer.from("live"));
	expect((await first).jpeg.toString()).toBe("live");
	await vi.advanceTimersByTimeAsync(3000);
	const second = preview.read(signal);
	expect(start).toHaveBeenCalledTimes(1);
	preview.liveStopped(key);
	expect(start).toHaveBeenCalledTimes(2);
	captures[1].options.onFrame(Buffer.from("preview"));
	expect((await second).jpeg.toString()).toBe("preview");
	preview.close();
});
it("cancels individual requests and rejects all waiters on disable without accepting late frames", async () => {
	const { preview, captures } = fixture();
	const controller = new AbortController();
	const cancelled = expect(preview.read(controller.signal)).rejects.toThrow("cancelled");
	const disabled = expect(preview.read(new AbortController().signal)).rejects.toThrow("stopped");
	controller.abort();
	await cancelled;
	preview.reset();
	await disabled;
	captures[0].options.onFrame(Buffer.from("late"));
	expect(captures[0].close).toHaveBeenCalledTimes(1);
	preview.close();
});
