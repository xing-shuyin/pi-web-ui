import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	showBanner,
	dismissBanner,
	dismissBannersWhere,
	clearAllBanners,
	getBanners,
	subscribeBanners,
} from "../../web/src/banner-notice.js";

describe("banner-notice store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearAllBanners();
	});

	afterEach(() => {
		clearAllBanners();
		vi.useRealTimers();
	});

	it("showBanner 可以弹出常驻横幅（persistent: true 不会自动关闭）", () => {
		const id = showBanner({
			id: "banner-1",
			title: "对话 A",
			message: "请选择选项",
			persistent: true,
		});

		expect(id).toBe("banner-1");
		expect(getBanners()).toHaveLength(1);
		expect(getBanners()[0].title).toBe("对话 A");
		expect(getBanners()[0].persistent).toBe(true);

		vi.advanceTimersByTime(10000);
		expect(getBanners()).toHaveLength(1);
	});

	it("showBanner 默认短暂横幅会在 timeoutMs 后自动关闭", () => {
		showBanner({
			id: "transient-1",
			title: "提示",
			message: "操作完成",
			timeoutMs: 3000,
		});

		expect(getBanners()).toHaveLength(1);

		vi.advanceTimersByTime(2000);
		expect(getBanners()).toHaveLength(1);

		vi.advanceTimersByTime(1100);
		expect(getBanners()).toHaveLength(0);
	});

	it("dismissBanner 可以主动关闭指定横幅并触发 onClose", () => {
		const onClose = vi.fn();
		showBanner({
			id: "banner-to-close",
			title: "对话 B",
			message: "问卷",
			persistent: true,
			onClose,
		});

		expect(getBanners()).toHaveLength(1);

		dismissBanner("banner-to-close");

		expect(getBanners()).toHaveLength(0);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("同 id 横幅就地更新内容而不是新增", () => {
		showBanner({
			id: "same-id",
			title: "旧标题",
			message: "旧消息",
			persistent: true,
		});
		expect(getBanners()).toHaveLength(1);
		expect(getBanners()[0].title).toBe("旧标题");

		showBanner({
			id: "same-id",
			title: "新标题",
			message: "新消息",
			persistent: true,
		});
		expect(getBanners()).toHaveLength(1);
		expect(getBanners()[0].title).toBe("新标题");
		expect(getBanners()[0].message).toBe("新消息");
	});

	it("多个不同对话的横幅相互独立：移除一个不影响其他对话的横幅", () => {
		showBanner({
			id: "question-conv-1",
			type: "question",
			title: "对话 1",
			message: "问卷 1",
			persistent: true,
			data: { conversationId: "conv-1" },
		});

		showBanner({
			id: "question-conv-2",
			type: "question",
			title: "对话 2",
			message: "问卷 2",
			persistent: true,
			data: { conversationId: "conv-2" },
		});

		expect(getBanners()).toHaveLength(2);

		dismissBanner("question-conv-1");

		const remaining = getBanners();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("question-conv-2");
		expect(remaining[0].title).toBe("对话 2");
	});

	it("dismissBannersWhere 可以按条件批量移除横幅", () => {
		showBanner({
			id: "b1",
			message: "m1",
			data: { conversationId: "conv-1" },
		});
		showBanner({
			id: "b2",
			message: "m2",
			data: { conversationId: "conv-2" },
		});
		showBanner({
			id: "b3",
			message: "m3",
			data: { conversationId: "conv-1" },
		});

		expect(getBanners()).toHaveLength(3);

		dismissBannersWhere((b) => b.data?.conversationId === "conv-1");

		const remaining = getBanners();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("b2");
	});

	it("subscribeBanners 会在增删横幅时触发回调", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeBanners(listener);

		showBanner({ id: "sub-1", message: "test" });
		expect(listener).toHaveBeenCalledTimes(1);

		dismissBanner("sub-1");
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
		showBanner({ id: "sub-2", message: "test2" });
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
