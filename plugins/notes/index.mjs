import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as S from "./client/store.mjs";
import { isSupportedEvery, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, parseCron } from "./client/cron.mjs";

const WAIT_MS = 25_000;
const MAX_WAITERS = 40;

export default {
	activate(host) {
		const dir = join(host.dataDir, "notes");
		const file = join(dir, "store.json");
		let readonly = false;
		const MIRROR_INDEX = ".pi-notes-mirror.json";
		let mirrorTimer = null;
		let mirrorRunning = false;
		let mirrorQueued = false;
		let mirrorDenied = false;
		let store = load();

		function load() {
			try {
				return S.normalizeStore(JSON.parse(readFileSync(file, "utf8")));
			} catch (err) {
				if (existsSync(file)) {
					const quarantine = `${file}.corrupt-${Date.now()}`;
					try {
						renameSync(file, quarantine);
						host.log(
							"error",
							`笔记库解析失败，原文件已隔离为 ${quarantine}，本次以空库启动：`,
							err instanceof Error ? err.message : String(err),
						);
					} catch (e2) {
						host.log(
							"error",
							"笔记库解析失败且隔离失败，本次不写盘以免覆盖：",
							e2 instanceof Error ? e2.message : String(e2),
						);
						readonly = true;
					}
				}
				return S.emptyStore();
			}
		}

		function persist() {
			if (readonly) return;
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${file}.tmp.${process.pid}`;
				writeFileSync(tmp, JSON.stringify(store, null, "\t"), "utf8");
				renameSync(tmp, file);
			} catch (err) {
				host.log("error", "写入笔记库失败：", err instanceof Error ? err.message : String(err));
			}
		}

		function commitChange() {
			S.touch(store);
			persist();
			flushWaiters();
			refreshNearTimers();
			queueMirror("change");
		}

		const waiters = new Set();

		function snapshotPayload() {
			const next = {};
			for (const rem of store.reminders) {
				if (!rem.enabled || !rem.nextDue) continue;
				const ms = new Date(rem.nextDue).getTime();
				if (Number.isFinite(ms)) next[rem.id] = new Date(ms).toISOString();
			}
			return { ok: true, store, next, now: Date.now() };
		}

		function respond(waiter) {
			try {
				clearTimeout(waiter.timer);
				waiter.res.json(snapshotPayload());
			} catch {}
		}

		function flushWaiters() {
			for (const w of [...waiters]) {
				if (w.rev !== store.meta.rev) {
					waiters.delete(w);
					respond(w);
				}
			}
		}

		function closeAllWaiters() {
			for (const w of [...waiters]) {
				waiters.delete(w);
				try {
					clearTimeout(w.timer);
					w.res.json({ ok: true, unchanged: true, store, now: Date.now() });
				} catch {}
			}
		}

		const nearTimers = new Map();
		const SWEEP_ID = "sweep";
		const SWEEP_SPEC = "* * * * *";
		const NEAR_WINDOW_MS = 120_000;

		function refreshNearTimers() {
			for (const [, t] of nearTimers) clearTimeout(t);
			nearTimers.clear();
			const now = Date.now();
			for (const rem of store.reminders) {
				if (!rem.enabled || !rem.nextDue) continue;
				const due = new Date(rem.nextDue).getTime();
				if (!Number.isFinite(due)) continue;
				const delta = due - now;
				if (delta > NEAR_WINDOW_MS) continue;
				nearTimers.set(
					rem.id,
					setTimeout(
						() => {
							nearTimers.delete(rem.id);
							fire(rem.id);
						},
						Math.max(0, delta) + 50,
					),
				);
			}
		}

		function sweep() {
			const now = Date.now();
			let changed = false;
			for (const rem of [...store.reminders]) {
				if (!rem.enabled || !rem.nextDue) continue;
				const due = new Date(rem.nextDue).getTime();
				if (!Number.isFinite(due) || due > now) continue;
				const res = S.markFired(store, rem.id, now);
				if (res.ok) {
					host.log("info", `提醒到点：${res.item.text}`);
					changed = true;
				}
			}
			if (changed) commitChange();
		}

		function fire(id) {
			const cur = S.findReminder(store, id);
			if (!cur || !cur.enabled || !cur.nextDue) return;
			if (new Date(cur.nextDue).getTime() > Date.now() + 1000) return;
			const res = S.markFired(store, id);
			if (!res.ok) return;
			host.log("info", `提醒到点：${res.item.text}`);
			commitChange();
		}

		function runOp(op, payload = {}) {
			switch (String(op ?? "")) {
				case "note.save":
					return wrap(S.saveNote(store, payload.item ?? payload));
				case "note.delete":
				case "note.remove":
					return S.removeNote(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("note");
				case "todo.save":
					return wrap(S.saveTodo(store, payload.item ?? payload));
				case "todo.delete":
				case "todo.remove":
					return S.removeTodo(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("todo");
				case "todo.toggle":
					return wrap(S.toggleTodo(store, payload.id));
				case "todo.clearDone": {
					const before = store.todos.length;
					store.todos = store.todos.filter((t) => !t.done);
					return { ok: true, result: { ok: true, removed: before - store.todos.length } };
				}
				case "reminder.save":
					return wrap(S.saveReminder(store, payload.item ?? payload));
				case "reminder.delete":
				case "reminder.remove":
					return S.removeReminder(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("reminder");
				case "reminder.snooze":
					return wrap(S.snoozeReminder(store, payload.id, payload.minutes));
				case "reminder.ack": {
					const n = S.ackPending(store, payload.ids);
					return { ok: true, result: { ok: true, acked: n }, changed: n > 0 };
				}
				case "store.import": {
					const candidate = S.normalizeStore(payload.store);
					if (!candidate.notes.length && !candidate.todos.length && !candidate.reminders.length) {
						return { ok: false, error: "文件里没有可导入的条目" };
					}
					const backup = `${file}.bak`;
					try {
						writeFileSync(backup, JSON.stringify(store, null, "\t"), "utf8");
					} catch {}
					const res = S.importStore(store, payload.store, payload.mode === "replace" ? "replace" : "merge");
					if (!res.ok) return { ok: false, error: res.error ?? "import failed" };
					S.ensureNextDue(store, Date.now());
					return { ok: true, result: { ok: true, added: res.added, updated: res.updated, skipped: res.skipped ?? 0 } };
				}
				default:
					return { ok: false, error: `unknown op: ${op}` };
			}
		}

		function wrap(res) {
			if (!res || res.ok !== true) return { ok: false, error: res?.error ?? "operation failed" };
			return { ok: true, result: { ok: true, item: res.item } };
		}

		function notFound(kind) {
			return { ok: false, error: `${kind} not found` };
		}

		function apply(op, payload) {
			const out = runOp(op, payload);
			const changed = out.changed ?? out.ok;
			if (out.ok && changed) commitChange();
			return out;
		}

		const offs = [];
		const route = (method, path, handler) => {
			offs.push(
				host.route(method, path, (req, res) => {
					try {
						handler(req, res);
					} catch (err) {
						host.log("error", `http ${method} ${path} 失败：`, err instanceof Error ? err.message : String(err));
						if (!res.headersSent)
							res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
					}
				}),
			);
		};

		route("GET", "/store", (_req, res) => res.json(snapshotPayload()));

		route("GET", "/wait", (req, res) => {
			const rev = Number(req.query?.rev);
			if (waiters.size >= MAX_WAITERS) {
				res.json({ ...snapshotPayload(), retryAfterMs: 2000 });
				return;
			}
			if (!Number.isFinite(rev) || rev !== store.meta.rev) {
				res.json(snapshotPayload());
				return;
			}
			const waiter = { res, rev, timer: null };
			waiter.timer = setTimeout(() => {
				waiters.delete(waiter);
				respond(waiter);
			}, WAIT_MS);
			req.on?.("close", () => {
				waiters.delete(waiter);
				clearTimeout(waiter.timer);
			});
			waiters.add(waiter);
		});

		route("POST", "/op", (req, res) => {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const out = apply(body.op, body);
			res.json({ ...snapshotPayload(), ok: out.ok, error: out.error, result: out.result });
		});

		route("GET", "/export", (req, res) => {
			const format = String(req.query?.format ?? "json") === "md" ? "md" : "json";
			const stamp = S.nowStamp().replace(/[:T]/g, "-");
			if (format === "md") {
				res.setHeader("Content-Type", "text/markdown; charset=utf-8");
				res.setHeader("Content-Disposition", `attachment; filename="notes-${stamp}.md"`);
				res.send(S.toMarkdown(store));
				return;
			}
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.setHeader("Content-Disposition", `attachment; filename="notes-backup-${stamp}.json"`);
			res.send(JSON.stringify(store, null, "\t"));
		});

		if (!existsSync(file)) persist();
		S.ensureNextDue(store, Date.now());
		let offSweep = () => {};
		try {
			offSweep = host.schedule(SWEEP_SPEC, () => sweep(), {
				persistent: true,
				id: SWEEP_ID,
				label: "⏰ 笔记提醒巡检",
				catchUp: "once",
			});
		} catch (err) {
			host.log(
				"error",
				"每分钟巡检排不上，提醒不会自动触发（其它功能照常）：",
				err instanceof Error ? err.message : String(err),
			);
		}
		sweep();
		refreshNearTimers();
		queueMirror("startup", 1500);
		host.log(
			"info",
			`笔记库就绪：${store.notes.length} 篇笔记 / ${store.todos.length} 条待办 / ${store.reminders.length} 条提醒`,
		);

		const ACTION_OR_INFER_DESC = "What to do. Optional: no action + no id = add; no action + id = update.";
		const doList = (params) => listText(params || {});
		const doNoteAdd = (params) => {
			const out = apply("note.save", {
				item: { title: params.title, body: params.body, tags: params.tags },
			});
			if (!out.ok) return `保存失败：${out.error}`;
			return `已记下笔记「${out.result.item.title}」（id ${out.result.item.id}）`;
		};
		const doNoteUpdate = (params) => {
			const id = String(params.id ?? "").trim();
			if (!id) return "缺少 id（先用 op=list 查）";
			if (params.delete === true) {
				const out = apply("note.remove", { id });
				return out.ok ? `已删除笔记 ${id}` : `删除失败：${out.error}`;
			}
			const note = S.findNote(store, id);
			if (!note) return `找不到笔记 ${id}`;
			const patch = { id };
			if (params.title !== undefined) patch.title = params.title;
			if (params.body !== undefined) patch.body = params.body;
			if (params.append !== undefined)
				patch.body = `${note.body}${note.body.endsWith("\n") || !note.body ? "" : "\n"}${params.append}`;
			if (params.tags !== undefined) patch.tags = params.tags;
			if (params.pinned !== undefined) patch.pinned = params.pinned;
			const out = apply("note.save", { item: patch });
			return out.ok ? `已更新笔记「${out.result.item.title}」` : `更新失败：${out.error}`;
		};
		const doTodo = (params) => {
			const action = String(params.action ?? "").toLowerCase() || (String(params.id ?? "").trim() ? "update" : "add");
			const common = {};
			if (params.text !== undefined) common.text = params.text;
			if (params.priority !== undefined) common.priority = params.priority;
			if (params.repeat !== undefined) common.repeat = params.repeat;
			if (params.tags !== undefined) common.tags = params.tags;
			if (action === "add") {
				const out = apply("todo.save", { item: { ...common, due: toStampOrNull(params.due) } });
				return out.ok ? `已加入待办：${describeTodo(out.result.item)}` : `添加失败：${out.error}`;
			}
			if (action === "clear_done") {
				const out = apply("todo.clearDone", {});
				return out.ok ? `已清除 ${out.result.removed} 条已完成待办` : `失败：${out.error}`;
			}
			const id = String(params.id ?? "").trim();
			if (!id) return "缺少 id（先用 op=list 查待办）";
			if (action === "remove") {
				const out = apply("todo.remove", { id });
				return out.ok ? `已删除待办 ${id}` : `删除失败：${out.error}`;
			}
			if (action === "done" || action === "undone") {
				const todo = S.findTodo(store, id);
				if (!todo) return `找不到待办 ${id}`;
				if (todo.done === (action === "done")) return `待办 ${id} 已经是该状态`;
				const out = apply("todo.toggle", { id });
				if (!out.ok) return `失败：${out.error}`;
				return out.result.item.done === false && todo.repeat !== "none"
					? `重复待办已推进到下一次：${describeTodo(out.result.item)}`
					: `${action === "done" ? "已完成" : "已重新打开"}：${describeTodo(out.result.item)}`;
			}
			const patch = { id, ...common };
			if (params.due !== undefined) patch.due = toStampOrNull(params.due);
			const out = apply("todo.save", { item: patch });
			return out.ok ? `已更新待办：${describeTodo(out.result.item)}` : `更新失败：${out.error}`;
		};
		const doReminder = (params) => {
			const action = String(params.action ?? "").toLowerCase() || (String(params.id ?? "").trim() ? "update" : "add");
			const id = String(params.id ?? "").trim();
			if (action === "remove") {
				if (!id) return "缺少 id";
				const out = apply("reminder.remove", { id });
				return out.ok ? `已删除提醒 ${id}` : `删除失败：${out.error}`;
			}
			if (action === "snooze") {
				if (!id) return "缺少 id";
				const out = apply("reminder.snooze", { id, minutes: params.minutes ?? 10 });
				return out.ok ? `已推迟：${describeReminder(out.result.item)}` : `失败：${out.error}`;
			}
			const built = buildSchedule(params);
			if (built.error) return built.error;
			if (built.schedule && S.nextDueStamp({ enabled: true, schedule: built.schedule }, Date.now(), "now") === null) {
				return "这个时间排不出可运行的定时（例如 2 月 31 日这种永远不存在的日期），请换一个档位";
			}
			if (action === "add") {
				if (!String(params.text ?? "").trim()) return "提醒内容不能为空";
				if (!built.schedule) return "缺少时间：用 at / daily_at / weekly_at / monthly_at / every_minutes / cron 之一";
				const out = apply("reminder.save", {
					item: {
						text: params.text,
						schedule: built.schedule,
						noteId: params.note_id,
						todoId: params.todo_id,
					},
				});
				return out.ok ? `已设提醒：${describeReminder(out.result.item)}` : `设置失败：${out.error}`;
			}
			if (!id) return "缺少 id（先用 op=list 查提醒）";
			const patch = { id };
			if (params.text !== undefined) patch.text = params.text;
			if (built.schedule) patch.schedule = built.schedule;
			if (params.enabled !== undefined) patch.enabled = params.enabled;
			if (params.note_id !== undefined) patch.noteId = params.note_id;
			if (params.todo_id !== undefined) patch.todoId = params.todo_id;
			const out = apply("reminder.save", { item: patch });
			return out.ok ? `已更新提醒：${describeReminder(out.result.item)}` : `更新失败：${out.error}`;
		};
		const toolOffs = [
			host.registerAgentTool({
				name: "notes",
				label: "笔记/待办/提醒",
				description:
					"User personal notes store (this machine): notes, todos and reminders. Pick op for the collection.",
				promptSnippet: "the user personal notes, todos and reminders",
				promptGuidelines: [
					"Call with op=list first for ids and agenda; pass the id to op=note_update/todo/reminder.",
					"Route by intent: memo to op=note_add, action to op=todo, timed alert to op=reminder with one of at/daily_at/weekly_at/monthly_at/every_minutes/cron.",
				],
				parameters: {
					type: "object",
					properties: {
						op: {
							type: "string",
							enum: ["list", "note_add", "note_update", "todo", "reminder"],
							description: "Which operation to run.",
						},
						kind: {
							type: "string",
							enum: ["all", "agenda", "note", "todo", "reminder"],
							description: "For op=list: all, agenda (due now), or one collection.",
						},
						query: { type: "string", description: "For op=list: substring filter over text/title/body/tags." },
						tag: { type: "string", description: "For op=list: only items carrying this tag." },
						include_done: { type: "boolean", description: "For op=list: include completed todos." },
						limit: { type: "number", description: "For op=list: max rows per collection (default 30, max 200)." },
						title: { type: "string", description: "Note title (defaults to first body line)." },
						body: { type: "string", description: "Note Markdown body." },
						tags: { type: "array", items: { type: "string" } },
						pinned: { type: "boolean" },
						delete: { type: "boolean", description: "For op=note_update: delete the note." },
						append: { type: "string", description: "For op=note_update: append text to the note body." },
						action: {
							type: "string",
							enum: ["add", "update", "done", "undone", "remove", "clear_done", "snooze"],
							description: ACTION_OR_INFER_DESC,
						},
						id: { type: "string", description: "Item id from op=list (required except for add/clear_done)." },
						text: { type: "string", description: "Todo or reminder text." },
						due: { type: "string", description: "Todo due: YYYY-MM-DD HH:MM, YYYY-MM-DD or ISO 8601 (empty clears)." },
						priority: { type: "number", description: "Todo priority 0 normal to 3 urgent." },
						repeat: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
						at: { type: "string", description: "Reminder one-off: YYYY-MM-DD HH:MM or ISO 8601." },
						daily_at: { type: "string", description: "Reminder daily at HH:MM." },
						weekly_at: { type: "string", description: "Reminder time HH:MM on weekdays." },
						weekdays: { type: "array", items: { type: "string" }, description: "Weekdays for weekly_at: mon..sun." },
						monthly_at: { type: "string", description: "Reminder time HH:MM on day_of_month." },
						day_of_month: { type: "number", description: "1-31 for monthly_at (default 1)." },
						every_minutes: { type: "number", description: "Reminder repeat every N minutes (1-1440)." },
						cron: { type: "string", description: "Reminder raw 5-field cron, server local time." },
						enabled: { type: "boolean" },
						minutes: { type: "number", description: "For action=snooze: delay minutes (default 10)." },
						note_id: { type: "string" },
						todo_id: { type: "string" },
					},
					required: ["op"],
				},
				async execute(_id, params) {
					const op = String(params?.op ?? "list").toLowerCase();
					if (op === "note_add") return doNoteAdd(params);
					if (op === "note_update") return doNoteUpdate(params);
					if (op === "todo") return doTodo(params);
					if (op === "reminder") return doReminder(params);
					return doList(params);
				},
			}),
		];

		function safeName(text, fallback = "note") {
			const BACKSLASH = String.fromCharCode(92);
			const BAD = new Set(["/", ":", "*", "?", '"', "<", ">", "|", BACKSLASH]);
			let cleaned = "";
			for (const ch of String(text ?? "")) {
				cleaned += ch.codePointAt(0) < 32 || BAD.has(ch) ? " " : ch;
			}
			cleaned = cleaned
				.replace(/\s+/g, " ")
				.replace(/^[. ]+|[. ]+$/g, "")
				.trim()
				.slice(0, 60);
			return cleaned || fallback;
		}

		function noteFile(note) {
			return `${safeName(note.title, "note")}-${note.id.slice(-6)}.md`;
		}

		function noteMarkdown(note) {
			const title = note.title.replace(/[\r\n]+/g, " ");
			const fm = [
				"---",
				`id: ${note.id}`,
				`title: ${title}`,
				`tags: [${note.tags.join(", ")}]`,
				`pinned: ${note.pinned}`,
				`created: ${note.createdAt}`,
				`updated: ${note.updatedAt}`,
				"---",
				"",
			].join("\n");
			return `${fm}# ${title}\n\n${note.body.trim()}\n`;
		}

		function todosMarkdown() {
			const lines = [`# 待办（${store.todos.filter((t) => !t.done).length} 项未完成）`, ""];
			for (const todo of store.todos) {
				const bits = [];
				if (todo.due) bits.push(`截止 ${todo.due.replace("T", " ")}`);
				if (todo.priority) bits.push(`优先级 ${todo.priority}`);
				if (todo.repeat !== "none") bits.push(`重复 ${todo.repeat}`);
				if (todo.tags.length) bits.push(todo.tags.map((x) => `#${x}`).join(" "));
				lines.push(`- [${todo.done ? "x" : " "}] ${todo.text}${bits.length ? `  _(${bits.join(" · ")})_` : ""}`);
			}
			lines.push("");
			return lines.join("\n");
		}

		function remindersMarkdown() {
			const lines = ["# 提醒", ""];
			for (const rem of store.reminders) {
				const next = S.reminderFireAt(rem);
				lines.push(
					`- ${rem.enabled ? "🔔" : "🔕"} ${rem.text} — ${scheduleParts(rem.schedule)}` +
						(next ? `（下次 ${new Date(next).toLocaleString()}）` : rem.enabled ? "" : "（已停用）"),
				);
			}
			lines.push("");
			return lines.join("\n");
		}

		async function ensureMirrorDir(dir) {
			try {
				const granted = (host.fs.authorizedDirs?.() ?? []).some((d) => d === dir);
				if (!granted) {
					if (mirrorDenied) return false;
					const ok = await host.fs.requestAccess(dir, "把笔记镜像成 Markdown 文件到这个目录");
					if (!ok) {
						mirrorDenied = true;
						host.log("warn", `镜像目录未授权，已暂停镜像：${dir}`);
						host.notify("warning", `笔记镜像需要目录授权：${dir}`);
						return false;
					}
				}
				await host.fs.mkdirPath(dir);
				return true;
			} catch (err) {
				host.log("warn", "镜像目录不可用：", err instanceof Error ? err.message : String(err));
				return false;
			}
		}

		async function mirrorOnce(reason) {
			const settings = host.getSettings?.() ?? {};
			if (settings.mirrorEnabled !== true) return;
			const dir = String(settings.mirrorDir ?? "").trim();
			if (!dir || !isAbsolute(dir)) {
				host.log("warn", "镜像目录必须是绝对路径：", JSON.stringify(dir));
				return;
			}
			if (mirrorRunning) {
				mirrorQueued = true;
				return;
			}
			mirrorRunning = true;
			try {
				if (!(await ensureMirrorDir(dir))) return;
				const wanted = new Map();
				for (const note of store.notes) wanted.set(noteFile(note), noteMarkdown(note));
				wanted.set("_todos.md", todosMarkdown());
				wanted.set("_reminders.md", remindersMarkdown());

				let previous = [];
				try {
					const parsed = JSON.parse(await host.fs.readTextPath(join(dir, MIRROR_INDEX)));
					if (Array.isArray(parsed?.files)) previous = parsed.files.filter((x) => typeof x === "string");
				} catch {
					previous = [];
				}

				let written = 0;
				for (const [name, text] of wanted) {
					try {
						await host.fs.writePath(join(dir, name), text);
						written++;
					} catch (err) {
						host.log("warn", `镜像写入失败 ${name}：`, err instanceof Error ? err.message : String(err));
					}
				}
				let removed = 0;
				for (const name of previous) {
					if (wanted.has(name)) continue;
					try {
						await host.fs.removePath(join(dir, name));
						removed++;
					} catch {}
				}
				await host.fs.writePath(
					join(dir, MIRROR_INDEX),
					JSON.stringify({ v: 1, at: new Date().toISOString(), files: [...wanted.keys()] }, null, "\t"),
				);
				host.log(
					"info",
					`镜像同步完成（${reason}）：写 ${written} 个${removed ? `，清理 ${removed} 个` : ""} → ${dir}`,
				);
			} catch (err) {
				host.log("warn", "镜像同步失败：", err instanceof Error ? err.message : String(err));
			} finally {
				mirrorRunning = false;
				if (mirrorQueued) {
					mirrorQueued = false;
					void mirrorOnce("queued");
				}
			}
		}

		function queueMirror(reason, delayMs = 3000) {
			if ((host.getSettings?.() ?? {}).mirrorEnabled !== true) return;
			if (mirrorTimer) clearTimeout(mirrorTimer);
			mirrorTimer = setTimeout(() => {
				mirrorTimer = null;
				void mirrorOnce(reason);
			}, delayMs);
			mirrorTimer.unref?.();
		}

		const offSettings = host.onSettingsChanged?.(() => {
			mirrorDenied = false;
			queueMirror("settings", 200);
		});

		const cmdOffs = [
			host.registerCommand({
				name: "note",
				description: "存一条笔记",
				descriptionEn: "Save a note",
				argumentHint: "<正文>",
				argumentHintEn: "<text>",
				run(args) {
					const text = String(args ?? "").trim();
					if (!text) return "用法：/note 内容（第一行当标题）";
					const [first, ...rest] = text.split("\n");
					const out = apply("note.save", { item: { title: first.slice(0, 120), body: rest.join("\n") } });
					return out.ok ? `📌 已记到笔记：${out.result.item.title}` : `失败：${out.error}`;
				},
			}),
			host.registerCommand({
				name: "todo",
				description: "加一条待办（支持「明天 18:00」「#标签」「!!」）",
				descriptionEn: "Add a todo (understands “tomorrow 18:00”, “#tag”, “!!”)",
				argumentHint: "<内容>",
				argumentHintEn: "<text>",
				run(args) {
					const raw = String(args ?? "").trim();
					if (!raw) return "用法：/todo 交周报 明天 18:00 #工作 !!";
					const parsed = S.parseQuickTodo(raw);
					if (!parsed.text) return "没读懂这条待办，试试：/todo 交周报 明天 18:00";
					const out = apply("todo.save", {
						item: { text: parsed.text, due: parsed.due, priority: parsed.priority, tags: parsed.tags },
					});
					return out.ok ? `✅ 已加入待办：${describeTodo(out.result.item)}` : `失败：${out.error}`;
				},
			}),
			host.registerCommand({
				name: "notes-mirror",
				description: "立即把笔记镜像成 Markdown（需先在设置里开启并填目录）",
				descriptionEn: "Mirror notes to Markdown now (enable it in settings first)",
				run: async () => {
					const settings = host.getSettings?.() ?? {};
					if (settings.mirrorEnabled !== true || !String(settings.mirrorDir ?? "").trim()) {
						return "还没开启镜像：设置 → 界面插件 → 笔记 里勾选并填一个绝对目录";
					}
					mirrorDenied = false;
					await mirrorOnce("manual");
					return `已同步到 ${String(settings.mirrorDir).trim()}`;
				},
			}),
			host.registerCommand({
				name: "remind",
				description: "设提醒（如「每天 9:00 吃药」「每周五 18:00 复盘」「每30分钟 起身」）",
				descriptionEn: "Set a reminder (“every day 9:00 …”, “every friday 18:00 …”, “every 30 min …”)",
				argumentHint: "<时间 + 内容>",
				argumentHintEn: "<when + what>",
				run(args) {
					const raw = String(args ?? "").trim();
					if (!raw) return "用法：/remind 每天 9:00 吃药";
					const parsed = S.parseQuickReminder(raw);
					if (!parsed) return "没读懂时间，试试：/remind 每天 9:00 吃药 / 每30分钟 起身 / 明天 21:00 交作业";
					const out = apply("reminder.save", { item: { text: parsed.text, schedule: parsed.schedule } });
					return out.ok ? `⏰ 已设提醒：${describeReminder(out.result.item)}` : `失败：${out.error}`;
				},
			}),
		];

		function toStampOrNull(raw) {
			const s = String(raw ?? "").trim();
			if (!s) return null;
			const normalized = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(s) ? s.replace(" ", "T") : s;
			const ms = new Date(normalized).getTime();
			if (!Number.isFinite(ms)) return null;
			return S.nowStamp(ms);
		}

		function buildSchedule(params) {
			const given = (v) => v !== undefined && v !== null && String(v).trim() !== "";
			if (!["at", "daily_at", "weekly_at", "monthly_at", "cron", "every_minutes"].some((k) => given(params[k]))) {
				return {};
			}
			if (given(params.every_minutes)) {
				const minutes = Number(params.every_minutes);
				if (!isSupportedEvery(minutes)) {
					return { error: `every_minutes 需在 ${MIN_EVERY_MINUTES}..${MAX_EVERY_MINUTES} 分钟之间（7 天）` };
				}
				return { schedule: { type: "every", minutes } };
			}
			if (given(params.cron)) {
				const spec = String(params.cron).trim().replace(/\s+/g, " ");
				if (!parseCron(spec)) return { error: `cron 表达式不合法：${spec}（需要 5 段：分 时 日 月 周）` };
				return { schedule: { type: "cron", spec } };
			}
			const timeOf = (raw) => {
				const m = /(\d{1,2})[:：](\d{1,2})/.exec(String(raw ?? ""));
				if (!m) return null;
				const h = Number(m[1]);
				const mi = Number(m[2]);
				return h <= 23 && mi <= 59 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
			};
			if (given(params.daily_at)) {
				const time = timeOf(params.daily_at);
				return time ? { schedule: { type: "daily", time } } : { error: `daily_at 需要 HH:MM：${params.daily_at}` };
			}
			if (given(params.weekly_at)) {
				const time = timeOf(params.weekly_at);
				if (!time) return { error: `weekly_at 需要 HH:MM：${params.weekly_at}` };
				const byName = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
				const dow = (Array.isArray(params.weekdays) ? params.weekdays : [])
					.map((x) => {
						const s = String(x).trim().toLowerCase();
						if (s in byName) return byName[s];
						const n = Number(s);
						return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
					})
					.filter((x) => x !== null);
				return dow.length
					? { schedule: { type: "weekly", time, dow } }
					: { error: 'weekly_at 需要 weekdays（如 ["mon","fri"]）' };
			}
			if (given(params.monthly_at)) {
				const time = timeOf(params.monthly_at);
				if (!time) return { error: `monthly_at 需要 HH:MM：${params.monthly_at}` };
				const dom = Number(params.day_of_month ?? 1);
				if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { error: "day_of_month 需在 1..31" };
				return { schedule: { type: "monthly", time, dom } };
			}
			const stamp = toStampOrNull(params.at);
			if (!stamp) return { error: `at 解析不出时间：${params.at}（用 'YYYY-MM-DD HH:MM'）` };
			if (new Date(stamp).getTime() < Date.now() - 60_000) {
				return { error: "at 已经是过去的时间（补跑只发生在服务重启时，请给未来的时间）" };
			}
			return { schedule: { type: "once", at: stamp } };
		}

		function describeTodo(todo) {
			const bits = [];
			if (todo.due) bits.push(`截止 ${todo.due.replace("T", " ")}`);
			if (todo.priority) bits.push(`优先级 ${todo.priority}`);
			if (todo.repeat !== "none") bits.push(`重复 ${todo.repeat}`);
			if (todo.tags.length) bits.push(todo.tags.map((x) => `#${x}`).join(" "));
			return `${todo.done ? "[x]" : "[ ]"} ${todo.text}${bits.length ? `（${bits.join(" · ")}）` : ""}（id ${todo.id}）`;
		}

		function describeReminder(rem) {
			const parts = scheduleParts(rem.schedule);
			const next = S.reminderFireAt(rem);
			const when = next ? `，下次 ${new Date(next).toLocaleString()}` : rem.enabled ? "" : "（已停用）";
			return `${rem.text} · ${parts}${when}（id ${rem.id}）`;
		}

		function everyText(minutes) {
			const n = Number(minutes);
			if (n % 1440 === 0) return `每 ${n / 1440} 天`;
			if (n >= 60 && n % 60 === 0) return `每 ${n / 60} 小时`;
			if (n >= 60) return `每 ${Math.floor(n / 60)} 小时 ${n % 60} 分`;
			return `每 ${n} 分钟`;
		}

		function scheduleParts(schedule) {
			const s = S.normalizeSchedule(schedule);
			if (!s) return "无效时间";
			const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
			switch (s.type) {
				case "once":
					return `一次性 ${s.at.replace("T", " ")}`;
				case "daily":
					return `每天 ${s.time}`;
				case "weekly":
					return `每周 ${s.dow.map((d) => week[d]).join("")} ${s.time}`;
				case "monthly":
					return `每月 ${s.dom} 日 ${s.time}`;
				case "every":
					return everyText(s.minutes);
				case "cron":
					return `cron ${s.spec}`;
				default:
					return "无效时间";
			}
		}

		function listText(params) {
			const kind = String(params.kind ?? "all");
			const limit = Math.min(200, Math.max(1, Number(params.limit) || 30));
			const includeDone = params.include_done === true;
			const query = params.query === undefined ? "" : String(params.query);
			const tag = params.tag === undefined ? "" : String(params.tag);
			const lines = [];
			if (kind === "agenda") {
				const now = Date.now();
				const endToday = new Date(
					new Date(now).getFullYear(),
					new Date(now).getMonth(),
					new Date(now).getDate() + 1,
				).getTime();
				const week = now + 7 * 86400000;
				const overdue = [];
				const today = [];
				const upcoming = [];
				const later = [];
				for (const todo of store.todos) {
					if (todo.done) continue;
					if (!todo.due) {
						later.push(todo);
						continue;
					}
					const ms = new Date(todo.due).getTime();
					if (!Number.isFinite(ms)) continue;
					if (ms < now) overdue.push(todo);
					else if (ms < endToday) today.push(todo);
					else if (ms <= week) upcoming.push(todo);
					else later.push(todo);
				}
				const section = (title, items) => {
					lines.push(`## ${title}（${items.length}）`);
					lines.push(...(items.length ? items.slice(0, limit).map((t) => `- ${describeTodo(t)}`) : ["（无）"]));
					lines.push("");
				};
				section("逾期未完成", overdue);
				section("今天到期", today);
				section("未来 7 天", upcoming);
				section("没有截止时间", later);
				const rems = [];
				for (const rem of store.reminders) {
					if (!rem.enabled) continue;
					const ms = S.reminderFireAt(rem);
					if (ms !== null && ms <= now + 14 * 86400000) rems.push({ rem, ms });
				}
				rems.sort((a, b) => a.ms - b.ms);
				lines.push(`## 接下来的提醒（${rems.length}）`);
				lines.push(
					...(rems.length
						? rems.slice(0, limit).map(({ rem, ms }) => `- ${new Date(ms).toLocaleString()}  ${describeReminder(rem)}`)
						: [`（无）`]),
				);
				return lines.join("\n");
			}
			if (kind === "all" || kind === "todo") {
				const todos = S.searchItems(store, { tab: "todo", query, tag, includeDone }).slice(0, limit);
				lines.push(`## 待办（未完成 ${store.todos.filter((t) => !t.done).length} / 共 ${store.todos.length}）`);
				lines.push(...(todos.length ? todos.map((t) => `- ${describeTodo(t)}`) : ["（无）"]));
			}
			if (kind === "all" || kind === "note") {
				const notes = S.searchItems(store, { tab: "note", query, tag }).slice(0, limit);
				lines.push("", `## 笔记（${store.notes.length}）`);
				lines.push(
					...(notes.length
						? notes.map(
								(n) =>
									`- ${n.pinned ? "📌 " : ""}${n.title}（id ${n.id}${n.tags.length ? ` · ${n.tags.map((x) => `#${x}`).join(" ")}` : ""} · ${n.updatedAt.replace("T", " ")}）\n  ${firstLine(n.body)}`,
							)
						: ["（无）"]),
				);
			}
			if (kind === "all" || kind === "reminder") {
				const rems = S.searchItems(store, { tab: "reminder", query, tag }).slice(0, limit);
				lines.push(
					"",
					`## 提醒（启用 ${store.reminders.filter((r) => r.enabled).length} / 共 ${store.reminders.length}）`,
				);
				lines.push(
					...(rems.length ? rems.map((r) => `- ${r.enabled ? "🔔" : "🔕"} ${describeReminder(r)}`) : ["（无）"]),
				);
			}
			if (!lines.length) return "（库里没有匹配的条目）";
			return lines.join("\n");
		}

		function firstLine(body) {
			const line = String(body ?? "")
				.split("\n")
				.map((x) => x.trim())
				.filter(Boolean)[0];
			return line ? line.slice(0, 120) : "（空）";
		}

		return () => {
			closeAllWaiters();
			for (const [, t] of nearTimers) clearTimeout(t);
			nearTimers.clear();
			try {
				offSweep?.();
			} catch {}
			try {
				offSettings?.();
			} catch {}
			if (mirrorTimer) clearTimeout(mirrorTimer);
			for (const off of [...toolOffs, ...cmdOffs, ...offs]) {
				try {
					off?.();
				} catch {}
			}
			persist();
		};
	},
};
