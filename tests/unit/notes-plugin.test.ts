import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { parseUiContributions } from "../../server/plugins.js";
import * as S from "../../plugins/notes/client/store.mjs";
import {
	nextCronFire,
	nextFire,
	nextScheduleFire,
	parseCron,
	scheduleText,
	scheduleToCron,
	toLocalInput,
} from "../../plugins/notes/client/cron.mjs";
import notesPlugin from "../../plugins/notes/index.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "notes");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeHost(reuse?: string) {
	const dataDir = reuse ?? mkdtempSync(join(tmpdir(), "pi-notes-data-"));
	const dir = join(dataDir, "plugins", "notes");
	if (!reuse) cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const host = createMockHost({ dataDir, dir });
	return { host, dataDir, dir };
}

async function callRoute(host: any, method: string, path: string, req: any = {}) {
	const route = host.mock.routes.find((r: any) => r.method === method && r.path === path);
	if (!route) throw new Error(`route not found: ${method} ${path}`);
	const res: any = {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: undefined as unknown,
		headersSent: false,
		status(n: number) {
			res.statusCode = n;
			return res;
		},
		setHeader(k: string, v: string) {
			res.headers[k] = v;
		},
		json(v: unknown) {
			res.body = v;
			res.headersSent = true;
			return res;
		},
		send(v: unknown) {
			res.body = v;
			res.headersSent = true;
			return res;
		},
	};
	const request: any = { query: {}, body: undefined, on: () => {}, ...req };
	await route.handler(request, res);
	return res;
}

function storeOf(res: any) {
	return res.body?.store ?? null;
}

describe("notes manifest", () => {
	it("声明了完整能力（ui/http/tools/dom:anchor），无独立视图、靠 preload 常驻", () => {
		expect(manifest.id).toBe("notes");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.view).toBe(false);
		expect(manifest.preload).toBe(true);
		for (const need of ["ui", "http", "tools", "dom:anchor"]) expect(manifest.permissions).toContain(need);
	});

	it("ui 经服务端解析出唯一的顶栏动作条目", () => {
		const parsed = parseUiContributions(manifest.ui) as { items: any[]; arrange: any[] };
		expect(parsed.items).toHaveLength(1);
		const item = parsed.items[0];
		expect(item.slot).toBe("topbar.primary");
		expect(item.kind).toBe("action");
		expect(item.action).toBe("notes:toggle");
		expect(item.label).toBeTruthy();
		expect(item.labelEn).toBeTruthy();
	});
});

describe("notes cron", () => {
	it("五种 schedule 都映射成合法 cron", () => {
		expect(scheduleToCron({ type: "daily", time: "09:00" })).toBe("0 9 * * *");
		expect(scheduleToCron({ type: "weekly", time: "18:30", dow: [1, 5] })).toBe("30 18 * * 1,5");
		expect(scheduleToCron({ type: "monthly", time: "08:15", dom: 15 })).toBe("15 8 15 * *");
		expect(scheduleToCron({ type: "every", minutes: 30 })).toBe("*/30 * * * *");
		expect(scheduleToCron({ type: "every", minutes: 120 })).toBe("0 */2 * * *");
		expect(scheduleToCron({ type: "cron", spec: "*/5 9-18 * * 1-5" })).toBe("*/5 9-18 * * 1-5");
		expect(scheduleToCron({ type: "once", at: "2026-05-05T07:00" })).toBe("0 7 5 5 *");
	});

	it("非法 schedule 一律回 null（不生成会乱响的 cron）", () => {
		expect(scheduleToCron({ type: "daily", time: "24:00" })).toBeNull();
		expect(scheduleToCron({ type: "weekly", time: "09:00", dow: [] })).toBeNull();
		expect(scheduleToCron({ type: "monthly", time: "09:00", dom: 44 })).toBeNull();
		expect(scheduleToCron({ type: "every", minutes: 0 })).toBeNull();
		expect(scheduleToCron({ type: "every", minutes: 90 })).toBeNull();
		expect(scheduleToCron({ type: "cron", spec: "0 9 * *" })).toBeNull();
		expect(scheduleToCron(null)).toBeNull();
	});

	it("every 是真间隔：任意分钟数都合法，cron 只用于「能不能顺手写出来」", () => {
		expect(scheduleToCron({ type: "every", minutes: 5 })).toBe("*/5 * * * *");
		expect(scheduleToCron({ type: "every", minutes: 60 })).toBe("0 * * * *");
		expect(scheduleToCron({ type: "every", minutes: 240 })).toBe("0 */4 * * *");
		expect(scheduleToCron({ type: "every", minutes: 1440 })).toBe("0 0 * * *");
		expect(scheduleToCron({ type: "every", minutes: 90 })).toBeNull();
		expect(scheduleToCron({ type: "every", minutes: 7 })).toBeNull();
		expect(S.normalizeSchedule({ type: "every", minutes: 90 })).toEqual({ type: "every", minutes: 90 });
		expect(S.normalizeSchedule({ type: "every", minutes: 7 })).toEqual({ type: "every", minutes: 7 });
		expect(S.normalizeSchedule({ type: "every", minutes: 0 })).toBeNull();
		expect(S.normalizeSchedule({ type: "every", minutes: 10081 })).toBeNull();
		const base = new Date(2026, 8, 19, 10, 7, 0).getTime();
		expect(nextScheduleFire({ type: "every", minutes: 90 }, base)).toBe(base + 90 * 60_000);
		expect(scheduleText({ type: "every", minutes: 90 })).toBe("每 1 小时 30 分");
		expect(scheduleText({ type: "every", minutes: 1440 })).toBe("每 1 天");
	});

	it("间隔型提醒：相位接着上一次走（不漂），长时间停机一次跳到位", () => {
		const store = S.emptyStore();
		const now = new Date(2026, 8, 19, 10, 7, 0).getTime();
		const rem = S.saveReminder(store, { text: "起身", schedule: { type: "every", minutes: 90 } }, undefined, now).item!;
		expect(rem.nextDue).toBe("2026-09-19T11:37");
		const fired = S.markFired(store, rem.id, new Date(2026, 8, 19, 11, 37).getTime());
		expect(fired.item.nextDue).toBe("2026-09-19T13:07");
		const cur = S.findReminder(store, rem.id)!;
		cur.nextDue = "2026-09-19T13:07";
		const late = S.nextDueStamp(cur, new Date(2026, 8, 19, 18, 20).getTime(), "prev");
		expect(late).toBe("2026-09-19T19:07");
	});

	it("下次触发时间算得对（按本地时区）", () => {
		const from = new Date(2026, 4, 5, 10, 30, 0).getTime();
		expect(new Date(nextFire("0 9 * * *", from)!).getDate()).toBe(6);
		expect(new Date(nextFire("0 9 * * 1", from)!).getDate()).toBe(11);
		const every = new Date(nextFire("*/30 * * * *", from)!);
		expect([every.getHours(), every.getMinutes()]).toEqual([11, 0]);
		expect(nextFire("30 10 * * *", from + 60_000)).toBeGreaterThan(from + 60_000);
		expect(nextCronFire(parseCron("0 0 31 2 *")!, from)).toBeNull();
		expect(nextScheduleFire({ type: "once", at: toLocalInput(from + 3_600_000) }, from)).toBe(
			Math.floor((from + 3_600_000) / 60_000) * 60_000,
		);
	});
});

