/**
 * notes 插件的数据模型与全部纯逻辑 —— **服务端与浏览器共用**（所以住在 client/ 下，
 * 见 cron.mjs 顶部说明）。
 *
 * 三样东西一个库：笔记（notes，Markdown 正文）、待办（todos，勾选/优先级/截止/重复）、
 * 提醒（reminders，cron 定时，到点由服务端 host.schedule 触发）。库整体是一个 JSON 对象，
 * 落在 `<dataDir>/notes/store.json`（不放插件目录：`install --force` 更新插件会替换整个
 * 目录，用户数据必须活在外面）。
 *
 * 这里只有纯函数：不碰 fs、不碰 DOM、不看时钟（时间一律由调用方传进来）—— 服务端、
 * 视图、浮窗、AI 工具、单测走的是同一套语义（"同一份计算"）。
 *
 * 数据形状（normalize 后保证）：
 *   note     { id, title, body, tags[], pinned, createdAt, updatedAt }
 *   todo     { id, text, done, doneAt|null, priority 0..3, due|null, repeat, tags[],
 *              noteId|null, createdAt, updatedAt }
 *   reminder { id, text, enabled, schedule, noteId|null, todoId|null, lastFired|null,
 *              fireCount, snoozedFrom|null, createdAt, updatedAt }
 *   meta     { rev, pending[{ id, reminderId, text, firedAt, noteId, todoId }] }
 * 时间字段一律「本地时区的 'YYYY-MM-DDTHH:MM' 串或 ISO 串」（字符串比较即可排序，
 * 与 datetime-local 输入框同形）；`repeat` 是 'none'|'daily'|'weekly'|'monthly'。
 */
import { isSupportedEvery, MIN_EVERY_MINUTES, nextScheduleFire, scheduleText } from "./cron.mjs";

export const STORE_VERSION = 1;

/**
 * 数据形状（JSDoc 只为了给单测/工具里的 TS 提供类型，运行时不参与）。
 *
 * @typedef {object} Note
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {string[]} tags
 * @property {boolean} pinned
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} Todo
 * @property {string} id
 * @property {string} text
 * @property {boolean} done
 * @property {string|null} doneAt
 * @property {number} priority
 * @property {string|null} due
 * @property {string} repeat
 * @property {string[]} tags
 * @property {string|null} noteId
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} PendingItem
 * @property {string} id
 * @property {string} reminderId
 * @property {string} text
 * @property {string} firedAt
 * @property {string|null} [noteId]
 * @property {string|null} [todoId]
 *
 * @typedef {object} Reminder
 * @property {string} id
 * @property {string} text
 * @property {boolean} enabled
 * @property {object} schedule
 * @property {string|null} nextDue
 * @property {string|null} noteId
 * @property {string|null} todoId
 * @property {string|null} lastFired
 * @property {number} fireCount
 * @property {object|null} snoozedFrom
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {{ v: number, notes: Note[], todos: Todo[], reminders: Reminder[], meta: { rev: number, pending: PendingItem[] } }} Store
 */

/** 上限（防手滑粘贴/导入把库撑爆；超出的按时间新的保留）。 */
export const CAPS = {
	notes: 2000,
	todos: 5000,
	reminders: 1000,
	pending: 200,
	body: 400_000,
	text: 4000,
	title: 300,
	tags: 20,
	tagLen: 32,
};

