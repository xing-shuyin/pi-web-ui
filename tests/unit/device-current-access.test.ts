// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ base: "/" }));
vi.mock("../../web/src/base-url.js", () => ({
	appBase: () => state.base,
	appUrl: (path: string) => state.base + path.replace(/^\//, ""),
}));
import {
	pageDeviceId,
	requestDeviceAccessUrl,
	openPageDesktop,
	getDesktopAccess,
	closeDesktopAccess,
} from "../../web/src/device-access.js";
afterEach(() => {
	const access = getDesktopAccess();
	if (access) closeDesktopAccess(access);
	state.base = "/";
	vi.unstubAllGlobals();
});
it.each(["/device", "/device-lan", "/apps/pi/device-lan"])(
	"uses the current capability for preview and control under %s",
	async (prefix) => {
		state.base = `${prefix}/mac/__relay/${"b".repeat(64)}/`;
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect(pageDeviceId()).toBe("mac");
		for (const preview of [true, false]) {
			const target = await requestDeviceAccessUrl("mac", "", true, false, preview);
			expect(new URL(target.url).pathname).toBe(state.base + (preview ? "desktop-preview" : "desktop"));
			expect(target.transport).toBe("current");
		}
		expect(fetcher).not.toHaveBeenCalled();
	},
);
it("does not mistake the controller or a malformed capability for the remote host", () => {
	for (const base of ["/", "/pi/", "/device/mac/", "/device/mac/__relay/fake/"]) {
		state.base = base;
		expect(pageDeviceId()).toBeUndefined();
	}
});
it("loads the host binding before showing its desktop and respects cancellation", async () => {
	state.base = `/device/mac/__relay/${"b".repeat(64)}/`;
	const controller = new AbortController();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => {
				controller.abort();
				return { hubUrl: "https://hub.example" };
			},
		})),
	);
	await openPageDesktop(false, "Mac", controller.signal);
	expect(getDesktopAccess()).toBeNull();
});