describe("notes store（纯逻辑）", () => {
	it("归一化：脏元素逐个丢弃、id 去重、超上限按更新时间裁剪", () => {
		const store = S.normalizeStore({
			notes: [{ id: "n1", title: "a" }, null, 42, { id: "n1", title: "dup" }, { title: "no id" }],
			todos: [{ id: "t1", text: "ok" }, { id: "t2" }],
			reminders: [
				{ id: "r1", text: "r", schedule: { type: "daily", time: "09:00" } },
				{ id: "r2", text: "bad" },
			],
			meta: { pending: [{ id: "p1", text: "x" }, { nothing: true }] },
		});
		expect(store.notes.map((n) => n.id)).toEqual(["n1"]);
		expect(store.todos.map((t) => t.id)).toEqual(["t1"]);
		expect(store.reminders.map((r) => r.id)).toEqual(["r1"]);
		expect(store.meta.pending).toHaveLength(1);
		expect(S.normalizeStore("垃圾")).toEqual(S.emptyStore());
	});

	it("待办：增改勾选、重复待办勾选推进截止而不是置完成", () => {
		const store = S.emptyStore();
		const add = S.saveTodo(store, { text: "交周报", due: "2026-03-01T18:00", priority: 2, tags: "工作 重要" });
		expect(add.ok).toBe(true);
		const todo = add.item!;
		expect(todo.tags).toEqual(["工作", "重要"]);
		expect(S.dueState(todo, new Date(2026, 2, 1, 10, 0).getTime())).toBe("today");
		expect(S.dueState(todo, new Date(2026, 2, 2, 10, 0).getTime())).toBe("overdue");
		expect(S.dueState({ due: null }, Date.now())).toBe("none");
		S.toggleTodo(store, todo.id, "2026-03-01T18:01");
		expect(S.findTodo(store, todo.id)!.done).toBe(true);
		S.saveTodo(store, { id: todo.id, done: false, repeat: "monthly" });
		const res = S.toggleTodo(store, todo.id, "2026-03-01T18:02");
		expect(res.advanced).toBe(true);
		expect(S.findTodo(store, todo.id)!.done).toBe(false);
		expect(S.findTodo(store, todo.id)!.due).toBe("2026-04-01T18:00");
	});

	it("counts 只把「今天/逾期未完成」算进 attention", () => {
		const store = S.emptyStore();
		const now = new Date(2026, 4, 5, 12, 0).getTime();
		S.saveTodo(store, { text: "今天", due: "2026-05-05T18:00" });
		S.saveTodo(store, { text: "逾期", due: "2026-05-01T09:00" });
		S.saveTodo(store, { text: "以后", due: "2026-05-20T09:00" });
		S.saveTodo(store, { text: "已完成", due: "2026-05-05T09:00", done: true });
		S.saveTodo(store, { text: "无日期" });
		expect(S.counts(store, now)).toMatchObject({ openTodos: 4, dueTodos: 2, attention: 2 });
		S.saveReminder(store, { text: "吃药", schedule: { type: "daily", time: "09:00" } });
		store.meta.pending.push({ id: "p1", reminderId: "r", text: "吃药", firedAt: "2026-05-05T09:00" });
		expect(S.counts(store, now).attention).toBe(3);
	});

	it("快速捕获：待办认日期/时间/标签/优先级", () => {
		const now = new Date(2026, 4, 5, 10, 0).getTime();
		expect(S.parseQuickTodo("交周报 明天 18:00 #工作 #重要 !!", now)).toEqual({
			text: "交周报",
			due: "2026-05-06T18:00",
			priority: 2,
			tags: ["工作", "重要"],
		});
		expect(S.parseQuickTodo("给妈妈打电话 周五 9点", now)).toMatchObject({
			text: "给妈妈打电话",
			due: "2026-05-08T09:00",
		});
		expect(S.parseQuickTodo("买个键盘", now)).toEqual({ text: "买个键盘", due: null, priority: 0, tags: [] });
	});

	it("快速捕获：提醒认每天/每周/每月/间隔/一次性", () => {
		const now = new Date(2026, 4, 5, 10, 0).getTime();
		expect(S.parseQuickReminder("每天 9:00 吃药", now)).toEqual({
			text: "吃药",
			schedule: { type: "daily", time: "09:00" },
		});
		expect(S.parseQuickReminder("每周五 18:00 复盘", now)).toEqual({
			text: "复盘",
			schedule: { type: "weekly", time: "18:00", dow: [5] },
		});
		expect(S.parseQuickReminder("每月 1 号 9:00 交房租", now)).toEqual({
			text: "交房租",
			schedule: { type: "monthly", time: "09:00", dom: 1 },
		});
		expect(S.parseQuickReminder("每30分钟 起身活动", now)).toEqual({
			text: "起身活动",
			schedule: { type: "every", minutes: 30 },
		});
		expect(S.parseQuickReminder("明天 21:30 交作业", now)).toEqual({
			text: "交作业",
			schedule: { type: "once", at: "2026-05-06T21:30" },
		});
		expect(S.parseQuickReminder("没有时间的内容", now)).toBeNull();
	});

	it("强调触发：一次性自停、稍后提醒触发后还原原档", () => {
		const store = S.emptyStore();
		const rem = S.saveReminder(store, { text: "吃药", schedule: { type: "daily", time: "09:00" } }).item!;
		S.snoozeReminder(store, rem.id, 10, new Date(2026, 4, 5, 10, 0).getTime());
		const snoozed = S.findReminder(store, rem.id)!;
		expect(snoozed.schedule).toEqual({ type: "once", at: "2026-05-05T10:10" });
		const fired = S.markFired(store, rem.id, new Date(2026, 4, 5, 10, 10).getTime());
		expect(fired.pending?.text).toBe("吃药");
		expect(S.findReminder(store, rem.id)!.schedule).toEqual({ type: "daily", time: "09:00" });
		expect(S.findReminder(store, rem.id)!.enabled).toBe(true);
		const once = S.saveReminder(store, { text: "交作业", schedule: { type: "once", at: "2026-05-05T21:00" } }).item!;
		S.markFired(store, once.id, new Date(2026, 4, 5, 21, 0).getTime());
		expect(S.findReminder(store, once.id)!.enabled).toBe(false);
		expect(store.meta.pending).toHaveLength(2);
		expect(S.ackPending(store, [fired.pending!.id])).toBe(1);
		expect(store.meta.pending).toHaveLength(1);
	});

	it("已响过的一次性提醒：markFired 拒绝重复推（扫描与近处定时撞车也只响一次）", () => {
		const store = S.emptyStore();
		const at = "2026-05-05T09:00";
		const rem = S.saveReminder(store, { text: "吃药", schedule: { type: "once", at } }).item!;
		const first = S.markFired(store, rem.id, new Date(2026, 4, 5, 9, 0).getTime());
		expect(first.ok).toBe(true);
		expect(store.meta.pending).toHaveLength(1);
		const again = S.markFired(store, rem.id, new Date(2026, 4, 5, 9, 1).getTime());
		expect(again.ok).toBe(false);
		expect(store.meta.pending).toHaveLength(1);
		expect(S.findReminder(store, rem.id)!.fireCount).toBe(1);
		S.snoozeReminder(store, rem.id, 10, new Date(2026, 4, 5, 10, 0).getTime());
		const res = S.markFired(store, rem.id, new Date(2026, 4, 5, 10, 10).getTime());
		expect(res.ok).toBe(true);
		expect(S.findReminder(store, rem.id)!.enabled).toBe(false);
		expect(S.findReminder(store, rem.id)!.nextDue).toBe(null);
	});

	it("导入：merge 覆盖同 id、replace 整库替换；导出 Markdown 含三类条目", () => {
		const store = S.emptyStore();
		S.saveNote(store, { title: "旧", body: "x" });
		S.saveTodo(store, { text: "a" });
		const incoming = {
			notes: [{ id: "n9", title: "新", body: "y" }],
			todos: [{ id: "t9", text: "b" }],
			reminders: [{ id: "r9", text: "c", schedule: { type: "daily", time: "07:00" } }],
		};
		const merged = S.importStore(store, incoming, "merge");
		expect(merged).toMatchObject({ ok: true, added: 3 });
		expect(store.notes).toHaveLength(2);
		const replaced = S.importStore(store, incoming, "replace");
		expect(replaced.ok).toBe(true);
		expect(store.notes.map((n) => n.id)).toEqual(["n9"]);
		const md = S.toMarkdown(store);
		expect(md).toContain("## 待办");
		expect(md).toContain("新");
		expect(md).toContain("每天 07:00");
		expect(S.importStore(store, { nope: 1 }, "merge").ok).toBe(false);
	});
});

