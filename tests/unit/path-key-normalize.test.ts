import { describe, expect, it, vi } from "vitest";
import { normalizePathKey } from "../../server/client-state.js";

describe("normalizePathKey 的跨平台口径", () => {
	it("非 win32 的盘符路径也归一大小写、反斜杠与尾斜杠", () => {
		// CI 跑 ubuntu 时这条分支是自己拼路径：留尾斜杠会让同一个目录出现两个键（cwd 比对 / 缓存 / 去重全分叉）。
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		try {
			expect(normalizePathKey("E:\\work\\project-a\\")).toBe("e:/work/project-a");
			expect(normalizePathKey("E:\\work\\project-a")).toBe(normalizePathKey("e:/WORK/project-a///"));
		} finally {
			platform.mockRestore();
		}
	});

	it("常规路径尾斜杠归一到同一个键；ssh 工作区原样保留", () => {
		expect(normalizePathKey("/work/project/")).toBe(normalizePathKey("/work/project"));
		expect(normalizePathKey("ssh://host/work")).toBe("ssh://host/work");
	});
});
