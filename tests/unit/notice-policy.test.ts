import { describe, expect, it } from "vitest";
import {
	enqueueNotice,
	getNoticeDurationMs,
	MAX_VISIBLE_NOTICES,
	shouldSuppressNotice,
	type NoticeLike,
} from "../../web/src/notice-policy.js";

describe("notice-policy", () => {
	it("returns shorter, tiered durations by level", () => {
		expect(getNoticeDurationMs("info")).toBe(2400);
		expect(getNoticeDurationMs("warning")).toBe(4200);
		expect(getNoticeDurationMs("error")).toBe(6500);
	});

	it("suppresses redundant in-place UI info notices while keeping actionable info/warning/error", () => {
		expect(shouldSuppressNotice({ level: "info", text: "已切换到工作目录：E:\\pi-web-ui" })).toBe(true);
		expect(shouldSuppressNotice({ level: "info", text: "正在切换到工作目录：/srv/app" })).toBe(true);
		expect(shouldSuppressNotice({ level: "info", text: "已在工作目录：/srv/app" })).toBe(true);
		expect(
			shouldSuppressNotice({
				level: "info",
				text: "该项目最近的对话「fix」在另一处开着（当前空闲），为你停在了空白新对话",
			}),
		).toBe(true);
		expect(
			shouldSuppressNotice({
				level: "info",
				text: "分层上下文预算裁剪生效：已释放约 1200 tokens",
			}),
		).toBe(true);
		expect(shouldSuppressNotice({ level: "info", text: "已创建文件：src/a.ts" })).toBe(true);
		expect(shouldSuppressNotice({ level: "info", text: "已重命名当前会话为「新标题」" })).toBe(true);
		expect(shouldSuppressNotice({ level: "info", text: "计划模式已开启" })).toBe(true);

		expect(shouldSuppressNotice({ level: "info", text: "📌 已钉住对话「测试」" })).toBe(false);
		expect(shouldSuppressNotice({ level: "info", text: "已上传：demo.txt" })).toBe(false);
		expect(shouldSuppressNotice({ level: "warning", text: "已在工作目录：/srv/app" })).toBe(false);
		expect(shouldSuppressNotice({ level: "error", text: "切换工作目录失败：路径不是目录" })).toBe(false);
	});

	it("deduplicates identical notices and caps visible queue while protecting error notices", () => {
		const initial: NoticeLike[] = [];
		const afterSuppressed = enqueueNotice(initial, {
			id: 1,
			level: "info",
			text: "已切换到工作目录：/tmp",
		});
		expect(afterSuppressed).toBe(initial);

		const s1 = enqueueNotice(initial, { id: 2, level: "error", text: "连接失败" });
		const s2 = enqueueNotice(s1, { id: 3, level: "info", text: "📌 已钉住对话" });
		expect(s2).toHaveLength(MAX_VISIBLE_NOTICES);

		const s2Dup = enqueueNotice(s2, { id: 4, level: "info", text: "📌 已钉住对话" });
		expect(s2Dup).toEqual([
			{ id: 2, level: "error", text: "连接失败" },
			{ id: 4, level: "info", text: "📌 已钉住对话" },
		]);

		const s3 = enqueueNotice(s2Dup, { id: 5, level: "info", text: "已上传：a.png" });
		expect(s3).toEqual([
			{ id: 2, level: "error", text: "连接失败" },
			{ id: 5, level: "info", text: "已上传：a.png" },
		]);
	});
});