describe("notes 服务端插件", () => {
	it("activate：建库文件、注册路由/工具/命令/持久定时，卸载放行长轮询", async () => {
		const { host, dataDir } = makeHost();
		const deactivate = notesPlugin.activate(host as any) as () => void;
		expect(typeof deactivate).toBe("function");
		expect(existsSync(join(dataDir, "notes", "store.json"))).toBe(true);
		expect(host.mock.calls("route").length).toBeGreaterThanOrEqual(4);
		expect(host.mock.agentTools.map((t: any) => t.name).sort()).toEqual(["notes"]);
		expect(host.mock.commands.map((c: any) => c.name).sort()).toEqual(["note", "notes-mirror", "remind", "todo"]);

		const initial = await callRoute(host, "GET", "/store");
		expect(initial.body.ok).toBe(true);
		expect(storeOf(initial).notes).toEqual([]);

		const noteRes = await callRoute(host, "POST", "/op", {
			body: { op: "note.save", item: { title: "会议要点", body: "1. a" } },
		});
		expect(noteRes.body.result.ok).toBe(true);
		const todoRes = await callRoute(host, "POST", "/op", {
			body: { op: "todo.save", item: { text: "交周报", due: "2026-05-06 18:00" } },
		});
		expect(todoRes.body.result.item.due).toBe("2026-05-06T18:00");
		const remRes = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "吃药", schedule: { type: "daily", time: "09:00" } } },
		});
		const reminder = remRes.body.result.item;
		expect(remRes.body.next[reminder.id]).toBeTruthy();
		expect(host.mock.schedules).toHaveLength(1);
		expect(host.mock.schedules[0]).toMatchObject({ spec: "* * * * *" });
		expect(host.mock.schedules[0].opts).toMatchObject({ persistent: true, catchUp: "once", id: "sweep" });
		expect(reminder.nextDue).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);

		const rev = storeOf(noteRes).meta.rev;
		const pending = callRoute(host, "GET", "/wait", { query: { rev: String(rev) } });
		await new Promise((r) => setTimeout(r, 20));
		await callRoute(host, "POST", "/op", { body: { op: "todo.save", item: { text: "买牛奶" } } });
		const woken = await pending;
		expect(woken.body.unchanged).toBeUndefined();
		expect(storeOf(woken).todos.map((t: any) => t.text)).toContain("买牛奶");
		const immediate = await callRoute(host, "GET", "/wait", { query: { rev: "0" } });
		expect(immediate.body.ok).toBe(true);

		const overdue = new Date(Date.now() - 3_600_000);
		const pad = (n: number) => String(n).padStart(2, "0");
		const overdueStamp = `${overdue.getFullYear()}-${pad(overdue.getMonth() + 1)}-${pad(overdue.getDate())}T${pad(overdue.getHours())}:${pad(overdue.getMinutes())}`;
		await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "喝水", schedule: { type: "once", at: overdueStamp } } },
		});
		const revBefore = (await callRoute(host, "GET", "/store")).body.store.meta.rev;
		await host.mock.fireSchedules();
		const afterFire = await callRoute(host, "GET", "/store");
		expect(afterFire.body.store.meta.pending).toHaveLength(1);
		expect(afterFire.body.store.meta.pending[0].text).toBe("喝水");
		expect(afterFire.body.store.meta.rev).toBeGreaterThan(revBefore);

		const ack = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.ack", ids: [afterFire.body.store.meta.pending[0].id] },
		});
		expect(ack.body.ok).toBe(true);
		expect(ack.body.store.meta.pending).toEqual([]);
		const revAfterAck = ack.body.store.meta.rev;
		const ackAgain = await callRoute(host, "POST", "/op", { body: { op: "reminder.ack", ids: ["nope"] } });
		expect(ackAgain.body.store.meta.rev).toBe(revAfterAck);

		const md = await callRoute(host, "GET", "/export", { query: { format: "md" } });
		expect(String(md.headers["Content-Disposition"])).toContain("notes-");
		expect(String(md.body)).toContain("交周报");

		const hanging = callRoute(host, "GET", "/wait", { query: { rev: String(ackAgain.body.store.meta.rev) } });
		await new Promise((r) => setTimeout(r, 10));
		deactivate();
		const flushed = await hanging;
		expect(flushed.body.unchanged).toBe(true);
		expect(host.mock.schedules).toHaveLength(0);
	});

	it("AI 工具：能记、能改、能勾、能设提醒，并回可读结果", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const tool = (_name?: string) => host.mock.agentTools.find((t: any) => t.name === "notes");

		const added = await tool("notes").execute("id", { op: "note_add", title: "想法", body: "试试看" });
		expect(String(added)).toContain("想法");
		const noteId = /id (n_[\w]+)/.exec(String(added))?.[1];
		expect(noteId).toBeTruthy();

		const listed = await tool("notes").execute("id", { op: "list", kind: "note" });
		expect(String(listed)).toContain("想法");
		expect(String(listed)).toContain(noteId);

		const updated = await tool("notes").execute("id", { op: "note_update", id: noteId, append: "\n补充一句" });
		expect(String(updated)).toContain("已更新");

		const todoOut = await tool("notes").execute("id", {
			op: "todo",
			action: "add",
			text: "交周报",
			due: "2026-06-01 18:00",
			priority: 2,
		});
		expect(String(todoOut)).toContain("已加入待办");
		const todoId = /id (t_[\w]+)/.exec(String(todoOut))?.[1];
		const doneOut = await tool("notes").execute("id", { op: "todo", action: "done", id: todoId });
		expect(String(doneOut)).toContain("已完成");

		const remOut = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "吃药",
			daily_at: "09:00",
		});
		expect(String(remOut)).toContain("每天 09:00");
		const remId = /id (r_[\w]+)/.exec(String(remOut))?.[1];
		const badRem = await tool("notes").execute("id", { op: "reminder", action: "add", text: "x" });
		expect(String(badRem)).toContain("缺少时间");
		const pastRem = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "x",
			at: "2000-01-01 09:00",
		});
		expect(String(pastRem)).toContain("过去的时间");
		const snoozed = await tool("notes").execute("id", { op: "reminder", action: "snooze", id: remId, minutes: 5 });
		expect(String(snoozed)).toContain("已推迟");

		const renamed = await tool("notes").execute("id", {
			op: "reminder",
			action: "update",
			id: remId,
			text: "吃药（饭后）",
		});
		expect(String(renamed)).toContain("已更新提醒");
		const disabled = await tool("notes").execute("id", { op: "reminder", action: "update", id: remId, enabled: false });
		expect(String(disabled)).toContain("已更新提醒");
		const offStore = (await callRoute(host, "GET", "/store")).body.store;
		expect(offStore.reminders.find((r: { id: string }) => r.id === remId).enabled).toBe(false);
		expect(offStore.reminders.find((r: { id: string }) => r.id === remId).nextDue).toBe(null);
		const okEvery = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "每 90 分钟起身",
			every_minutes: 90,
		});
		expect(String(okEvery)).toContain("每 1 小时 30 分");
		const badEvery = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "x",
			every_minutes: 20_000,
		});
		expect(String(badEvery)).toContain("every_minutes");

		const noActionTodo = await tool("notes").execute("id", { op: "todo", text: "顺手记的待办" });
		expect(String(noActionTodo)).toContain("已加入待办");
		const renamedTodo = await tool("notes").execute("id", { op: "todo", id: todoId, text: "交周报（改过）" });
		expect(String(renamedTodo)).toContain("已更新待办");
		const noActionRem = await tool("notes").execute("id", { op: "reminder", text: "顺手记的提醒", daily_at: "07:30" });
		expect(String(noActionRem)).toContain("已设提醒");

		const emptyParamRem = await tool("notes").execute("id", {
			op: "reminder",
			text: "空参数容错提醒",
			cron: "0 9 * * *",
			every_minutes: "",
			at: "",
		});
		expect(String(emptyParamRem)).toContain("已设提醒");

		const agenda = String(await tool("notes").execute("id", { op: "list", kind: "agenda" }));
		expect(agenda).toContain("## 逾期未完成");
		expect(agenda).toContain("## 没有截止时间");
		expect(agenda).toContain("## 接下来的提醒");

		const bad = await tool("notes").execute("id", { op: "note_update", id: "nope", title: "x" });
		expect(String(bad)).toContain("找不到");
	});

	it("一次性提醒：不挂 cron（避开「错过就顺延到明年」），由每分钟扫描补上", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const past = new Date(Date.now() - 3_600_000).toISOString();
		const saved = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "吃药", schedule: { type: "once", at: past.slice(0, 16) } } },
		});
		const onceId = saved.body.result.item.id;
		expect(host.mock.schedules.some((s: any) => s.opts?.id === `rem-${onceId}`)).toBe(false);
		await host.mock.fireSchedules();
		const after = await callRoute(host, "GET", "/store");
		expect(after.body.store.meta.pending.map((p: any) => p.text)).toContain("吃药");
		const rem = after.body.store.reminders.find((r: any) => r.id === onceId);
		expect(rem.enabled).toBe(false);
		expect(rem.fireCount).toBe(1);
		expect(rem.nextDue).toBe(null);
	});

	it("回归：下次触发远超 24.8 天的提醒也不能交给 host.schedule（否则宿主 setTimeout 溢出成死循环）", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const monthly = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "月底汇报", schedule: { type: "monthly", time: "09:00", dom: 31 } } },
		});
		expect(monthly.body.result.ok).toBe(true);
		const yearly = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "元旦", schedule: { type: "cron", spec: "0 9 1 1 *" } } },
		});
		expect(yearly.body.result.ok).toBe(true);
		expect(host.mock.schedules).toHaveLength(1);
		expect(host.mock.schedules[0].spec).toBe("* * * * *");
		expect(monthly.body.result.item.nextDue).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);
		expect(yearly.body.result.item.nextDue).toMatch(/^\d{4}-01-01T09:00$/);
	});

	it("重启/停机：错过的那一次在下次启动时补送，并把 nextDue 推到下一跳", async () => {
		const { host, dataDir } = makeHost();
		const deactivate = notesPlugin.activate(host as any) as () => void;
		const saved = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "吃药", schedule: { type: "daily", time: "09:00" } } },
		});
		const id = saved.body.result.item.id;
		expect(saved.body.result.item.nextDue).toMatch(/T09:00$/);
		expect(host.mock.schedules[0].spec).toBe("* * * * *");
		deactivate();

		const file = join(dataDir, "notes", "store.json");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const past = new Date(Date.now() - 7_200_000);
		const pad = (n: number) => String(n).padStart(2, "0");
		raw.reminders.find((r: { id: string }) => r.id === id).nextDue =
			`${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
		writeFileSync(file, JSON.stringify(raw, null, "	"), "utf8");

		const restarted = makeHost(dataDir);
		notesPlugin.activate(restarted.host as any);
		const after = await callRoute(restarted.host, "GET", "/store");
		expect(after.body.store.meta.pending.map((p: { text: string }) => p.text)).toContain("吃药");
		const rem = after.body.store.reminders.find((r: { id: string }) => r.id === id);
		expect(rem.fireCount).toBe(1);
		expect(rem.enabled).toBe(true);
		expect(new Date(rem.nextDue).getTime()).toBeGreaterThan(Date.now() - 60_000);
	});

	it("AI 工具：能记、能改、能勾、能设提醒，并回可读结果", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const tool = (_name?: string) => host.mock.agentTools.find((t: any) => t.name === "notes");

		const added = await tool("notes").execute("id", { op: "note_add", title: "想法", body: "试试看" });
		expect(String(added)).toContain("想法");
		const noteId = /id (n_[\w]+)/.exec(String(added))?.[1];
		expect(noteId).toBeTruthy();

		const listed = await tool("notes").execute("id", { op: "list", kind: "note" });
		expect(String(listed)).toContain("想法");
		expect(String(listed)).toContain(noteId);

		const updated = await tool("notes").execute("id", { op: "note_update", id: noteId, append: "\n补充一句" });
		expect(String(updated)).toContain("已更新");

		const todoOut = await tool("notes").execute("id", {
			op: "todo",
			action: "add",
			text: "交周报",
			due: "2026-06-01 18:00",
			priority: 2,
		});
		expect(String(todoOut)).toContain("已加入待办");
		const todoId = /id (t_[\w]+)/.exec(String(todoOut))?.[1];
		const doneOut = await tool("notes").execute("id", { op: "todo", action: "done", id: todoId });
		expect(String(doneOut)).toContain("已完成");

		const remOut = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "吃药",
			daily_at: "09:00",
		});
		expect(String(remOut)).toContain("每天 09:00");
		const remId = /id (r_[\w]+)/.exec(String(remOut))?.[1];
		const badRem = await tool("notes").execute("id", { op: "reminder", action: "add", text: "x" });
		expect(String(badRem)).toContain("缺少时间");
		const pastRem = await tool("notes").execute("id", {
			op: "reminder",
			action: "add",
			text: "x",
			at: "2000-01-01 09:00",
		});
		expect(String(pastRem)).toContain("过去的时间");
		const snoozed = await tool("notes").execute("id", { op: "reminder", action: "snooze", id: remId, minutes: 5 });
		expect(String(snoozed)).toContain("已推迟");

		const bad = await tool("notes").execute("id", { op: "note_update", id: "nope", title: "x" });
		expect(String(bad)).toContain("找不到");
	});

	it("一次性提醒：不挂 cron（避开「错过就顺延到明年」），由每分钟扫描补上", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const past = new Date(Date.now() - 3_600_000).toISOString();
		const saved = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "吃药", schedule: { type: "once", at: past.slice(0, 16) } } },
		});
		const onceId = saved.body.result.item.id;
		expect(host.mock.schedules.some((s: any) => s.opts?.id === `rem-${onceId}`)).toBe(false);
		await host.mock.fireSchedules();
		const after = await callRoute(host, "GET", "/store");
		expect(after.body.store.meta.pending.map((p: any) => p.text)).toContain("吃药");
		const rem = after.body.store.reminders.find((r: any) => r.id === onceId);
		expect(rem.enabled).toBe(false);
		expect(rem.fireCount).toBe(1);
		expect(rem.nextDue).toBe(null);
	});

	it("回归：下次触发远超 24.8 天的提醒也不能交给 host.schedule（否则宿主 setTimeout 溢出成死循环）", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const monthly = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "月底汇报", schedule: { type: "monthly", time: "09:00", dom: 31 } } },
		});
		expect(monthly.body.result.ok).toBe(true);
		const yearly = await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "元旦", schedule: { type: "cron", spec: "0 9 1 1 *" } } },
		});
		expect(yearly.body.result.ok).toBe(true);
		expect(host.mock.schedules).toHaveLength(1);
		expect(host.mock.schedules[0].spec).toBe("* * * * *");
		expect(monthly.body.result.item.nextDue).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);
		expect(yearly.body.result.item.nextDue).toMatch(/^\d{4}-01-01T09:00$/);
	});

	it("Markdown 镜像：单向导出到指定目录，只清理自己索引里记过的文件", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-notes-mirror-"));
		cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
		const dir = join(dataDir, "plugins", "notes");
		const vault = join(dataDir, "vault");
		mkdirSync(vault, { recursive: true });
		const files = new Map<string, string>();
		const removed: string[] = [];
		const host = createMockHost({
			dataDir,
			dir,
			settings: { mirrorEnabled: true, mirrorDir: vault },
			fs: {
				authorizedDirs: () => [vault],
				requestAccess: async () => true,
				mkdirPath: async () => {},
				writePath: async (p: string, data: string) => {
					files.set(p, String(data));
				},
				readTextPath: async (p: string) => {
					if (!files.has(p)) throw new Error("ENOENT");
					return files.get(p)!;
				},
				removePath: async (p: string) => {
					removed.push(p);
					files.delete(p);
				},
			},
		});
		notesPlugin.activate(host as any);
		await callRoute(host, "POST", "/op", {
			body: { op: "note.save", item: { title: "会议要点", body: "1. 排期", tags: ["工作"] } },
		});
		await callRoute(host, "POST", "/op", {
			body: { op: "todo.save", item: { text: "交周报", due: "2026-06-01 18:00" } },
		});
		await callRoute(host, "POST", "/op", {
			body: { op: "reminder.save", item: { text: "吃药", schedule: { type: "daily", time: "09:00" } } },
		});
		const cmd = host.mock.commands.find((c: any) => c.name === "notes-mirror");
		expect(String(await cmd.run("", {}))).toContain("已同步到");
		const names = [...files.keys()].map((p: string) => p.slice(vault.length + 1));
		expect(names.some((n) => n.startsWith("会议要点-"))).toBe(true);
		expect(names).toContain("_todos.md");
		expect(names).toContain("_reminders.md");
		expect(names).toContain(".pi-notes-mirror.json");
		const noteFile = [...files.entries()].find(([p]) => p.includes("会议要点"))!;
		expect(noteFile[1]).toContain("tags: [工作]");
		expect(noteFile[1]).toContain("# 会议要点");
		expect(noteFile[1]).toContain("1. 排期");
		expect(files.get(join(vault, "_todos.md"))).toContain("- [ ] 交周报");
		expect(files.get(join(vault, "_reminders.md"))).toContain("每天 09:00");

		const noteId = (await callRoute(host, "GET", "/store")).body.store.notes[0].id;
		await callRoute(host, "POST", "/op", { body: { op: "note.remove", id: noteId } });
		await cmd.run("", {});
		expect(removed.some((p) => p.includes("会议要点"))).toBe(true);
		expect(files.has(join(vault, "_todos.md"))).toBe(true);

		const before = files.size;
		host.mock.setSettings({ mirrorEnabled: false });
		await cmd.run("", {});
		expect(files.size).toBe(before);
	});

	it("Markdown 镜像：目录没授权时不硬写（要一次授权，拒绝就停手）", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-notes-mirror2-"));
		cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
		const vault = join(dataDir, "vault");
		let asked = 0;
		let wrote = 0;
		const host = createMockHost({
			dataDir,
			dir: join(dataDir, "plugins", "notes"),
			settings: { mirrorEnabled: true, mirrorDir: vault },
			fs: {
				authorizedDirs: () => [],
				requestAccess: async () => {
					asked++;
					return false;
				},
				mkdirPath: async () => {},
				writePath: async () => {
					wrote++;
				},
				readTextPath: async () => {
					throw new Error("ENOENT");
				},
				removePath: async () => {},
			},
		});
		notesPlugin.activate(host as any);
		const cmd = host.mock.commands.find((c: any) => c.name === "notes-mirror");
		await cmd.run("", {});
		expect(asked).toBe(1);
		expect(wrote).toBe(0);
		vi.useFakeTimers();
		try {
			await callRoute(host, "POST", "/op", { body: { op: "note.save", item: { title: "随便一条" } } });
			await vi.advanceTimersByTimeAsync(4000);
		} finally {
			vi.useRealTimers();
		}
		expect(asked).toBe(1);
		expect(wrote).toBe(0);
		host.mock.setSettings({ mirrorDir: "relative/path" });
		await callRoute(host, "POST", "/op", { body: { op: "note.save", item: { title: "再来一条" } } });
		await cmd.run("", {});
		expect(wrote).toBe(0);
	});

	it("斜杠命令：/note /todo /remind 落库并回执", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		const run = (name: string, args: string) => host.mock.commands.find((c: any) => c.name === name).run(args);
		expect(String(await run("note", "记一句话"))).toContain("已记到笔记");
		expect(String(await run("note", ""))).toContain("用法");
		const todo = String(await run("todo", "交周报 明天 18:00 #工作"));
		expect(todo).toContain("已加入待办");
		expect(todo).toContain("#工作");
		expect(String(await run("remind", "每天 9:00 吃药"))).toContain("每天 09:00");
		expect(String(await run("remind", "没时间"))).toContain("没读懂时间");
	});

	it("坏库文件被隔离、绝不用空库覆盖（数据可恢复）", async () => {
		const { host, dataDir } = makeHost();
		const dir = join(dataDir, "notes");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "store.json");
		writeFileSync(file, '{"notes":[{"id":"n1","title":"重要的东西"', "utf8");
		notesPlugin.activate(host as any);
		const { readdirSync } = await import("node:fs");
		const quarantined = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(dir, quarantined[0]!), "utf8")).toContain("重要的东西");
		const res = await callRoute(host, "GET", "/store");
		expect(res.body.store.todos).toEqual([]);
	});

	it("导入：垃圾 JSON 直接拒绝（不烧掉唯一一份备份），merge 保持文件里的顺序", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);
		await callRoute(host, "POST", "/op", { body: { op: "note.save", item: { title: "现有" } } });
		const bad = await callRoute(host, "POST", "/op", {
			body: { op: "store.import", store: { nope: 1 }, mode: "merge" },
		});
		expect(bad.body.ok).toBe(false);
		expect(String(bad.body.error)).toContain("没有可导入的条目");
		const { existsSync: exists } = await import("node:fs");
		expect(exists(join(host.dataDir, "notes", "store.json.bak"))).toBe(false);
		const okRes = await callRoute(host, "POST", "/op", {
			body: {
				op: "store.import",
				mode: "merge",
				store: {
					notes: [
						{ id: "a", title: "一" },
						{ id: "b", title: "二" },
						{ id: "c", title: "三" },
					],
				},
			},
		});
		expect(okRes.body.result).toMatchObject({ added: 3, skipped: 0 });
		expect(okRes.body.store.notes.map((n: { title: string }) => n.title)).toEqual(["一", "二", "三", "现有"]);
	});

	it("库里的坏文件不会让插件起不来（当空库处理，不回写覆盖）", async () => {
		const { host, dataDir } = makeHost();
		const dir = join(dataDir, "notes");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "store.json"), "{ 这不是 JSON", "utf8");
		expect(() => notesPlugin.activate(host as any)).not.toThrow();
		const res = await callRoute(host, "GET", "/store");
		expect(res.body.ok).toBe(true);
		expect(storeOf(res).todos).toEqual([]);
	});

	it("现代闪念笔记：无标题直接记录文字，自动提取第一行，支持额外设置提醒并与调度器联动", async () => {
		const { host } = makeHost();
		notesPlugin.activate(host as any);

		const saved1 = await callRoute(host, "POST", "/op", {
			body: {
				op: "note.save",
				item: {
					body: "# 灵感记录\n这是一段详细的想法描述。\n第二行。",
				},
			},
		});
		expect(saved1.body.ok).toBe(true);
		expect(saved1.body.result.item.title).toBe("灵感记录");
		expect(saved1.body.result.item.body).toContain("详细的想法描述");

		const stamp = "2026-05-20T09:00";
		const saved2 = await callRoute(host, "POST", "/op", {
			body: {
				op: "note.save",
				item: {
					body: "找张三拿合同",
					reminder: {
						schedule: { type: "once", at: stamp },
						enabled: true,
					},
				},
			},
		});
		expect(saved2.body.ok).toBe(true);
		const note2 = saved2.body.result.item;
		expect(note2.title).toBe("找张三拿合同");
		expect(note2.reminder).toBeTruthy();
		expect(note2.reminder.schedule.type).toBe("once");

		const storeRes = await callRoute(host, "GET", "/store");
		const linkRem = storeRes.body.store.reminders.find((r: any) => r.noteId === note2.id);
		expect(linkRem).toBeTruthy();
		expect(linkRem.text).toBe("找张三拿合同");
		expect(linkRem.schedule.at).toBe(stamp);

		const delRes = await callRoute(host, "POST", "/op", {
			body: { op: "note.delete", id: note2.id },
		});
		expect(delRes.body.ok).toBe(true);
		const afterDel = await callRoute(host, "GET", "/store");
		expect(afterDel.body.store.notes.some((n: any) => n.id === note2.id)).toBe(false);
		expect(afterDel.body.store.reminders.some((r: any) => r.noteId === note2.id)).toBe(false);
	});

	it("纯函数：detectTimeFromText 文本时间嗅探", async () => {
		const { detectTimeFromText, extractTitle } = await import("../../plugins/notes/client/store.mjs");
		expect(extractTitle("")).toBe("");
		expect(extractTitle("  \n## 架构设计大纲\n详细内容")).toBe("架构设计大纲");
		expect(extractTitle("- [ ] 完成周报")).toBe("[ ] 完成周报");

		const now = new Date(2026, 2, 26, 12, 0, 0, 0).getTime();
		const res = detectTimeFromText("明天 18:00 开会", now);
		expect(res).toBeTruthy();
		expect(res?.stamp).toContain("2026-03-27T18:00");
		expect(res?.timeLabel).toContain("明天 18:00");
	});
});
