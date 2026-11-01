/**
 * notes 界面本体（现代闪念笔记 + 日历双视图）。
 *
 * 核心设计：
 *   - 纯粹的「笔记」与「日历」两个 Tab：
 *       * 笔记：现代无标题流式速记（直接记录文字，可选设置提醒，无心智负担，
 *         就地快速内联编辑，秒速捕捉灵感与备忘）。
 *       * 日历：42 格月视图，展示每天有提醒的笔记与日程，可直观按天查阅与安排。
 *   - 顶部常驻 Quick Note Composer（自适应多行，支持 Markdown，Ctrl+Enter 即存，
 *     可快捷设置提醒时间与重复档位，智能嗅探时间）。
 *   - 笔记流卡片（Memos Timeline）：相对时间、置顶高亮、提醒状态胶囊、就地双击/按钮编辑。
 */
import * as S from "./store.mjs";
import {
	fromLocalInput,
	occurrencesBetween,
	MIN_EVERY_MINUTES,
} from "./cron.mjs";
import { el } from "./dom.mjs";
import { hostApi } from "@pi-web-ui/plugin-sdk/client";

const pad2 = (n) => String(n).padStart(2, "0");

/** 当天 0 点 / 当月 1 号 0 点 / 加 N 天 / 加 N 月（本地时区）。 */
function startOfDay(ms) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function startOfMonth(ms) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function addDays(ms, n) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}
function addMonths(ms, n) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}
function dayKey(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtHM(ms) {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 毫秒 → 相对时间（刚刚、N分钟前、今天 HH:MM、昨天 HH:MM、日期）。 */
function formatRelativeTime(stampStr, t, nowMs = Date.now()) {
	if (!stampStr) return "";
	const ms = new Date(stampStr).getTime();
	if (Number.isNaN(ms)) return "";
	const diff = nowMs - ms;
	if (diff < 60_000) return t("quick.now");
	if (diff < 3600_000) return t("quick.ago", { m: Math.floor(diff / 60_000) });
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const day0 = startOfDay(nowMs);
	const targetDay0 = startOfDay(ms);
	const diffDays = Math.round((day0 - targetDay0) / 86400000);
	if (diffDays === 0) return t("quick.todayAt", { t: hm });
	if (diffDays === 1) return t("quick.yesterdayAt", { t: hm });
	if (d.getFullYear() === new Date(nowMs).getFullYear()) {
		return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
	}
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 毫秒 → 人话（今天/明天/周X/日期 + 时刻）。 */
export function formatWhen(ms, t, nowMs = Date.now()) {
	if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "";
	const d = new Date(Number(ms));
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const day = Number(new Date(nowMs).setHours(0, 0, 0, 0));
	const target = Number(new Date(d).setHours(0, 0, 0, 0));
	const diffDays = Math.round((target - day) / 86400000);
	if (diffDays === 0) return `${t("agenda.today")} ${hm}`;
	if (diffDays === 1) return `${t("agenda.tomorrow")} ${hm}`;
	if (diffDays > 1 && diffDays < 7) return `${t(`week.${d.getDay()}`)} ${hm}`;
	if (d.getFullYear() === new Date(nowMs).getFullYear()) {
		return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
	}
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/** 提醒 schedule → 人话。 */
export function scheduleLabel(schedule, t) {
	const s = S.normalizeSchedule(schedule);
	if (!s) return "—";
	switch (s.type) {
		case "once":
			return `${t("type.once")} · ${formatWhen(fromLocalInput(s.at), t)}`;
		case "daily":
			return `${t("type.daily")} · ${s.time}`;
		case "weekly":
			return `${t("type.weekly")} · ${s.dow.map((d) => t(`week.${d}`)).join(" ")} ${s.time}`;
		case "monthly":
			return `${t("type.monthly")} · ${s.dom} ${s.time}`;
		case "every":
			return `${t("type.every")} · ${s.minutes}`;
		case "cron":
			return `${t("type.cron")} · ${s.spec}`;
		default:
			return "—";
	}
}

/** 格式化提醒标签，简明显示在卡片上。 */
function reminderBadgeText(reminder, t) {
	if (!reminder?.schedule) return "";
	const s = reminder.schedule;
	if (s.type === "once") {
		const ms = new Date(s.at).getTime();
		return formatWhen(ms, t);
	}
	if (s.type === "daily") return `${t("repeat.daily")} ${s.time}`;
	if (s.type === "weekly") return `${t("repeat.weekly")} ${s.time}`;
	if (s.type === "monthly") return `${t("repeat.monthly")} ${s.dom}日 ${s.time}`;
	return scheduleLabel(s, t);
}

/** 格式化行内链接与代码。 */
function appendInlineFormatted(parent, text) {
	const str = String(text ?? "");
	const parts = str.split(/(`[^`]+`|https?:\/\/[^\s]+)/g);
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
			parent.append(el("code", { text: part.slice(1, -1) }));
		} else if (/^https?:\/\//i.test(part)) {
			parent.append(el("a", { href: part, target: "_blank", rel: "noreferrer noopener", text: part }));
		} else {
			parent.append(document.createTextNode(part));
		}
	}
}

/** 简易轻量 Markdown 渲染器（支持换行、待办复选框、标题、行内代码）。 */
function renderMarkdown(text, onToggleTask) {
	const fragment = document.createDocumentFragment();
	const lines = String(text ?? "").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// 任务复选框: - [ ] 或 - [x]
		const taskMatch = line.match(/^(\s*[-*]\s*)\[([ xX])\]\s*(.*)$/);
		if (taskMatch) {
			const checked = taskMatch[2].toLowerCase() === "x";
			const taskText = taskMatch[3];
			const lineIndex = i;
			const row = el("div", { class: "nt-inline-row", style: "margin: 3px 0;" });
			const chk = el("input", {
				type: "checkbox",
				class: "nt-check nt-task-box",
				checked,
				onChange: () => onToggleTask?.(lineIndex, !checked),
			});
			const span = el("span", { style: checked ? "text-decoration: line-through; opacity: 0.65;" : "" });
			appendInlineFormatted(span, taskText);
			row.append(chk, span);
			fragment.append(row);
			i++;
			continue;
		}
		// 标题: # ... 或 ## ...
		const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
		if (hMatch) {
			const h = el(hMatch[1].length === 1 ? "h4" : "h5", {
				style: "margin: 6px 0 3px; font-weight: 600; font-size: 13px;",
			});
			appendInlineFormatted(h, hMatch[2]);
			fragment.append(h);
			i++;
			continue;
		}
		// 空行
		if (!line.trim()) {
			fragment.append(el("div", { style: "height: 6px;" }));
			i++;
			continue;
		}
		// 普通段落
		const p = el("div", { style: "margin: 2px 0;" });
		appendInlineFormatted(p, line);
		fragment.append(p);
		i++;
	}
	return fragment;
}

/**
 * 笔记界面。
 */
export function createNotesApp(options) {
	const { root, data, t, compact = false } = options;
	const state = {
		tab: readTab(),
		query: "",
		inlineEditId: null,
		tag: "",
		month: startOfMonth(Date.now()),
		day: startOfDay(Date.now()),
	};

	let snapshot = data.getState();
	let composerReminder = null; // 当前 composer 里设置的提醒 { schedule, enabled }
	let activePopMenu = null; // 当前展开的提醒菜单

	root.classList.add("nt-root");
	root.textContent = "";

	// ---------------------------------------------------------------- 骨架
	const tabButtons = {};
	const tabBar = el("div", { class: "nt-tabs" });
	for (const tab of ["note", "calendar"]) {
		const btn = el("button", {
			type: "button",
			class: "nt-tab",
			onClick: () => {
				state.tab = tab;
				state.inlineEditId = null;
				closePopMenu();
				writeTab(tab);
				render();
			},
		});
		tabButtons[tab] = btn;
		tabBar.append(btn);
	}

	const searchInput = el("input", {
		class: "nt-search",
		type: "search",
		placeholder: t("search.placeholder"),
		onInput: (e) => {
			state.query = e.target.value;
			renderList();
		},
	});

	const head = el("div", { class: "nt-head" }, tabBar, el("span", { class: "nt-grow" }), searchInput);

	// ---------------- 现代闪念速记 Composer ----------------
	const composerText = el("textarea", {
		class: "nt-composer-text",
		placeholder: t("quick.notePlaceholder"),
		rows: 2,
		onInput: () => {
			autoGrowComposer();
			checkSmartTimeSuggest();
		},
		onKeyDown: (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
				e.preventDefault();
				void submitComposer();
			}
		},
	});

	const composerRemBtn = el("button", {
		type: "button",
		class: "nt-btn nt-icon",
		text: `⏰ ${t("quick.setReminder")}`,
		onClick: (e) => {
			e.stopPropagation();
			toggleComposerReminderPop(composerRemBtn);
		},
	});

	const composerRemChip = el("span", {
		class: "nt-rem-chip",
		style: "display: none;",
	});

	const smartSuggestChip = el("span", {
		class: "nt-smart-tip",
		style: "display: none;",
		onClick: () => applySmartSuggest(),
	});

	let detectedSmartTime = null;

	const tagInsertBtn = el("button", {
		type: "button",
		class: "nt-btn nt-icon",
		text: "#",
		title: "Insert tag",
		onClick: () => {
			const start = composerText.selectionStart ?? composerText.value.length;
			const end = composerText.selectionEnd ?? composerText.value.length;
			composerText.setRangeText("#", start, end, "end");
			composerText.focus();
		},
	});

	const saveNoteBtn = el("button", {
		type: "button",
		class: "nt-btn nt-btn-primary",
		text: `${t("quick.save")} (Ctrl+↵)`,
		onClick: () => void submitComposer(),
	});

	const composerTools = el(
		"div",
		{ class: "nt-composer-tools" },
		composerRemBtn,
		composerRemChip,
		smartSuggestChip,
		tagInsertBtn,
		el("span", { class: "nt-grow" }),
		saveNoteBtn,
	);

	const composerBox = el("div", { class: "nt-composer-box" }, composerText, composerTools);
	const composerWrap = el("div", { class: "nt-composer" }, composerBox);

	// ---------------- 列表与容器 ----------------
	const listEl = el("div", { class: "nt-list" });
	const bodyEl = el("div", { class: "nt-body" }, listEl);
	const footEl = el("div", { class: "nt-foot" });
	const app = el("div", { class: `nt-app${compact ? " nt-compact" : ""}` }, head, composerWrap, bodyEl, footEl);
	root.append(app);

	// 搜索框手机端收起/展开
	if (compact) {
		searchInput.style.display = "none";
		const searchBtn = el("button", {
			type: "button",
			class: "nt-btn nt-icon",
			text: "🔍",
			title: t("search.placeholder"),
			onClick: () => {
				const hidden = searchInput.style.display === "none";
				searchInput.style.display = hidden ? "" : "none";
				if (hidden) searchInput.focus();
			},
		});
		head.insertBefore(searchBtn, searchInput);
	}

	// 全局点击关闭弹出层
	document.addEventListener("click", (e) => {
		if (activePopMenu && !activePopMenu.contains(e.target)) {
			closePopMenu();
		}
	});

	function closePopMenu() {
		if (activePopMenu) {
			activePopMenu.remove();
			activePopMenu = null;
		}
	}

	function autoGrowComposer() {
		composerText.style.height = "auto";
		composerText.style.height = `${Math.min(composerText.scrollHeight, 220)}px`;
	}

	function checkSmartTimeSuggest() {
		const text = composerText.value;
		if (composerReminder) {
			smartSuggestChip.style.display = "none";
			detectedSmartTime = null;
			return;
		}
		const found = S.detectTimeFromText(text);
		if (found) {
			detectedSmartTime = found;
			smartSuggestChip.textContent = `💡 ${t("quick.smartSuggest", { time: found.timeLabel })}`;
			smartSuggestChip.style.display = "inline-flex";
		} else {
			smartSuggestChip.style.display = "none";
			detectedSmartTime = null;
		}
	}

	function applySmartSuggest() {
		if (!detectedSmartTime) return;
		setComposerReminder({
			schedule: { type: "once", at: detectedSmartTime.stamp },
			enabled: true,
		});
		smartSuggestChip.style.display = "none";
		detectedSmartTime = null;
	}

	function setComposerReminder(rem) {
		composerReminder = rem;
		if (rem?.schedule) {
			composerRemBtn.style.display = "none";
			composerRemChip.textContent = "";
			const textSpan = el("span", { text: `⏰ ${reminderBadgeText(rem, t)}` });
			const xBtn = el("span", {
				class: "nt-rem-x",
				text: "✕",
				onClick: (e) => {
					e.stopPropagation();
					setComposerReminder(null);
				},
			});
			composerRemChip.append(textSpan, xBtn);
			composerRemChip.style.display = "inline-flex";
			composerRemChip.onclick = (e) => {
				e.stopPropagation();
				toggleComposerReminderPop(composerRemChip);
			};
		} else {
			composerRemBtn.style.display = "";
			composerRemChip.style.display = "none";
		}
		checkSmartTimeSuggest();
	}

	// 提醒弹出菜单
	function toggleComposerReminderPop(anchorEl) {
		if (activePopMenu) {
			closePopMenu();
			return;
		}
		const pop = buildReminderMenu((schedule) => {
			if (schedule) {
				setComposerReminder({ schedule, enabled: true });
			} else {
				setComposerReminder(null);
			}
			closePopMenu();
		});
		positionPop(pop, anchorEl);
		document.body.append(pop);
		activePopMenu = pop;
	}

	function positionPop(pop, anchorEl) {
		const rect = anchorEl.getBoundingClientRect();
		pop.style.left = `${Math.max(8, rect.left)}px`;
		pop.style.top = `${rect.bottom + 4}px`;
	}

	function buildReminderMenu(onSelect) {
		const pop = el("div", { class: "nt-pop-menu" });
		const presets = [
			{ label: t("quick.preset1h"), at: Date.now() + 3600_000 },
			{
				label: t("quick.presetTonight"),
				getAt: () => {
					const d = new Date();
					d.setHours(20, 0, 0, 0);
					if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
					return d.getTime();
				},
			},
			{
				label: t("quick.presetTomorrow"),
				getAt: () => {
					const d = new Date();
					d.setDate(d.getDate() + 1);
					d.setHours(9, 0, 0, 0);
					return d.getTime();
				},
			},
			{
				label: t("quick.presetTomorrowPm"),
				getAt: () => {
					const d = new Date();
					d.setDate(d.getDate() + 1);
					d.setHours(15, 0, 0, 0);
					return d.getTime();
				},
			},
			{
				label: t("quick.presetAfterTomorrow"),
				getAt: () => {
					const d = new Date();
					d.setDate(d.getDate() + 2);
					d.setHours(9, 0, 0, 0);
					return d.getTime();
				},
			},
			{
				label: t("quick.presetNextMonday"),
				getAt: () => {
					const d = new Date();
					const diff = (8 - d.getDay()) % 7 || 7;
					d.setDate(d.getDate() + diff);
					d.setHours(9, 0, 0, 0);
					return d.getTime();
				},
			},
		];

		for (const p of presets) {
			const btn = el("button", {
				type: "button",
				class: "nt-pop-item",
				text: p.label,
				onClick: () => {
					const ms = p.getAt ? p.getAt() : p.at;
					onSelect({ type: "once", at: S.nowStamp(ms) });
				},
			});
			pop.append(btn);
		}

		// 自定义时间
		const customWrap = el("div", { class: "nt-pop-custom" });
		const dtInput = el("input", {
			type: "datetime-local",
			class: "nt-input",
			onChange: (e) => {
				if (e.target.value) {
					onSelect({ type: "once", at: e.target.value });
				}
			},
		});
		customWrap.append(el("div", { class: "nt-hint", text: t("quick.customTime") }), dtInput);
		pop.append(customWrap);

		// 清除选项
		const clearBtn = el("button", {
			type: "button",
			class: "nt-pop-item",
			style: "color: var(--nt-red);",
			text: t("quick.clearReminder"),
			onClick: () => onSelect(null),
		});
		pop.append(clearBtn);

		return pop;
	}

	async function submitComposer() {
		const raw = composerText.value.trim();
		if (!raw) {
			composerText.focus();
			return;
		}
		// 自动从内容中解析标签 #tag
		const tagMatches = raw.match(/#[^\s#]{1,32}/g) ?? [];
		const tags = [...new Set(tagMatches.map((x) => x.slice(1)))];
		const title = S.extractTitle(raw) || "未命名笔记";

		const patch = {
			body: raw,
			title,
			tags,
			reminder: composerReminder,
		};

		const res = await data.op({ op: "note.save", item: patch });
		if (res?.ok) {
			composerText.value = "";
			composerText.style.height = "auto";
			setComposerReminder(null);
			state.inlineEditId = null;
			renderList();
		} else {
			notifyError(res?.error || "save failed");
		}
	}

	// ---------------------------------------------------------------- 数据订阅
	const unsubscribe = data.subscribe((next) => {
		snapshot = next;
		render();
	});

	function store() {
		return snapshot.store;
	}

	function render() {
		const counts = S.counts(store());
		for (const [tab, btn] of Object.entries(tabButtons)) {
			btn.className = `nt-tab${state.tab === tab ? " on" : ""}`;
			btn.textContent = t(`tab.${tab}`);
			if (tab === "note" && counts.notes) {
				btn.append(el("span", { class: "nt-count", text: String(counts.notes) }));
			}
		}
		composerWrap.style.display = state.tab === "note" ? "" : "none";
		renderList();
		renderFoot(counts);
	}

	function renderFoot(counts) {
		footEl.textContent = "";
		const status = snapshot.status;
		const dotClass = status === "online" ? "nt-dot" : status === "offline" ? "nt-dot nt-bad" : "nt-dot nt-busy";
		const statusText = status === "online" ? "" : status === "offline" ? t("status.offline") : t("status.syncing");
		footEl.append(el("span", { class: dotClass, title: statusText || "online" }));

		const totalRem = store().reminders.length;
		const remCountText =
			totalRem > 0
				? t("status.notesRemCount", { n: counts.notes, m: totalRem })
				: t("status.notesTotal", { n: counts.notes });
		footEl.append(el("span", { text: remCountText }));

		const nextRem = nextReminder();
		if (nextRem) {
			footEl.append(el("span", { class: "nt-foot-rem", text: `⏰ ${formatWhen(nextRem.ms, t)} ${nextRem.text}` }));
		}
		if (status === "offline") footEl.append(el("span", { text: statusText }));

		footEl.append(el("span", { class: "nt-grow" }));
	}

	function nextReminder() {
		let best = null;
		for (const rem of store().reminders) {
			const ms = data.nextAt(rem);
			if (ms && (!best || ms < best.ms)) best = { ms, text: rem.text };
		}
		return best;
	}

	// ---------------------------------------------------------------- 列表渲染
	function renderList() {
		listEl.textContent = "";
		if (state.tab === "calendar") {
			renderCalendar(listEl);
			return;
		}

		// 笔记流渲染 (Notes Stream)
		const allNotes = [...store().notes];
		// 排序：置顶优先，其次按 updatedAt 倒序
		allNotes.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
		});

		// 搜索与标签过滤
		const query = state.query.trim().toLowerCase();
		const filtered = allNotes.filter((n) => {
			if (!query) return true;
			const inTitle = (n.title || "").toLowerCase().includes(query);
			const inBody = (n.body || "").toLowerCase().includes(query);
			const inTags = (n.tags || []).some((tag) => tag.toLowerCase().includes(query.replace(/^#/, "")));
			return inTitle || inBody || inTags;
		});

		if (!filtered.length) {
			listEl.append(el("div", { class: "nt-empty", text: query ? t("empty.search") : t("empty.note") }));
			return;
		}

		const cardsWrap = el("div", { class: "nt-cards" });
		for (const note of filtered) {
			if (state.inlineEditId === note.id) {
				cardsWrap.append(renderInlineEditCard(note));
			} else {
				cardsWrap.append(renderNoteCard(note));
			}
		}
		listEl.append(cardsWrap);
	}

	async function executeDeleteNote(id) {
		if (state.inlineEditId === id) state.inlineEditId = null;
		const res = await data.op({ op: "note.remove", id });
		if (res?.ok === false) {
			notifyError(res.error ?? "delete failed");
		} else {
			const list = store().notes;
			const idx = list.findIndex((n) => n.id === id);
			if (idx >= 0) list.splice(idx, 1);
			renderList();
		}
	}

	// ---------------- 单条笔记卡片 (Card) ----------------
	function renderNoteCard(note) {
		const card = el("div", {
			class: `nt-card${note.pinned ? " nt-pinned" : ""}`,
		});

		// 头部元信息
		const headEl = el("div", { class: "nt-card-head" });
		const timeEl = el("span", {
			class: "nt-card-time",
			text: formatRelativeTime(note.updatedAt || note.createdAt, t),
			title: (note.updatedAt || note.createdAt || "").replace("T", " "),
		});
		headEl.append(timeEl);

		if (note.pinned) {
			headEl.append(el("span", { class: "nt-card-pin-icon", text: "📌", title: t("action.pin") }));
		}

		// 提醒状态徽标
		if (note.reminder?.schedule) {
			const rem = note.reminder;
			const isOnce = rem.schedule.type === "once";
			const dueMs = isOnce ? new Date(rem.schedule.at).getTime() : 0;
			const isOverdue = isOnce && dueMs < Date.now();
			const badge = el("span", {
				class: `nt-rem-chip${isOverdue ? " nt-overdue" : ""}`,
				text: `⏰ ${reminderBadgeText(rem, t)}`,
				title: isOverdue ? t("due.overdue") : "",
				onClick: (e) => {
					e.stopPropagation();
					toggleCardReminderMenu(badge, note);
				},
			});
			headEl.append(badge);
		}

		// 标签
		for (const tag of note.tags ?? []) {
			const tagChip = el("span", {
				class: "nt-tag",
				text: `#${tag}`,
				onClick: (e) => {
					e.stopPropagation();
					state.query = `#${tag}`;
					if (searchInput) searchInput.value = state.query;
					renderList();
				},
			});
			headEl.append(tagChip);
		}

		// 右侧悬浮操作组
		const ops = el("div", { class: "nt-card-ops" });

		const editBtn = el("button", {
			type: "button",
			class: "nt-op-btn",
			text: "✏️",
			title: t("action.edit"),
			onClick: (e) => {
				e.stopPropagation();
				state.inlineEditId = note.id;
				renderList();
			},
		});

		const pinBtn = el("button", {
			type: "button",
			class: "nt-op-btn",
			text: note.pinned ? "📍" : "📌",
			title: note.pinned ? t("action.unpin") : t("action.pin"),
			onClick: (e) => {
				e.stopPropagation();
				void data.op({ op: "note.save", item: { id: note.id, pinned: !note.pinned } });
			},
		});

		const remBtn = el("button", {
			type: "button",
			class: "nt-op-btn",
			text: "⏰",
			title: t("quick.setReminder"),
			onClick: (e) => {
				e.stopPropagation();
				toggleCardReminderMenu(remBtn, note);
			},
		});

		const copyBtn = el("button", {
			type: "button",
			class: "nt-op-btn",
			text: "📋",
			title: t("action.copy"),
			onClick: (e) => {
				e.stopPropagation();
				void copyItemText(copyBtn, note.body || note.title);
			},
		});

		const quoteBtn = el("button", {
			type: "button",
			class: "nt-op-btn",
			text: "💬",
			title: t("action.quote"),
			onClick: (e) => {
				e.stopPropagation();
				quoteItemText(note.body || note.title);
			},
		});

		// 删除按钮：点击变为打勾按钮，再次点击确认删除
		let delTimer = null;
		const delBtn = el("button", {
			type: "button",
			class: "nt-op-btn nt-del",
			text: "✕",
			title: t("action.delete"),
			onClick: async (e) => {
				e.stopPropagation();
				if (delBtn.dataset.confirming === "1") {
					if (delTimer) clearTimeout(delTimer);
					delBtn.dataset.confirming = "0";
					delBtn.disabled = true;
					await executeDeleteNote(note.id);
					return;
				}
				delBtn.dataset.confirming = "1";
				delBtn.textContent = "✓";
				delBtn.classList.add("nt-del-confirm");
				delBtn.title = `${t("action.delete")} (再次点击确认)`;
				delTimer = setTimeout(() => {
					delBtn.dataset.confirming = "0";
					delBtn.textContent = "✕";
					delBtn.classList.remove("nt-del-confirm");
					delBtn.title = t("action.delete");
				}, 3000);
			},
		});

		ops.append(editBtn, pinBtn, remBtn, copyBtn, quoteBtn, delBtn);
		headEl.append(ops);
		card.append(headEl);

		// 正文区（支持双击就地编辑）
		const bodyEl = el("div", {
			class: "nt-card-body",
			onDblClick: () => {
				state.inlineEditId = note.id;
				renderList();
			},
		});

		// 任务复选框切换
		const onToggleTask = (lineIndex, nextChecked) => {
			const lines = (note.body || "").split("\n");
			if (lines[lineIndex] !== undefined) {
				lines[lineIndex] = lines[lineIndex].replace(/^(\s*[-*]\s*)\[([ xX])\]/, `$1[${nextChecked ? "x" : " "}]`);
				const newBody = lines.join("\n");
				void data.op({ op: "note.save", item: { id: note.id, body: newBody } });
			}
		};

		bodyEl.append(renderMarkdown(note.body || note.title, onToggleTask));
		card.append(bodyEl);

		return card;
	}

	// ---------------- 就地快速内联编辑卡片 (Inline Edit) ----------------
	function renderInlineEditCard(note) {
		const card = el("div", { class: "nt-card nt-editing" });
		let draftReminder = note.reminder;
		let draftPinned = note.pinned;

		const textarea = el("textarea", {
			class: "nt-card-edit-area",
			value: note.body || note.title || "",
			onKeyDown: (e) => {
				if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
					e.preventDefault();
					void doSave();
				}
				if (e.key === "Escape") {
					e.preventDefault();
					state.inlineEditId = null;
					renderList();
				}
			},
		});

		// 自动撑开
		setTimeout(() => {
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight + 10, 320)}px`;
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		}, 20);

		// 底栏与工具
		const editFoot = el("div", { class: "nt-card-edit-foot" });
		const leftTools = el("div", { class: "nt-inline-row" });

		const remBtn = el("button", {
			type: "button",
			class: "nt-btn nt-icon",
			text: draftReminder?.schedule ? `⏰ ${reminderBadgeText(draftReminder, t)}` : `⏰ ${t("quick.setReminder")}`,
			onClick: (e) => {
				e.stopPropagation();
				const pop = buildReminderMenu((sched) => {
					draftReminder = sched ? { schedule: sched, enabled: true } : null;
					remBtn.textContent = draftReminder?.schedule
						? `⏰ ${reminderBadgeText(draftReminder, t)}`
						: `⏰ ${t("quick.setReminder")}`;
					closePopMenu();
				});
				positionPop(pop, remBtn);
				document.body.append(pop);
				activePopMenu = pop;
			},
		});

		const pinLabel = el("label", { class: "nt-checkline", style: "font-size: 11px;" });
		const pinChk = el("input", {
			type: "checkbox",
			checked: draftPinned,
			onChange: (e) => {
				draftPinned = e.target.checked;
			},
		});
		pinLabel.append(pinChk, el("span", { text: t("field.pinned") }));

		let inlineDelTimer = null;
		const inlineDelBtn = el("button", {
			type: "button",
			class: "nt-btn nt-danger",
			text: "✕",
			title: t("action.delete"),
			onClick: async (e) => {
				e.stopPropagation();
				if (inlineDelBtn.dataset.confirming === "1") {
					if (inlineDelTimer) clearTimeout(inlineDelTimer);
					inlineDelBtn.dataset.confirming = "0";
					inlineDelBtn.disabled = true;
					await executeDeleteNote(note.id);
					return;
				}
				inlineDelBtn.dataset.confirming = "1";
				inlineDelBtn.textContent = "✓";
				inlineDelBtn.title = `${t("action.delete")} (再次点击确认)`;
				inlineDelTimer = setTimeout(() => {
					inlineDelBtn.dataset.confirming = "0";
					inlineDelBtn.textContent = "✕";
					inlineDelBtn.title = t("action.delete");
				}, 3000);
			},
		});

		leftTools.append(remBtn, pinLabel, inlineDelBtn);

		const rightBtns = el("div", { class: "nt-inline-row" });
		const cancelBtn = el("button", {
			type: "button",
			class: "nt-btn",
			text: t("action.cancel"),
			onClick: () => {
				state.inlineEditId = null;
				renderList();
			},
		});

		const saveBtn = el("button", {
			type: "button",
			class: "nt-btn nt-btn-primary",
			text: `${t("action.save")} (Ctrl+↵)`,
			onClick: () => void doSave(),
		});

		rightBtns.append(cancelBtn, saveBtn);
		editFoot.append(leftTools, rightBtns);

		card.append(textarea, editFoot);

		async function doSave() {
			const body = textarea.value.trim();
			if (!body) {
				state.inlineEditId = null;
				renderList();
				return;
			}
			const tagMatches = body.match(/#[^\s#]{1,32}/g) ?? [];
			const tags = [...new Set(tagMatches.map((x) => x.slice(1)))];
			const title = S.extractTitle(body) || "未命名笔记";

			const patch = {
				id: note.id,
				body,
				title,
				tags,
				pinned: draftPinned,
				reminder: draftReminder,
			};
			await data.op({ op: "note.save", item: patch });
			state.inlineEditId = null;
			renderList();
		}

		return card;
	}

	function toggleCardReminderMenu(anchorEl, note) {
		if (activePopMenu) {
			closePopMenu();
			return;
		}
		const pop = buildReminderMenu(async (schedule) => {
			const patch = {
				id: note.id,
				reminder: schedule ? { schedule, enabled: true } : null,
			};
			await data.op({ op: "note.save", item: patch });
			closePopMenu();
			renderList();
		});
		positionPop(pop, anchorEl);
		document.body.append(pop);
		activePopMenu = pop;
	}

	// ---------------------------------------------------------------- 日历 (Calendar)
	function renderCalendar(container) {
		const monthStart = state.month;
		const monthEnd = addMonths(monthStart, 1);
		const todayKey = dayKey(Date.now());
		const selectedKey = dayKey(state.day);

		const buckets = new Map();
		const ensureBucket = (key) => {
			let b = buckets.get(key);
			if (!b) {
				b = { todos: [], reminders: [] };
				buckets.set(key, b);
			}
			return b;
		};

		// 待办截止
		for (const todo of store().todos) {
			if (!todo.due) continue;
			const ms = new Date(todo.due).getTime();
			if (ms >= monthStart && ms < monthEnd) {
				ensureBucket(dayKey(ms)).todos.push(todo);
			}
		}

		// 提醒
		for (const rem of store().reminders) {
			if (!rem.enabled) continue;
			const occs = occurrencesBetween(rem.schedule, monthStart, monthEnd);
			for (const at of occs) {
				ensureBucket(dayKey(at)).reminders.push({ rem, at });
			}
		}

		// 头部控制行
		const head = el(
			"div",
			{ class: "nt-cal-head" },
			el("button", {
				type: "button",
				class: "nt-btn nt-icon",
				text: "‹",
				title: t("cal.prev"),
				onClick: () => {
					state.month = addMonths(state.month, -1);
					renderList();
				},
			}),
			el("span", {
				class: "nt-cal-title",
				text: t("cal.month", { y: new Date(monthStart).getFullYear(), m: new Date(monthStart).getMonth() + 1 }),
			}),
			el("button", {
				type: "button",
				class: "nt-btn nt-icon",
				text: "›",
				title: t("cal.next"),
				onClick: () => {
					state.month = addMonths(state.month, 1);
					renderList();
				},
			}),
			el("span", { class: "nt-grow" }),
			el("button", {
				type: "button",
				class: "nt-btn",
				text: t("cal.today"),
				onClick: () => {
					state.month = startOfMonth(Date.now());
					state.day = startOfDay(Date.now());
					renderList();
				},
			}),
		);
		container.append(head);

		// 星期表头
		const grid = el("div", { class: "nt-cal-grid" });
		for (let i = 0; i < 7; i++) {
			grid.append(el("div", { class: "nt-cal-wd", text: t(`week.${(i + 1) % 7}`) }));
		}

		// 42 天格子
		const firstCell = addDays(startOfMonth(monthStart), -((new Date(monthStart).getDay() + 6) % 7));
		for (let i = 0; i < 42; i++) {
			const dayMs = addDays(firstCell, i);
			const key = dayKey(dayMs);
			const entry = buckets.get(key);
			const count = (entry?.todos.length ?? 0) + (entry?.reminders.length ?? 0);
			const cell = el("div", {
				class:
					"nt-cal-cell" +
					(new Date(dayMs).getMonth() !== new Date(monthStart).getMonth() ? " nt-out" : "") +
					(key === todayKey ? " nt-today" : "") +
					(key === selectedKey ? " nt-sel" : ""),
				dataset: { day: key },
				onClick: () => {
					state.day = dayMs;
					renderList();
				},
			});
			cell.append(el("div", { class: "nt-cal-day", text: String(new Date(dayMs).getDate()) }));
			const chips = el("div", { class: "nt-cal-chips" });
			let shown = 0;
			for (const todo of entry?.todos ?? []) {
				if (shown >= 3) break;
				chips.append(el("div", { class: `nt-cal-chip${todo.done ? " nt-done" : ""}`, text: `• ${todo.text}` }));
				shown++;
			}
			for (const { rem, at } of entry?.reminders ?? []) {
				if (shown >= 3) break;
				chips.append(el("div", { class: "nt-cal-chip nt-rem", text: `⏰ ${fmtHM(at)} ${rem.text}` }));
				shown++;
			}
			if (count > shown) {
				chips.append(el("div", { class: "nt-cal-chip nt-more", text: t("cal.more", { n: count - shown }) }));
			}
			cell.append(chips);
			grid.append(cell);
		}
		container.append(grid);

		// 选中当天的清单
		const entry = buckets.get(selectedKey);
		const detail = el("div", { class: "nt-cal-detail" });
		const selected = new Date(state.day);

		const detailHead = el("div", { class: "nt-inline-row", style: "margin-bottom: 6px;" });
		detailHead.append(
			el("div", {
				class: "nt-group",
				style: "padding: 0;",
				text: `${selected.getFullYear()}-${pad2(selected.getMonth() + 1)}-${pad2(selected.getDate())} (${t(`week.${selected.getDay()}`)})`,
			}),
			el("span", { class: "nt-grow" }),
			el("button", {
				type: "button",
				class: "nt-btn",
				text: `📝 ${t("quick.newNoteOnDay")}`,
				onClick: () => {
					// 切回笔记 tab，并预置好那一天的 09:00 提醒
					state.tab = "note";
					writeTab("note");
					const d = new Date(state.day);
					d.setHours(9, 0, 0, 0);
					setComposerReminder({
						schedule: { type: "once", at: S.nowStamp(d.getTime()) },
						enabled: true,
					});
					render();
					composerText.focus();
				},
			}),
		);
		detail.append(detailHead);

		if (!entry || (!entry.todos.length && !entry.reminders.length)) {
			detail.append(el("div", { class: "nt-empty", text: t("cal.empty") }));
		} else {
			for (const todo of entry.todos) {
				const row = el(
					"div",
					{ class: "nt-item" },
					el("input", {
						type: "checkbox",
						class: "nt-check",
						checked: todo.done,
						onChange: () => void data.op({ op: "todo.save", item: { id: todo.id, done: !todo.done } }),
					}),
					el("div", {
						class: "nt-main",
						children: [
							el("div", {
								class: `nt-title${todo.done ? " nt-done" : ""}`,
								text: todo.text,
							}),
						],
					}),
				);
				detail.append(row);
			}
			for (const { rem, at } of entry.reminders) {
				const row = el(
					"div",
					{ class: "nt-item" },
					el("span", { text: "⏰" }),
					el("div", {
						class: "nt-main",
						children: [
							el("div", { class: "nt-title", text: rem.text }),
							el("div", { class: "nt-meta", text: fmtHM(at) }),
						],
					}),
				);
				detail.append(row);
			}
		}
		container.append(detail);
	}

	// ---------------- 辅助工具 ----------------
	async function copyItemText(btn, text) {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.append(ta);
				ta.select();
				ok = document.execCommand("copy");
				ta.remove();
			} catch {
				ok = false;
			}
		}
		if (btn) {
			const old = btn.textContent;
			btn.textContent = ok ? "✓" : "!";
			setTimeout(() => {
				btn.textContent = old;
			}, 900);
		}
	}

	function quoteItemText(text) {
		let ok = false;
		try {
			ok = (hostApi() ?? globalThis.window?.__piWebUiHost)?.compose?.({ text }) ?? false;
		} catch {
			ok = false;
		}
		if (!ok) {
			notifyInfo(t("action.composerBusy"));
			void copyItemText(null, text);
		}
	}

	function notifyInfo(text) {
		toast(text);
	}
	function notifyError(text) {
		toast(`✗ ${text}`);
	}
	function toast(text) {
		try {
			options.onNotify?.(text);
		} catch {
			/* ignore */
		}
	}

	return {
		el: root,
		destroy() {
			unsubscribe();
			closePopMenu();
			root.textContent = "";
		},
		focusQuickInput() {
			composerText.focus();
		},
		render,
	};
}

function readTab() {
	try {
		const v = localStorage.getItem("notes:tab");
		if (v && ["note", "calendar"].includes(v)) return v;
	} catch {
		/* ignore */
	}
	return "note";
}

function writeTab(tab) {
	try {
		localStorage.setItem("notes:tab", tab);
	} catch {
		/* ignore */
	}
}