/** 全局唯一 id（前缀便于人眼辨认；不依赖 crypto，浏览器/Node 都能跑）。 */
export function newId(prefix = "x") {
	const rnd = Math.random().toString(36).slice(2, 8);
	return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/** 当前时间 → 'YYYY-MM-DDTHH:MM'（本地时区，与输入框同形的可排序串）。 */
export function nowStamp(ms = Date.now()) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function str(v, max) {
	if (v === undefined || v === null) return "";
	return String(v).slice(0, max);
}

function bool(v) {
	return v === true || v === "true" || v === 1;
}

function num(v, min, max, fallback = 0) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function stamp(v) {
	const s = str(v, 40).trim();
	if (!s) return null;
	const t = new Date(s).getTime();
	if (Number.isNaN(t)) return null;
	// 统一成 'YYYY-MM-DDTHH:MM'（秒/毫秒/时区尾巴都抹掉，字符串排序才可靠）
	return nowStamp(t);
}

function tags(v) {
	const list = Array.isArray(v) ? v : typeof v === "string" ? String(v).split(/[,，\s]+/) : [];
	const out = [];
	for (const raw of list) {
		const t = str(raw, CAPS.tagLen).replace(/^#/, "").trim();
		if (t && !out.includes(t)) out.push(t);
		if (out.length >= CAPS.tags) break;
	}
	return out;
}

const REPEATS = new Set(["none", "daily", "weekly", "monthly"]);

/**
 * 「该响的绝对时间」—— 提醒到点判定的**唯一依据**（持久化在 `reminder.nextDue`）。
 *
 * 为什么不让宿主 cron 当基准：宿主 `host.schedule` 用 `setTimeout(next - now)` 引爆，
 * 而 Node 的 setTimeout 延迟超过 2^31-1ms（≈24.8 天）会溢出成 1ms —— 而宿主的
 * `nextCronFire` 在「一年内找不到」时会回一个 366 天后的哨兵值。于是一条
 * `{type:"monthly", dom:31}`（下次 42 天）或 `0 9 1 1 *`（明年）这种完全合法的提醒
 * 会变成「每秒触发上千次 + 每次同步写盘」的死循环（实测已复现）。
 * 改成自己算：每分钟扫一遍库（一条持久 cron `* * * * *`，一定在安全窗口内），
 * 到点就推 —— 顺便得到「停机期间错过的那一次在下次启动补上」的能力。
 */
export function nextDueStamp(rem, nowMs = Date.now(), anchor = "prev") {
	if (!rem?.enabled) return null;
	// 一次性：就是那个时刻本身（**已经过去也要照发** —— 那是「欠一次」：服务停机期间
	// 错过的、或者用户刚设了一个本分钟内的时刻）。若改用 cron 计算，已过的时刻会被算成
	// 「明年同一天」，补送能力直接没了。
	if (rem.schedule?.type === "once") {
		const at = new Date(rem.schedule.at).getTime();
		return Number.isFinite(at) ? nowStamp(at) : null;
	}
	// 间隔型：**接着上一个到点时刻的相位走**（anchor="prev"，触发后用），这样
	// 「每 90 分钟」不会因为巡检的分钟对齐而慢慢漂；新建/改档位时用 anchor="now"
	// （从现在起算）。停机很久（或把间隔从大改小）时一次跳到未来，不补跑一长串。
	if (rem.schedule?.type === "every") {
		const step = Number(rem.schedule.minutes) * 60_000;
		if (!Number.isFinite(step) || step <= 0) return null;
		const prev = rem.nextDue ? new Date(rem.nextDue).getTime() : Number.NaN;
		const base = anchor === "prev" && Number.isFinite(prev) ? prev : nowMs;
		let next = base + step;
		if (next <= nowMs) next += Math.ceil((nowMs - next) / step) * step;
		return nowStamp(next);
	}
	const ms = nextScheduleFireSafe(rem.schedule, nowMs);
	return ms ? nowStamp(ms) : null;
}

/** 给缺 `nextDue` 的提醒补上（老数据/刚导入/刚启用）；返回补了几条。 */
export function ensureNextDue(store, nowMs = Date.now()) {
	let n = 0;
	for (const rem of store.reminders) {
		if (!rem.enabled) {
			if (rem.nextDue !== null) {
				rem.nextDue = null;
				n++;
			}
			continue;
		}
		if (rem.nextDue) continue;
		rem.nextDue = nextDueStamp(rem, nowMs);
		n++;
	}
	return n;
}

/** 重复档位归一（认不出的回落 none）。 */
export function normalizeRepeat(v) {
	const s = str(v, 20).toLowerCase();
	return REPEATS.has(s) ? s : "none";
}

/** 待办/提醒的重复档位 → 人类文案用的下一跳（纯日期运算，本地时区）。 */
export function advanceDue(dueStamp, repeat, fromMs = Date.now()) {
	const kind = normalizeRepeat(repeat);
	if (kind === "none") return dueStamp;
	const base = dueStamp ? new Date(dueStamp) : new Date(fromMs);
	if (Number.isNaN(base.getTime())) return nowStamp(fromMs);
	let next = new Date(base.getTime());
	for (let i = 0; i < 1; i++) {
		if (kind === "daily") next.setDate(next.getDate() + 1);
		else if (kind === "weekly") next.setDate(next.getDate() + 7);
		else if (kind === "monthly") {
			const day = next.getDate();
			next.setDate(1);
			next.setMonth(next.getMonth() + 1);
			const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
			next.setDate(Math.min(day, last));
		}
	}
	return nowStamp(next.getTime());
}

/** 提醒的 schedule 归一；非法回 null。 */
export function normalizeSchedule(raw) {
	const s = raw && typeof raw === "object" ? raw : null;
	if (!s) return null;
	const type = str(s.type, 20).toLowerCase();
	if (type === "once") {
		const at = stamp(s.at);
		return at ? { type: "once", at } : null;
	}
	if (type === "daily" || type === "weekly" || type === "monthly") {
		const time = /^\d{1,2}:\d{2}$/.test(String(s.time ?? "")) ? str(s.time, 5) : "";
		const hm = /^(\d{1,2}):(\d{2})$/.exec(time);
		if (!hm) return null;
		const h = Number(hm[1]);
		const m = Number(hm[2]);
		if (h > 23 || m > 59) return null;
		const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
		if (type === "daily") return { type: "daily", time: hhmm };
		if (type === "weekly") {
			const dow = (Array.isArray(s.dow) ? s.dow : [s.dow])
				.map((x) => Number(x))
				.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
			if (!dow.length) return null;
			return { type: "weekly", time: hhmm, dow: [...new Set(dow)].sort((a, b) => a - b) };
		}
		const dom = num(s.dom, 1, 31, 0);
		if (!dom) return null;
		return { type: "monthly", time: hhmm, dom };
	}
	if (type === "every") {
		// 真间隔语义：1 分钟 .. 7 天，任意整数都行（到点判定走 nextDue，不依赖 cron 能力）。
		// 越界直接 null（不 clamp —— 把 0 悄悄改成 1 分钟是另一种「设了但不是我想要的」）
		const minutes = Number(s.minutes);
		if (!Number.isInteger(minutes) || !isSupportedEvery(minutes)) return null;
		return { type: "every", minutes };
	}
	if (type === "cron") {
		const spec = str(s.spec, 120).trim().replace(/\s+/g, " ");
		return /^\S+( \S+){4}$/.test(spec) ? { type: "cron", spec } : null;
	}
	return null;
}

export function extractTitle(text) {
	const strText = String(text ?? "").trim();
	if (!strText) return "";
	const lines = strText.split("\n");
	for (const line of lines) {
		const clean = line.replace(/^[#*->\s`]+/, "").trim();
		if (clean) return clean.slice(0, 60);
	}
	return strText.slice(0, 60);
}

/** 空库。 */
export function emptyStore() {
	/** @type {Store} */
	const store = { v: STORE_VERSION, notes: [], todos: [], reminders: [], meta: { rev: 0, pending: [] } };
	return store;
}

function normNote(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = str(raw.id, 60).trim();
	const title = str(raw.title, CAPS.title).trim();
	const body = str(raw.body, CAPS.body);
	if (!id) return null;
	if (!title && !body.trim()) return null;
	const createdAt = stamp(raw.createdAt) ?? nowStamp();
	let reminder = null;
	if (raw.reminder && typeof raw.reminder === "object") {
		const sched = normalizeSchedule(raw.reminder.schedule);
		if (sched) {
			reminder = {
				schedule: sched,
				enabled: raw.reminder.enabled === undefined ? true : bool(raw.reminder.enabled),
				nextDue: stamp(raw.reminder.nextDue),
				lastFired: stamp(raw.reminder.lastFired),
			};
		}
	}
	return {
		id,
		title: title || extractTitle(body) || "未命名笔记",
		body,
		tags: tags(raw.tags),
		pinned: bool(raw.pinned),
		reminder,
		createdAt,
		updatedAt: stamp(raw.updatedAt) ?? createdAt,
	};
}

function normTodo(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = str(raw.id, 60).trim();
	const text = str(raw.text, CAPS.text).trim();
	if (!id || !text) return null;
	const createdAt = stamp(raw.createdAt) ?? nowStamp();
	const done = bool(raw.done);
	return {
		id,
		text,
		done,
		doneAt: done ? (stamp(raw.doneAt) ?? createdAt) : null,
		priority: num(raw.priority, 0, 3, 0),
		due: stamp(raw.due),
		repeat: normalizeRepeat(raw.repeat),
		tags: tags(raw.tags),
		noteId: str(raw.noteId, 60).trim() || null,
		createdAt,
		updatedAt: stamp(raw.updatedAt) ?? createdAt,
	};
}

function normReminder(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = str(raw.id, 60).trim();
	const text = str(raw.text, CAPS.text).trim();
	if (!id || !text) return null;
	const schedule = normalizeSchedule(raw.schedule);
	if (!schedule) return null;
	const createdAt = stamp(raw.createdAt) ?? nowStamp();
	return {
		id,
		text,
		enabled: raw.enabled === undefined ? true : bool(raw.enabled),
		schedule,
		nextDue: stamp(raw.nextDue),
		noteId: str(raw.noteId, 60).trim() || null,
		todoId: str(raw.todoId, 60).trim() || null,
		lastFired: stamp(raw.lastFired),
		fireCount: num(raw.fireCount, 0, 1e9, 0),
		snoozedFrom: normalizeSchedule(raw.snoozedFrom),
		createdAt,
		updatedAt: stamp(raw.updatedAt) ?? createdAt,
	};
}

/**
 * 任意输入 → 合法库（脏元素**逐个丢弃**而不是整库回落：一次导入里坏一条不该毁掉全部）。
 * 同一集合内 id 去重（后来的丢），超过上限按 updatedAt 新的保留。
 *
 * @param {unknown} raw
 * @returns {Store}
 */
export function normalizeStore(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const out = emptyStore();
	const take = (list, norm, cap, sortKey) => {
		const seen = new Set();
		const items = [];
		for (const rawItem of Array.isArray(list) ? list : []) {
			const item = norm(rawItem);
			if (!item || seen.has(item.id)) continue;
			seen.add(item.id);
			items.push(item);
		}
		if (items.length > cap) {
			items.sort((a, b) => String(b[sortKey] ?? "").localeCompare(String(a[sortKey] ?? "")));
			items.length = cap;
		}
		return items;
	};
	out.notes = take(src.notes, normNote, CAPS.notes, "updatedAt");
	out.todos = take(src.todos, normTodo, CAPS.todos, "updatedAt");
	out.reminders = take(src.reminders, normReminder, CAPS.reminders, "updatedAt");
	const meta = src.meta && typeof src.meta === "object" ? src.meta : {};
	out.meta.rev = num(meta.rev, 0, 1e12, 0);
	const pending = [];
	for (const p of Array.isArray(meta.pending) ? meta.pending : []) {
		if (!p || typeof p !== "object") continue;
		const id = str(p.id, 60).trim();
		if (!id) continue;
		pending.push({
			id,
			reminderId: str(p.reminderId, 60).trim(),
			text: str(p.text, CAPS.text).trim(),
			firedAt: stamp(p.firedAt) ?? nowStamp(),
			noteId: str(p.noteId, 60).trim() || null,
			todoId: str(p.todoId, 60).trim() || null,
		});
		if (pending.length >= CAPS.pending) break;
	}
	out.meta.pending = pending;
	return out;
}

/** 版本号 +1（每次真正落盘的改动都调它；长轮询就是靠 rev 变化唤醒的）。 */
export function touch(store) {
	store.meta.rev = num(store.meta.rev, 0, 1e12, 0) + 1;
	return store.meta.rev;
}

// ---------------------------------------------------------------- 笔记

export function findNote(store, id) {
	return store.notes.find((n) => n.id === String(id ?? "")) ?? null;
}

function syncNoteReminder(store, note) {
	const i = store.reminders.findIndex((r) => r.noteId === note.id);
	if (!note.reminder || !note.reminder.schedule) {
		if (i >= 0) store.reminders.splice(i, 1);
		return;
	}
	const text = note.title || extractTitle(note.body) || "未命名笔记";
	const schedule = note.reminder.schedule;
	const enabled = note.reminder.enabled !== false;
	const nextDue = nextDueStamp({ schedule, enabled }, Date.now());
	if (i >= 0) {
		const existing = store.reminders[i];
		existing.text = text;
		existing.schedule = schedule;
		existing.enabled = enabled;
		existing.nextDue = nextDue;
		existing.updatedAt = nowStamp();
	} else {
		if (store.reminders.length < CAPS.reminders) {
			store.reminders.unshift({
				id: newId("r"),
				text,
				enabled,
				schedule,
				nextDue,
				noteId: note.id,
				todoId: null,
				lastFired: null,
				fireCount: 0,
				snoozedFrom: null,
				createdAt: nowStamp(),
				updatedAt: nowStamp(),
			});
		}
	}
}

/** 新建 / 更新笔记（patch.id 命中即更新）。返回 { ok, item?, error? }。 */
export function saveNote(store, patch, at = nowStamp()) {
	const p = patch && typeof patch === "object" ? patch : {};
	const id = str(p.id, 60).trim();
	if (id) {
		const note = findNote(store, id);
		if (!note) return { ok: false, error: `note not found: ${id}` };
		if (p.title !== undefined) note.title = str(p.title, CAPS.title).trim();
		if (p.body !== undefined) note.body = str(p.body, CAPS.body);
		if (p.tags !== undefined) note.tags = tags(p.tags);
		if (p.pinned !== undefined) note.pinned = bool(p.pinned);
		if (!note.title && note.body.trim()) note.title = extractTitle(note.body) || "未命名笔记";
		if (!note.title && !note.body.trim()) return { ok: false, error: "empty note" };
		if (p.reminder !== undefined) {
			if (p.reminder && typeof p.reminder === "object" && p.reminder.schedule) {
				const schedule = normalizeSchedule(p.reminder.schedule);
				if (schedule) {
					const remObj = {
						schedule,
						enabled: p.reminder.enabled !== false,
						nextDue: nextDueStamp({ schedule, enabled: p.reminder.enabled !== false }, Date.now()),
						lastFired: stamp(p.reminder.lastFired),
					};
					note.reminder = remObj;
					syncNoteReminder(store, note);
				}
			} else {
				note.reminder = null;
				syncNoteReminder(store, note);
			}
		} else if (note.reminder) {
			syncNoteReminder(store, note);
		}
		note.updatedAt = at;
		return { ok: true, item: note };
	}
	const body = str(p.body ?? "", CAPS.body);
	const rawTitle = str(p.title ?? "", CAPS.title).trim();
	const title = rawTitle || extractTitle(body) || (body.trim() ? "未命名笔记" : "");
	if (!title && !body.trim()) return { ok: false, error: "note needs content" };
	const created = normNote({
		id: newId("n"),
		title,
		body,
		tags: p.tags,
		pinned: p.pinned,
		reminder: p.reminder,
		createdAt: at,
		updatedAt: at,
	});
	if (!created) return { ok: false, error: "note needs a title or a body" };
	if (store.notes.length >= CAPS.notes) return { ok: false, error: `note limit reached (${CAPS.notes})` };
	if (created.tags.length === 0 && p.tag !== undefined) created.tags = tags(p.tag);
	if (created.reminder) {
		syncNoteReminder(store, created);
	}
	store.notes.unshift(created);
	return { ok: true, item: created };
}

/** 删笔记（同时摘掉指着它的待办/提醒链接，不留悬空引用）。 */
export function removeNote(store, id) {
	const key = String(id ?? "");
	const i = store.notes.findIndex((n) => n.id === key);
	if (i < 0) return false;
	store.notes.splice(i, 1);
	for (const t of store.todos) if (t.noteId === key) t.noteId = null;
	for (let j = store.reminders.length - 1; j >= 0; j--) {
		if (store.reminders[j].noteId === key) {
			store.reminders.splice(j, 1);
		}
	}
	return true;
}

// ---------------------------------------------------------------- 待办

export function findTodo(store, id) {
	return store.todos.find((t) => t.id === String(id ?? "")) ?? null;
}

/** 新建 / 更新待办。返回 { ok, item?, error? }。 */
export function saveTodo(store, patch, at = nowStamp()) {
	const p = patch && typeof patch === "object" ? patch : {};
	const id = str(p.id, 60).trim();
	if (id) {
		const todo = findTodo(store, id);
		if (!todo) return { ok: false, error: `todo not found: ${id}` };
		if (p.text !== undefined) {
			const text = str(p.text, CAPS.text).trim();
			if (!text) return { ok: false, error: "todo text cannot be empty" };
			todo.text = text;
		}
		if (p.done !== undefined) {
			todo.done = bool(p.done);
			todo.doneAt = todo.done ? at : null;
		}
		if (p.priority !== undefined) todo.priority = num(p.priority, 0, 3, todo.priority);
		if (p.due !== undefined) todo.due = stamp(p.due);
		if (p.repeat !== undefined) todo.repeat = normalizeRepeat(p.repeat);
		if (p.tags !== undefined) todo.tags = tags(p.tags);
		if (p.noteId !== undefined) todo.noteId = str(p.noteId, 60).trim() || null;
		todo.updatedAt = at;
		return { ok: true, item: todo };
	}
	const created = normTodo({
		id: newId("t"),
		text: p.text,
		done: p.done,
		priority: p.priority,
		due: p.due,
		repeat: p.repeat,
		tags: p.tags,
		noteId: p.noteId,
		createdAt: at,
		updatedAt: at,
	});
	if (!created) return { ok: false, error: "todo needs text" };
	if (store.todos.length >= CAPS.todos) return { ok: false, error: `todo limit reached (${CAPS.todos})` };
	store.todos.unshift(created);
	return { ok: true, item: created };
}

/**
 * 勾选 / 取消勾选。重复待办（repeat != none）勾选时**不置完成**而是把截止推到下一跳
 * （月租/周报这类「定期要做」的语义；要留历史就新建一条，不做自动复制项）。
 */
export function toggleTodo(store, id, at = nowStamp()) {
	const todo = findTodo(store, id);
	if (!todo) return { ok: false, error: `todo not found: ${id}` };
	if (!todo.done && todo.repeat !== "none") {
		todo.due = advanceDue(todo.due, todo.repeat, new Date(at).getTime());
		todo.updatedAt = at;
		return { ok: true, item: todo, advanced: true };
	}
	todo.done = !todo.done;
	todo.doneAt = todo.done ? at : null;
	todo.updatedAt = at;
	return { ok: true, item: todo };
}

export function removeTodo(store, id) {
	const key = String(id ?? "");
	const i = store.todos.findIndex((t) => t.id === key);
	if (i < 0) return false;
	store.todos.splice(i, 1);
	for (const r of store.reminders) if (r.todoId === key) r.todoId = null;
	return true;
}

// ---------------------------------------------------------------- 提醒

export function findReminder(store, id) {
	return store.reminders.find((r) => r.id === String(id ?? "")) ?? null;
}

/** 新建 / 更新提醒。返回 { ok, item?, error? }。 */
export function saveReminder(store, patch, at = nowStamp(), nowMs = Date.now()) {
	const p = patch && typeof patch === "object" ? patch : {};
	const id = str(p.id, 60).trim();
	const nextSchedule = p.schedule === undefined ? undefined : normalizeSchedule(p.schedule);
	if (p.schedule !== undefined && !nextSchedule) return { ok: false, error: "invalid schedule" };
	if (id) {
		const rem = findReminder(store, id);
		if (!rem) return { ok: false, error: `reminder not found: ${id}` };
		if (p.text !== undefined) {
			const text = str(p.text, CAPS.text).trim();
			if (!text) return { ok: false, error: "reminder text cannot be empty" };
			rem.text = text;
		}
		if (nextSchedule) {
			rem.schedule = nextSchedule;
			rem.snoozedFrom = null; // 手动改时间 = 放弃「稍后提醒」的还原点
		}
		if (p.enabled !== undefined) rem.enabled = bool(p.enabled);
		if (p.noteId !== undefined) rem.noteId = str(p.noteId, 60).trim() || null;
		if (p.todoId !== undefined) rem.todoId = str(p.todoId, 60).trim() || null;
		rem.updatedAt = at;
		// 改过时间/启用状态 → 重算下一次；否那么保留原值（不要让无关编辑把「已到点"推迟）
		if (nextSchedule || p.enabled !== undefined) rem.nextDue = nextDueStamp(rem, nowMs, "now");
		return { ok: true, item: rem };
	}
	const created = normReminder({
		id: newId("r"),
		text: p.text,
		enabled: true,
		schedule: nextSchedule ?? p.schedule,
		noteId: p.noteId,
		todoId: p.todoId,
		createdAt: at,
		updatedAt: at,
	});
	if (!created) return { ok: false, error: "reminder needs text and a valid schedule" };
	if (store.reminders.length >= CAPS.reminders)
		return { ok: false, error: `reminder limit reached (${CAPS.reminders})` };
	created.nextDue = nextDueStamp(created, nowMs, "now");
	store.reminders.unshift(created);
	return { ok: true, item: created };
}

export function removeReminder(store, id) {
	const key = String(id ?? "");
	const i = store.reminders.findIndex((r) => r.id === key);
	if (i < 0) return false;
	store.reminders.splice(i, 1);
	return true;
}

/** 「稍后提醒 N 分钟」：临时把 schedule 换成一次性，并记下原档等着触发后还原。 */
export function snoozeReminder(store, id, minutes = 10, nowMs = Date.now()) {
	const rem = findReminder(store, id);
	if (!rem) return { ok: false, error: `reminder not found: ${id}` };
	const mins = num(minutes, 1, 24 * 60, 10);
	rem.snoozedFrom = rem.snoozedFrom ?? rem.schedule;
	rem.schedule = { type: "once", at: nowStamp(nowMs + mins * 60_000) };
	rem.enabled = true;
	rem.nextDue = nextDueStamp(rem, nowMs, "now");
	rem.updatedAt = nowStamp(nowMs);
	return { ok: true, item: rem };
}

/**
 * 提醒触发后的**数据侧**收尾（时间计算、schedule 还原、待送达队列都在这里，纯函数）：
 * 服务端 host.schedule 的回调里调它 → 拿到要落盘的新状态与本次要送达的内容。
 */
export function markFired(store, id, nowMs = Date.now()) {
	const rem = findReminder(store, id);
	if (!rem) return { ok: false, error: `reminder not found: ${id}` };
	// 同一次发生不重复推：每分钟的扫描与近处精确定时可能同时到点，稍后提醒也会把
	// 已响过的一次性档还原回来（那时 lastFired 已 >= 它自己的时刻）。守卫放这里，
	// 两条触发路径就都安全（放在调用方迟早会漏一条）。
	if (rem.schedule?.type === "once" && rem.lastFired) {
		const dueAt = new Date(rem.schedule.at).getTime();
		if (Number.isFinite(dueAt) && new Date(rem.lastFired).getTime() >= dueAt) {
			return { ok: false, error: "already fired" };
		}
	}
	const at = nowStamp(nowMs);
	rem.lastFired = at;
	rem.fireCount = num(rem.fireCount, 0, 1e9, 0) + 1;
	rem.updatedAt = at;
	// 一次性（或「稍后提醒」的临时档）：触发即停/还原
	if (rem.schedule.type === "once") {
		if (rem.snoozedFrom) {
			rem.schedule = rem.snoozedFrom;
			rem.snoozedFrom = null;
			// 还原档若已经过去（例如给一次性的提醒按了「推迟」），还原出来就是一条永远
			// 不会响还赖在列表里的提醒 —— 直接停用，用户想再要就自己改时间
			const restoredAt = new Date(rem.schedule.at ?? 0).getTime();
			if (rem.schedule.type === "once" && (!Number.isFinite(restoredAt) || restoredAt <= nowMs)) {
				rem.enabled = false;
			}
		} else {
			rem.enabled = false;
		}
	}
	// 下一跳（停用则 null）
	rem.nextDue = nextDueStamp(rem, nowMs);
	if (rem.noteId) {
		const note = findNote(store, rem.noteId);
		if (note?.reminder) {
			note.reminder.lastFired = at;
			note.reminder.enabled = rem.enabled;
			note.reminder.nextDue = rem.nextDue;
		}
	}
	const item = {
		id: newId("p"),
		reminderId: rem.id,
		text: rem.text,
		firedAt: at,
		noteId: rem.noteId,
		todoId: rem.todoId,
	};
	store.meta.pending.push(item);
	if (store.meta.pending.length > CAPS.pending) store.meta.pending.splice(0, store.meta.pending.length - CAPS.pending);
	return { ok: true, item: rem, pending: item };
}

/** 送达确认（浏览器把它见过的提醒回执过来 → 从待送达队列里摘掉）。 */
export function ackPending(store, ids) {
	const list = Array.isArray(ids) ? ids.map((x) => String(x)) : [];
	if (!list.length) return 0;
	const before = store.meta.pending.length;
	const keep = store.meta.pending.filter((p) => !list.includes(p.id));
	store.meta.pending = keep;
	return before - keep.length;
}

// ---------------------------------------------------------------- 查询与统计

/** 一天的毫秒数（本地日历日边界靠 +1 天取整，不用固定 86400000 防夏令时）。 */
function endOfDay(ms) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/** 待办的截止状态：'none' | 'future' | 'today' | 'overdue'（视图用它上色）。 */
export function dueState(todo, nowMs = Date.now()) {
	if (!todo?.due) return "none";
	const t = new Date(todo.due).getTime();
	if (Number.isNaN(t)) return "none";
	if (t < nowMs) return "overdue";
	if (t < endOfDay(nowMs)) return "today";
	return "future";
}

/** 提醒的下次触发毫秒（关掉/非法回 null）。以此为准（服务端扫描与界面显示同一份）。 */
export function reminderFireAt(rem) {
	if (!rem?.enabled || !rem.nextDue) return null;
	const t = new Date(rem.nextDue).getTime();
	return Number.isFinite(t) ? t : null;
}

// 包一层把时钟/cron 的异常吞成 null：视图只是显示「下次」，不该因此崩掉整块列表。
function nextScheduleFireSafe(schedule, nowMs) {
	try {
		return nextScheduleFire(schedule, nowMs);
	} catch {
		return null;
	}
}

/** 列表查询：tab 过滤 + 关键词 + 标签 + 排序。返回的数组是**引用**（视图只读用）。 */
export function searchItems(store, opts = {}) {
	const tab = String(opts.tab ?? "all");
	const q = String(opts.query ?? "")
		.trim()
		.toLowerCase();
	const tag = String(opts.tag ?? "").trim();
	const includeDone = opts.includeDone !== false;
	const hit = (needle) =>
		!q ||
		String(needle ?? "")
			.toLowerCase()
			.includes(q);
	const out = [];
	if (tab === "all" || tab === "note") {
		for (const n of store.notes) {
			if (tag && !n.tags.includes(tag)) continue;
			if (!hit(n.title) && !hit(n.body) && !n.tags.some(hit)) continue;
			out.push(n);
		}
		out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
	}
	if (tab === "all" || tab === "todo") {
		const todos = store.todos.filter((t) => {
			if (!includeDone && t.done) return false;
			if (tag && !t.tags.includes(tag)) return false;
			return hit(t.text) || t.tags.some(hit);
		});
		todos.sort((a, b) => {
			if (a.done !== b.done) return Number(a.done) - Number(b.done);
			const da = a.due ?? "9999";
			const db = b.due ?? "9999";
			if (da !== db) return da.localeCompare(db);
			if (a.priority !== b.priority) return b.priority - a.priority;
			return b.updatedAt.localeCompare(a.updatedAt);
		});
		out.push(...todos);
	}
	if (tab === "all" || tab === "reminder") {
		const rems = store.reminders.filter((r) => !tag || hit(r.text));
		rems.sort((a, b) => {
			if (a.enabled !== b.enabled) return Number(b.enabled) - Number(a.enabled);
			const fa = reminderFireAt(a) ?? Number.MAX_SAFE_INTEGER;
			const fb = reminderFireAt(b) ?? Number.MAX_SAFE_INTEGER;
			if (fa !== fb) return fa - fb;
			return b.updatedAt.localeCompare(a.updatedAt);
		});
		out.push(...rems);
	}
	return out;
}

/** 顶栏/浮窗上的计数：未完成且今天到期或已逾期的待办 + 未送达提醒 + 库总量。 */
export function counts(store, nowMs = Date.now()) {
	let dueTodos = 0;
	let openTodos = 0;
	for (const t of store.todos) {
		if (t.done) continue;
		openTodos++;
		const st = dueState(t, nowMs);
		if (st === "overdue" || st === "today") dueTodos++;
	}
	const pending = store.meta.pending.length;
	return {
		dueTodos,
		openTodos,
		pending,
		attention: dueTodos + pending,
		notes: store.notes.length,
		reminders: store.reminders.filter((r) => r.enabled).length,
	};
}

// ---------------------------------------------------------------- 快速捕获（自然语言）

const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** 'HH:MM' / 'H点' / 'H点半' / 'H点MM分' → {h, m}；没有回 null。 */
function parseTimeText(text) {
	let m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text);
	if (m) {
		const h = Number(m[1]);
		const mi = Number(m[2]);
		if (h <= 23 && mi <= 59) return { h, m: mi, text: m[0] };
	}
	m = /(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/.exec(text);
	if (m) {
		const h = Number(m[1]);
		const mi = m[2] === "半" ? 30 : m[3] ? Number(m[3]) : 0;
		if (h <= 23 && mi <= 59) return { h, m: mi, text: m[0] };
	}
	return null;
}

/** 日期词 → {ms, text}（今天/明天/后天/周X/下周X/M-D）；没有回 null。 */
function parseDateText(text, nowMs) {
	const base = new Date(nowMs);
	const at = (daysAhead) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAhead, 9, 0, 0, 0);
	let m = /(大后天|后天|明天|今天|今日)/.exec(text);
	if (m) {
		const days = { 今天: 0, 今日: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1]];
		return { ms: at(days).getTime(), text: m[0] };
	}
	m = /(下+)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
	if (m) {
		const want = WEEKDAY_CN[m[2]];
		const cur = base.getDay();
		let delta = (want - cur + 7) % 7;
		if (delta === 0) delta = 7; // “周三”说在周三 = 下周三
		if (m[1]) delta += 7 * m[1].length;
		const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta, 9, 0, 0, 0);
		return { ms: d.getTime(), text: m[0] };
	}
	m = /(\d{1,2})\s*[-月/]\s*(\d{1,2})\s*[日号]?/.exec(text);
	if (m) {
		const mo = Number(m[1]);
		const day = Number(m[2]);
		if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
			let d = new Date(base.getFullYear(), mo - 1, day, 9, 0, 0, 0);
			if (d.getTime() < new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0).getTime()) {
				d = new Date(base.getFullYear() + 1, mo - 1, day, 9, 0, 0, 0);
			}
			return { ms: d.getTime(), text: m[0] };
		}
	}
	return null;
}

