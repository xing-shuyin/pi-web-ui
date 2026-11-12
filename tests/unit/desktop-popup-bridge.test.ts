import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { desktopPopupBridge } from "../../server/device-center/desktop-popup-bridge.js";

function bridge(target = `https://hub.example/device/device1/__open?ticket=${"b".repeat(64)}`, blocked = false) {
	const replace = vi.fn(),
		close = vi.fn(),
		reply = vi.fn();
	const tab = { location: { replace }, close, closed: false, opener: {} };
	const open = vi.fn(() => (blocked ? null : tab));
	const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ url: target }) }));
	const child = { postMessage: reply };
	let receive: (event: unknown) => void = () => {};
	runInNewContext(desktopPopupBridge(`https://hub.example/device/device1/__relay/${"a".repeat(64)}/__desktop_open`), {
		frame: { contentWindow: child },
		window: { open },
		URL,
		AbortSignal,
		fetch,
		addEventListener: (_type: string, listener: typeof receive) => {
			receive = listener;
		},
	});
	const message = {
		source: child,
		origin: "null",
		data: { type: "device-desktop-open", requestId: "12345678-1234-1234-1234-123456789abc" },
	};
	return { receive, message, open, fetch, replace, close, reply, tab };
}

it("ignores forged messages and never navigates to a supplied remote URL", async () => {
	const b = bridge("https://hub.example/device/device2/__open?ticket=" + "b".repeat(64));
	b.receive({ ...b.message, source: {} });
	b.receive({ ...b.message, origin: "https://evil.example" });
	expect(b.open).not.toHaveBeenCalled();
	b.receive(b.message);
	await vi.waitFor(() => expect(b.close).toHaveBeenCalled());
	expect(b.replace).not.toHaveBeenCalled();
	expect(b.reply.mock.calls[0][0].ok).toBe(false);
});

it("reports blocked popups without obtaining a ticket and isolates successful windows", async () => {
	const blocked = bridge(undefined, true);
	blocked.receive(blocked.message);
	expect(blocked.fetch).not.toHaveBeenCalled();
	expect(blocked.reply.mock.calls[0][0].error).toBe("popup");
	const b = bridge();
	b.receive(b.message);
	b.receive(b.message);
	await vi.waitFor(() => expect(b.replace).toHaveBeenCalled());
	expect(b.open).toHaveBeenCalledTimes(1);
	expect(b.tab.opener).toBeNull();
	expect(b.replace.mock.calls[0][0]).toContain("&next=%2Fdesktop");
	expect(b.reply.mock.calls[0][0].ok).toBe(true);
});
