import { describe, expect, it } from "vitest";
import { attachIntentCwd, noteSent, normalizeCwdPath, settleIntent } from "../../web/src/pending-workspace.js";
import type { ClientMessage } from "../../web/src/types.js";

const NOW = 1_700_000_000_000;

describe("待确认的目标工作目录（客户端单一意图源）", () => {
	it("set_cwd 记下目标，其它消息不动意图", () => {
		let pending = noteSent(null, { type: "set_cwd", path: "E:\\work\\project-a" }, NOW);
		expect(pending).toEqual({ path: "E:\\work\\project-a", at: NOW });
		pending = noteSent(pending, { type: "list_sessions" }, NOW + 10);
		expect(pending).toEqual({ path: "E:\\work\\project-a", at: NOW });
	});

	it("紧随其后的 new_chat 补上意图 cwd（路径大小写 / 尾斜杠不影响判断）", () => {
		const pending = noteSent(null, { type: "set_cwd", path: "E:\\work\\project-a" }, NOW);
		const msg = attachIntentCwd({ type: "new_chat" }, pending, "e:/WORK/project-b/", NOW + 5);
		expect(msg).toEqual({ type: "new_chat", cwd: "E:\\work\\project-a" });
	});

	it("已经到位 / 消息自带 cwd / 意图过期时都不补", () => {
		const pending = noteSent(null, { type: "set_cwd", path: "/work/a" }, NOW);
		expect(attachIntentCwd({ type: "new_chat" }, pending, "/work/a/", NOW + 5)).toEqual({ type: "new_chat" });
		expect(attachIntentCwd({ type: "new_chat", cwd: "/work/b" }, pending, "/work/c", NOW + 5)).toEqual({
			type: "new_chat",
			cwd: "/work/b",
		});
		expect(attachIntentCwd({ type: "new_chat" }, pending, "/work/c", NOW + 15_001)).toEqual({ type: "new_chat" });
		expect(attachIntentCwd({ type: "new_chat" }, null, "/work/c", NOW)).toEqual({ type: "new_chat" });
	});

	it("非 new_chat 的消息不挂 cwd", () => {
		const pending = noteSent(null, { type: "set_cwd", path: "/work/a" }, NOW);
		const msg: ClientMessage = { type: "list_projects" };
		expect(attachIntentCwd(msg, pending, "/work/b", NOW + 5)).toBe(msg);
	});

	it("快照落到目标目录就清掉意图，落到别处则保留", () => {
		const pending = noteSent(null, { type: "set_cwd", path: "/work/a" }, NOW);
		expect(settleIntent(pending, { kind: "snapshot", cwd: "/work/a/" })).toBeNull();
		expect(settleIntent(pending, { kind: "snapshot", cwd: "/work/b" })).toEqual(pending);
	});

	it("cwd 过渡以 done / error 收尾才清，中间阶段不清", () => {
		const pending = noteSent(null, { type: "set_cwd", path: "/work/a" }, NOW);
		const mid = { kind: "transition", transitionKind: "cwd", phase: "fs", target: "/work/a" } as const;
		expect(settleIntent(pending, mid)).toEqual(pending);
		expect(settleIntent(pending, { ...mid, phase: "done" })).toBeNull();
		expect(settleIntent(pending, { ...mid, phase: "error" })).toBeNull();
		expect(
			settleIntent(pending, { kind: "transition", transitionKind: "new_chat", phase: "done", target: "/work/a" }),
		).toEqual(pending);
	});

	it("路径归一：盘符大小写、反斜杠、尾斜杠一致", () => {
		expect(normalizeCwdPath("E:\\Work\\Project\\")).toBe("e:/work/project");
		expect(normalizeCwdPath("/work/project///")).toBe("/work/project");
		expect(normalizeCwdPath(undefined)).toBe("");
	});
});