/**
 * 待办快速输入解析：「交周报 明天 18:00 #工作 !!」→ { text, due, priority, tags }。
 * 只认明确写出的东西，猜不出来的原样留在 text 里（不做「周报」→猜日期 这种事）。
 */
export function parseQuickTodo(input, nowMs = Date.now()) {
	let text = String(input ?? "").trim();
	const out = { text: "", due: null, priority: 0, tags: [] };
	const tagMatches = text.match(/#[^\s#]{1,32}/g) ?? [];
	if (tagMatches.length) {
		out.tags = tagMatches.map((t) => t.slice(1));
		text = text.replace(/#[^\s#]{1,32}/g, " ");
	}
	const pri = /(^|\s)(!{1,3})(?=\s|$)/.exec(text);
	if (pri) {
		out.priority = pri[2].length;
		text = text.replace(pri[0], " ");
	}
	const date = parseDateText(text, nowMs);
	const time = parseTimeText(text);
	if (date || time) {
		const d = new Date(date ? date.ms : nowMs);
		if (time) {
			d.setHours(time.h, time.m, 0, 0);
		} else if (!date) {
			d.setMinutes(0, 0, 0);
			d.setHours(d.getHours() + 1); // 只写了时间：下一个整点
		}
		out.due = nowStamp(d.getTime());
		if (date) text = text.replace(date.text, " ");
		if (time) text = text.replace(time.text, " ");
	}
	out.text = text.replace(/\s+/g, " ").trim();
	return out;
}

/**
 * 提醒快速输入解析：「每天 9:00 吃药」/「每周五 18:00 复盘」/「明天 21:30 交作业」/
 * 「每30分钟 起身活动」。至少要有个时间，否则回 null（由调用方提示）。
 */
export function parseQuickReminder(input, nowMs = Date.now()) {
	let text = String(input ?? "").trim();
	const every = /每\s*(\d{1,3})\s*(分钟|min|小时|h)/i.exec(text);
	if (every) {
		const n = Number(every[1]);
		const minutes = /小时|h/i.test(every[2]) ? n * 60 : n;
		const body = text.replace(every[0], " ").replace(/\s+/g, " ").trim();
		if (!body || minutes < 1 || minutes > 24 * 60) return null;
		return { text: body, schedule: { type: "every", minutes } };
	}
	const time = parseTimeText(text);
	const daily = /(每天|每日|每天|daily)/.exec(text);
	const weekly = /(?:每|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
	const monthly = /每\s*月\s*(\d{1,2})\s*[日号]?/.exec(text);
	if (daily && time) {
		const body = text.replace(daily[0], " ").replace(time.text, " ").replace(/\s+/g, " ").trim();
		if (!body) return null;
		return { text: body, schedule: { type: "daily", time: hm(time) } };
	}
	if (monthly && time) {
		const dom = Number(monthly[1]);
		const body = text.replace(monthly[0], " ").replace(time.text, " ").replace(/\s+/g, " ").trim();
		if (!body || dom < 1 || dom > 31) return null;
		return { text: body, schedule: { type: "monthly", time: hm(time), dom } };
	}
	if (weekly && time) {
		const body = text.replace(weekly[0], " ").replace(time.text, " ").replace(/\s+/g, " ").trim();
		if (!body) return null;
		return { text: body, schedule: { type: "weekly", time: hm(time), dow: [WEEKDAY_CN[weekly[1]]] } };
	}
	const date = parseDateText(text, nowMs);
	if (date && time) {
		const d = new Date(date.ms);
		d.setHours(time.h, time.m, 0, 0);
		const body = text.replace(date.text, " ").replace(time.text, " ").replace(/\s+/g, " ").trim();
		if (!body) return null;
		return { text: body, schedule: { type: "once", at: nowStamp(d.getTime()) } };
	}
	// 「9:00 吃药」这种只写时间的 → 今天/下一个该时刻的一次性
	if (time && !date) {
		const d = new Date(nowMs);
		d.setHours(time.h, time.m, 0, 0);
		if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
		const body = text.replace(time.text, " ").replace(/\s+/g, " ").trim();
		if (!body) return null;
		return { text: body, schedule: { type: "once", at: nowStamp(d.getTime()) } };
	}
	return null;
}

function hm(t) {
	return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- 导入 / 导出

/** 导出 Markdown（人看的备份；导入走 JSON）。 */
export function toMarkdown(store, nowMs = Date.now()) {
	const lines = [`# 笔记库导出 ${nowStamp(nowMs)}`, ""];
	lines.push(`## 待办（${store.todos.filter((t) => !t.done).length} 项未完成）`, "");
	for (const t of store.todos) {
		const box = t.done ? "x" : " ";
		const meta = [];
		if (t.due) meta.push(`截止 ${t.due.replace("T", " ")}`);
		if (t.repeat !== "none") meta.push(`重复 ${t.repeat}`);
		if (t.priority) meta.push(`优先级 ${t.priority}`);
		if (t.tags.length) meta.push(t.tags.map((x) => `#${x}`).join(" "));
		lines.push(`- [${box}] ${t.text}${meta.length ? `  _(${meta.join(" · ")})_` : ""}`);
	}
	lines.push("", `## 笔记（${store.notes.length} 篇）`, "");
	for (const n of store.notes) {
		lines.push(`### ${n.pinned ? "📌 " : ""}${n.title}`);
		if (n.tags.length) lines.push(`标签：${n.tags.map((x) => `#${x}`).join(" ")}`);
		lines.push(`更新：${n.updatedAt.replace("T", " ")}`, "");
		lines.push(n.body.trim() || "_(空)_", "");
	}
	lines.push(`## 提醒（${store.reminders.length} 条）`, "");
	for (const r of store.reminders) {
		lines.push(
			`- ${r.enabled ? "🔔" : "🔕"} ${r.text}  ${scheduleText(r.schedule)}${r.lastFired ? ` （上次 ${r.lastFired.replace("T", " ")}）` : ""}`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * 导入：mode='merge'（按 id 合并，导入方覆盖同 id；同 id 不存在则新增）或
 * mode='replace'（整库替换）。返回 { ok, added, updated, error? }。
 */
export function importStore(store, incoming, mode = "merge") {
	const next = normalizeStore(incoming);
	if (!next.notes.length && !next.todos.length && !next.reminders.length) {
		return { ok: false, added: 0, updated: 0, error: "empty or invalid store" };
	}
	if (mode === "replace") {
		store.notes = next.notes;
		store.todos = next.todos;
		store.reminders = next.reminders;
		return { ok: true, added: next.notes.length + next.todos.length + next.reminders.length, updated: 0 };
	}
	let added = 0;
	let updated = 0;
	let skipped = 0;
	for (const key of ["notes", "todos", "reminders"]) {
		const cap = CAPS[key];
		const list = store[key];
		const fresh = [];
		for (const item of next[key]) {
			const i = list.findIndex((x) => x.id === item.id);
			if (i >= 0) {
				list[i] = item;
				updated++;
			} else if (list.length + fresh.length < cap) {
				fresh.push(item);
			} else {
				skipped++;
			}
		}
		// 一次 unshift 整批，保持导入文件里的顺序（逐条 unshift 会把顺序整体倒过来）
		if (fresh.length) {
			list.unshift(...fresh);
			added += fresh.length;
		}
	}
	return { ok: true, added, updated, skipped };
}

/** 从文本中识别日期时间（例如「明天 18:00 开会」→ { stamp: "...", timeLabel: "明天 18:00" }）。 */
export function detectTimeFromText(input, nowMs = Date.now()) {
	const text = String(input ?? "").trim();
	if (!text) return null;
	const date = parseDateText(text, nowMs);
	const time = parseTimeText(text);
	if (!date && !time) return null;
	const d = new Date(date ? date.ms : nowMs);
	if (time) {
		d.setHours(time.h, time.m, 0, 0);
	} else {
		d.setHours(9, 0, 0, 0);
	}
	// 如果只给时间且时刻已过去，推到明天
	if (!date && time && d.getTime() <= nowMs) {
		d.setDate(d.getDate() + 1);
	}
	const stampStr = nowStamp(d.getTime());
	const timeLabel = (date ? date.text : "") + (date && time ? " " : "") + (time ? time.text : "");
	return { stamp: stampStr, timeLabel: timeLabel.trim() || stampStr };
}
