import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("canvas reference tool loading", () => {
	it("loads on the captured session and conversation when lazy loading is enabled", () => {
		const session = { getActiveToolNames: () => ["canvas"] };
		const conv = { id: "captured" };
		const host = fakeClientSession() as any;
		host.lazyLoadingOn = () => true;
		host.loadLazyTools = vi.fn();
		host.emit = vi.fn();
		host.prepareCanvasReference(session, conv);
		expect(host.loadLazyTools).toHaveBeenCalledWith(session, conv, ["canvas"]);
		expect(host.emit).not.toHaveBeenCalled();
	});
	it("reports a gated tool without overriding settings or permissions", () => {
		const host = fakeClientSession() as any;
		host.lazyLoadingOn = () => false;
		host.loadLazyTools = vi.fn();
		host.emit = vi.fn();
		host.prepareCanvasReference({ getActiveToolNames: () => [] }, { id: "captured" });
		expect(host.loadLazyTools).not.toHaveBeenCalled();
		expect(host.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "warning",
				textEn: expect.stringContaining("Canvas is unavailable"),
			}),
		);
	});
});
