import { describe, it, expect, vi } from "vitest";
import { nextSearchReqId } from "../../web/src/search-req-id";
import { dismissBanner, dismissBannersWhere, showBanner, getBanners } from "../../web/src/banner-notice";

describe("issue #496: nextSearchReqId", () => {
	it("should allocate unique monotonically increasing reqIds across components", () => {
		const id1 = nextSearchReqId();
		const id2 = nextSearchReqId();
		const id3 = nextSearchReqId();
		expect(id2).toBeGreaterThan(id1);
		expect(id3).toBeGreaterThan(id2);
	});
});

describe("issue #494: banner notice silent dismissal", () => {
	it("should trigger onClose on normal dismiss, but skip onClose on silent dismiss", () => {
		const onClose1 = vi.fn();
		const id1 = showBanner({
			title: "Banner 1",
			message: "Message 1",
			onClose: onClose1,
		});

		dismissBanner(id1, { silent: true });
		expect(onClose1).not.toHaveBeenCalled();

		const onClose2 = vi.fn();
		const id2 = showBanner({
			title: "Banner 2",
			message: "Message 2",
			onClose: onClose2,
		});

		dismissBanner(id2);
		expect(onClose2).toHaveBeenCalledTimes(1);
	});

	it("dismissBannersWhere supports silent option", () => {
		const onClose = vi.fn();
		showBanner({
			id: "batch-1",
			title: "Batch",
			message: "Batch message",
			onClose,
		});

		dismissBannersWhere((b) => b.id === "batch-1", { silent: true });
		expect(onClose).not.toHaveBeenCalled();
		expect(getBanners().some((b) => b.id === "batch-1")).toBe(false);
	});
});
