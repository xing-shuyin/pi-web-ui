// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { desktopFilesBridge } from "../../server/device-center/desktop-files-bridge.js";

it("binds the trusted manager to one remote document and rejects stale requests after switching devices", async () => {
	const frame = document.createElement("iframe"),
		stranger = document.createElement("iframe");
	document.body.append(frame, stranger);
	const remotes: any[] = [],
		popups: any[] = [],
		manager = vi.fn((remote: any) => {
			remotes.push(remote);
			const popup = { open: vi.fn(), close: vi.fn() };
			popups.push(popup);
			return popup as any;
		});
	const bridge = desktopFilesBridge({ frame: () => frame.contentWindow, origin: "null", nested: false, manager });
	const emit = (data: any, source: any = frame.contentWindow) =>
		window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data }));
	try {
		emit({ type: "desktop-files-show", target: "a".repeat(32) }, stranger.contentWindow);
		expect(manager).not.toHaveBeenCalled();
		emit({ type: "desktop-files-call", path: "local/files/exports", method: "POST", body: { paths: ["secrets"] } });
		expect(manager).not.toHaveBeenCalled();
		emit({ type: "desktop-files-show", target: "a".repeat(32) });
		expect(manager).toHaveBeenCalledOnce();
		const sent = vi.spyOn(frame.contentWindow!, "postMessage");
		const pending = remotes[0]("info");
		const rejected = expect(pending).rejects.toThrow("Remote device changed");
		expect(sent).toHaveBeenCalledOnce();
		emit({ type: "desktop-files-target", target: "b".repeat(32) });
		await rejected;
		expect(popups[0].close).toHaveBeenCalledOnce();
		await expect(remotes[0]("exports", "POST", { paths: ["old selection"] })).rejects.toThrow("Remote device changed");
		expect(sent).toHaveBeenCalledOnce();
		emit({ type: "desktop-files-show", target: "b".repeat(32) });
		expect(manager).toHaveBeenCalledTimes(2);
	} finally {
		bridge.close();
		frame.remove();
		stranger.remove();
		vi.restoreAllMocks();
	}
});
