/// <reference path="../chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 拾取 overlay + 状态机（content script，注入到被调试页面）。
 *
 * 隔离：整套 UI 挂在**闭合 Shadow DOM** 里（`:host { all: initial }` 兜底），页面 CSS
 * 进不来、我们的样式出不去 —— 否则页面一个 `button { width: 100% }` 就能把浮层搞乱，
 * 我们也可能污染页面。
 *
 * 状态机：
 *   idle → picking ──(普通点击 / Enter)──→ editing ──(添加到对话)──→ idle
 *            ↑                                  │
 *            └──────(Shift+点击 / 「继续选」)────┘
 *            │
 *            └──(Esc)──→ idle（丢弃）
 *
 * 每个元素在**点击那一刻**就取快照：之后页面可能重渲染（React 换掉 DOM 节点），
 * 那时候再去读就晚了。
 *
 * closed shadow 的坑：从 window 上的监听器看事件，target 会被**重定向到 host**，
 * `composedPath()` 也拿不到内部节点 —— 所以「事件是不是发生在我们的 UI 里」只能靠
 * `host.contains(e.target)` 判断，而输入框里的 Enter/Esc 直接挂输入框自己的监听器。
 */

import {
	PICK_SECTIONS,
	SECTION_PRESETS,
	applySectionToggle,
	makePickId,
	presetHotkeyIndex,
	presetShortLabel,
	type DetailLevel,
	type PickPayload,
	type PickSection,
	type PickedElement,
} from "../shared/contract.js";
import { pageContext, snapshotElement } from "./element.js";
import { createPresetControls } from "./preset-controls.js";

const FLAG = "__piWebUiPagePicker";
const HOST_ID = "pi-page-picker-host";

interface PickerRuntime {
	start: (opts?: { detail?: DetailLevel; sections?: PickSection[] }) => void;
	destroy: () => void;
}

interface Picked {
	el: Element;
	snapshot: PickedElement["snapshot"];
	note: string;
}

type Phase = "picking" | "editing";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.hl, .pick { position: fixed; pointer-events: none; }
.hl { border: 2px solid #3b82f6; background: rgba(59,130,246,.14); }
.pick { border: 1px dashed #22c55e; background: rgba(34,197,94,.10); }
.n {
  position: absolute; top: -9px; left: -9px; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; background: #22c55e; color: #fff; font-size: 11px; line-height: 18px;
  text-align: center; font-weight: 600;
}
.tag {
  position: absolute; left: -2px; bottom: -22px; max-width: 60vw; padding: 2px 6px;
  background: #3b82f6; color: #fff; font-size: 11px; line-height: 16px; border-radius: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pick .tag { background: #22c55e; }
.hud {
  position: fixed; top: 14px; left: 0; right: 0; z-index: 10;
  /* 宽度：fit-content + 两侧 auto 居中 —— 不能用 left:50% + translateX(-50%)，
     那只给了它 **50vw** 的可用宽度（left 到右边缘），挤到极限时文字会被压成竖排 */
  width: fit-content; max-width: 92vw; margin: 0 auto;
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px;
  background: rgba(17,24,39,.94); color: #e5e7eb; font-size: 13px;
  /* 纯信息条：绝不能可点 —— 否则它会挡住页面顶部元素的点击（拾取器最不能犯的错） */
  pointer-events: none;
  /* 挤不下时整项换行（而不是把字压成竖排） */
  flex-wrap: wrap; justify-content: center;
  box-shadow: 0 6px 24px rgba(0,0,0,.35);
}
.hud > * { white-space: nowrap; }
.hud b { color: #93c5fd; font-weight: 600; }
.hud .k { padding: 1px 5px; border: 1px solid #4b5563; border-radius: 4px; font-size: 11px; color: #9ca3af; }
.bar {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  width: min(680px, 92vw); padding: 12px; border-radius: 10px; pointer-events: auto;
  background: rgba(17,24,39,.97); color: #e5e7eb; font-size: 13px;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
.rows { max-height: 34vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; }
.idx {
  flex: 0 0 20px; height: 20px; border-radius: 50%; background: #22c55e; color: #fff;
  font-size: 11px; line-height: 20px; text-align: center;
}
.sel {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #9ca3af; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
}
input[type=text] {
  flex: 1 1 auto; min-width: 0; padding: 4px 8px; border-radius: 5px; font-size: 12px;
  border: 1px solid #374151; background: #111827; color: #e5e7eb;
}
input[type=text]:focus { outline: none; border-color: #3b82f6; }
.row input { flex: 0 0 44%; }
button { padding: 5px 10px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #e5e7eb; font-size: 12px; cursor: pointer; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
button:hover { filter: brightness(1.15); }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.foot .grow { flex: 1 1 auto; }
.toast {
  position: fixed; bottom: 18px; left: 0; right: 0; margin: 0 auto;
  width: fit-content; max-width: 92vw;
  padding: 10px 14px; border-radius: 8px; background: rgba(17,24,39,.97); color: #e5e7eb;
  font-size: 13px; pointer-events: none; box-shadow: 0 8px 26px rgba(0,0,0,.4);
}
.toast.ok { border-left: 3px solid #22c55e; }
.toast.err { border-left: 3px solid #ef4444; }
/* 预设行：六个 chip 一键套组合，右边「调整项」展开逐项勾（默认收起，浮条只占一行） */
.preset-box { margin-top: 10px; border-top: 1px solid #1f2937; padding-top: 10px; }
.presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.presets .plabel { color: #94a3b8; font-size: 12px; }
.presets .grow { flex: 1 1 auto; }
.chip {
  padding: 3px 9px; border-radius: 999px; border: 1px solid #374151; background: #1f2937;
  color: #cbd5e1; font-size: 12px; cursor: pointer;
}
.chip.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.chip.custom { cursor: default; border-style: dashed; }
.chip.custom.active { background: #374151; border-color: #4b5563; color: #e5e7eb; font-weight: 600; }
.link { padding: 3px 8px; border: none; background: none; color: #93c5fd; font-size: 12px; cursor: pointer; }
.link:hover { text-decoration: underline; filter: none; }
.sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 2px 10px; margin-top: 8px; }
.sections .sec { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1; }
.sump { color: #94a3b8; font-size: 11px; margin-top: 6px; }
.hidden { display: none !important; }
`;

/** 焦点在可编辑元素里吗（页面上正打字时绝不抢它的键盘）。 */
function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const tag = target.tagName.toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select" || (target as HTMLElement).isContentEditable;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v);
	}
	for (const child of children) node.append(child);
	return node;
}

function createPicker(): PickerRuntime {
	let phase: Phase = "picking";
	let picked: Picked[] = [];
	let hovered: Element | null = null;
	let detail: DetailLevel = "standard";
	let sections: PickSection[] | undefined; // undefined = 没拿到设置 → 采集层按「全采」宽容处理
	let note = "";
	let rafId = 0;
	let stopped = true;

	const host = el("div", { id: HOST_ID });
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
	const shadow = host.attachShadow({ mode: "closed" });
	const hl = el("div", { class: "hl hidden" });
	const picks = el("div");
	const hud = el("div", { class: "hud" });
	const bar = el("div", { class: "bar hidden" });
	const toast = el("div", { class: "toast hidden" });
	shadow.append(el("style", { text: CSS }), hl, picks, hud, bar, toast);

	const rows = el("div", { class: "rows" });
	// 预设控件：**改设置不用再去扩展选项页** —— chip 一键套组合，展开还能逐项勾。
	// 三个回调都汇到 applyPickOptions / applyPreset 这一个口上（重采 + 重画 + 写回只写一遍）。
	let optionsNotice = ""; // 写回设置失败时挂在摘要行上（确认条正开着，不宜拿 toast 遮它）
	const presets = createPresetControls({
		onPreset: (id) => applyPreset(id),
		onToggleSection: (key, on) => applyPickOptions(detail, applySectionToggle(effectiveSections(), key, on)),
		onRefuseEmpty: () => showToast("至少要留一项：全不勾会回落成标准组合", "err"),
	});
	const noteInput = el("input", { type: "text", placeholder: "整体说明（可选）：比如「这三处间距不一致」" });
	// 勾选项里按 Esc 也要能退（焦点落在我们自己的 UI 里时，全局键盘监听会跳过）—— 与备注框一致
	presets.root.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.stopPropagation();
		if (phase === "editing") setPhase("picking");
		else stop();
	});
	const sendBtn = el("button", { class: "primary", text: "添加到对话" });
	const moreBtn = el("button", { text: "继续选" });
	const cancelBtn = el("button", { text: "取消" });
	bar.append(
		rows,
		presets.root,
		noteInput,
		el("div", { class: "foot" }, [el("span", { class: "grow" }), moreBtn, cancelBtn, sendBtn]),
	);

	// ------------------------------------------------------------------ 渲染

	const place = (box: HTMLElement, node: Element, label: string, cls: string): void => {
		const r = node.getBoundingClientRect();
		box.style.left = `${r.left}px`;
		box.style.top = `${r.top}px`;
		box.style.width = `${r.width}px`;
		box.style.height = `${r.height}px`;
		box.className = cls;
		let tag = box.querySelector<HTMLElement>(".tag");
		if (!tag) {
			tag = el("div", { class: "tag" });
			box.append(tag);
		}
		tag.textContent = label;
	};

	const renderPicks = (): void => {
		while (picks.childElementCount > picked.length) picks.lastElementChild?.remove();
		picked.forEach((p, i) => {
			let box = picks.children[i] as HTMLElement | undefined;
			if (!box) {
				box = el("div", { class: "pick" });
				box.append(el("div", { class: "n", text: String(i + 1) }));
				picks.append(box);
			}
			const badge = box.querySelector<HTMLElement>(".n");
			if (badge) badge.textContent = String(i + 1);
			// 元素可能已被页面移除（SPA 换页）→ 框跟着消失，不留幽灵框
			if (!p.el.isConnected) {
				box.className = "pick hidden";
				return;
			}
			place(box, p.el, p.snapshot.selector, "pick");
		});
	};

	const renderHover = (): void => {
		if (phase !== "picking" || !hovered || !hovered.isConnected) {
			hl.className = "hl hidden";
			return;
		}
		place(hl, hovered, hovered.tagName.toLowerCase(), "hl");
	};

	const renderHud = (): void => {
		const parts: (Node | string)[] = [];
		if (phase === "picking") {
			parts.push(
				el("span", { text: picked.length > 0 ? `继续点击追加，或` : "点击拾取元素" }),
				el("span", { class: "k", text: "Shift+点击" }),
				el("span", { text: "多选" }),
				el("span", { class: "k", text: "Enter" }),
				el("span", { text: "完成" }),
				el("span", { class: "k", text: "Esc" }),
				el("span", { text: "退出" }),
			);
			if (picked.length > 0) parts.unshift(el("b", { text: `已选 ${picked.length}` }));
			// 当前预设写在这里（HUD 是不可点的纯信息条）—— 确认条里有 chip，这里只报「现在是哪个」
			parts.push(el("span", { text: "预设" }), el("b", { text: presetShortLabel(effectiveSections()) }));
		} else {
			parts.push(
				el("b", { text: `已选 ${picked.length} 个元素` }),
				el("span", { text: "确认后点「添加到对话」" }),
				el("span", { class: "k", text: "Ctrl+Enter" }),
				el("span", { text: "直接发送" }),
			);
		}
		hud.replaceChildren(...parts);
	};

	const renderBar = (): void => {
		bar.classList.toggle("hidden", phase !== "editing");
		if (phase !== "editing") return;
		const rowNodes: Node[] = picked.map((p, i) => {
			const idx = el("div", { class: "idx", text: String(i + 1) });
			const sel = el("div", { class: "sel", text: p.snapshot.selector });
			sel.title = p.snapshot.selector;
			const input = el("input", { type: "text", placeholder: "这个元素的问题（可选）" });
			input.value = p.note;
			input.addEventListener("input", () => {
				p.note = input.value;
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void send();
				if (e.key === "Escape") setPhase("picking");
			});
			const del = el("button", { text: "✕" });
			del.addEventListener("click", () => {
				picked.splice(i, 1);
				if (picked.length === 0) setPhase("picking");
				else {
					renderBar();
					renderHud();
				}
			});
			return el("div", { class: "row" }, [idx, sel, input, del]);
		});
		rows.replaceChildren(...rowNodes);
		noteInput.value = note;
		presets.render({
			detail,
			sections: effectiveSections(),
			...(optionsNotice ? { notice: optionsNotice } : {}),
		});
	};

	// ------------------------------------------------------------------ 预设 / 勾选项

	/** 当前**实际**要发的项（设置没取到时显示全采 —— 与采集层的宽容语义一致）。 */
	const effectiveSections = (): PickSection[] => sections ?? [...PICK_SECTIONS];

	/**
	 * 预设 / 逐项勾选的**唯一入口**：改状态 → 重采已选元素 → 重画 → 写回设置。
	 *
	 * 为什么要重采（而不是只影响下一个选的元素）：快照是点击那一刻取的，不重采就会出现
	 * 「浮条上写着精简、发出去的还是完整档」—— 用户改设置的全部目的就是改**这次**发什么。
	 */
	const applyPickOptions = (nextDetail: DetailLevel, nextSections: PickSection[]): void => {
		detail = nextDetail;
		sections = nextSections;
		optionsNotice = ""; // 新的一次选择清掉上一次的失败提示
		resnapshotPicked();
		renderHud();
		renderBar();
		void persistPickOptions();
	};

	const applyPreset = (id: string): void => {
		const preset = SECTION_PRESETS.find((p) => p.id === id);
		if (!preset) return;
		applyPickOptions(preset.depth, [...preset.sections]);
	};

	/** 已选元素按新设置重新采一遍（元素已被页面换掉就留着旧快照，不弄丢）。 */
	const resnapshotPicked = (): void => {
		let failed = 0;
		for (const p of picked) {
			if (!p.el.isConnected) continue;
			try {
				p.snapshot = snapshotElement(p.el, { detail, sections });
			} catch {
				failed++;
			}
		}
		if (failed > 0) showToast(`${failed} 个元素按新设置重采失败（保留原来的内容）`, "err");
	};

	/**
	 * 把这次的选择写回扩展设置（选项页同步可见，下次拾取沿用）。
	 *
	 * 失败**不阻断拾取**：本地已经生效了，这条消息只是「记住它」。但必须说出来 ——
	 * 静默失败会让人以为下次也是这个档位。
	 */
	async function persistPickOptions(): Promise<void> {
		let res: { ok?: boolean; detail?: DetailLevel; sections?: PickSection[] } | undefined;
		try {
			res = (await chrome.runtime.sendMessage({ type: "page-picker:set-sections", detail, sections })) as
				{ ok?: boolean; detail?: DetailLevel; sections?: PickSection[] } | undefined;
		} catch {
			/* 后台没响应 → 下面统一提示 */
		}
		if (!res?.ok) {
			optionsNotice = "没同步到扩展设置（这次的选择只在本页生效）";
			renderBar();
			return;
		}
		// 后台做过归一（比如空列表回落标准组合）→ 以它为准，别让浮条显示一个不会生效的状态
		if (res.detail) detail = res.detail;
		if (res.sections) sections = res.sections;
		renderHud();
		renderBar();
	}

	const setPhase = (next: Phase): void => {
		phase = next;
		if (next === "picking") hovered = null;
		renderHover();
		renderHud();
		renderBar();
	};

	const showToast = (text: string, kind: "ok" | "err" = "ok"): void => {
		toast.textContent = text;
		toast.className = `toast ${kind}`;
		window.setTimeout(() => toast.classList.add("hidden"), 3600);
	};

	// ------------------------------------------------------------------ 事件

	/** 每帧重画：滚动、平滑滚动、动画、布局抖动都能跟上（比只监听 scroll 可靠）。 */
	const tick = (): void => {
		if (stopped) return;
		renderHover();
		renderPicks();
		rafId = window.requestAnimationFrame(tick);
	};

	const swallow = (e: Event): void => {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
	};

	const onPointerMove = (e: PointerEvent): void => {
		if (phase !== "picking") return;
		const target = e.target;
		if (!(target instanceof Element) || host.contains(target)) return;
		hovered = target;
	};

	const onMouseDown = (e: MouseEvent): void => {
		// 只在拾取阶段吞掉 mousedown：编辑备注时要能正常点我们自己的按钮
		if (phase !== "picking") return;
		if (e.target instanceof Node && host.contains(e.target)) return;
		swallow(e);
	};

	const onClick = (e: MouseEvent): void => {
		if (phase !== "picking") return;
		const target = e.target;
		if (!(target instanceof Element) || host.contains(target)) return;
		swallow(e);
		pick(target);
		if (!e.shiftKey) setPhase("editing");
	};

	const pick = (target: Element): void => {
		if (picked.some((p) => p.el === target)) {
			showToast("这个元素已经在列表里了", "err");
			return;
		}
		try {
			picked.push({ el: target, snapshot: snapshotElement(target, { detail, sections }), note: "" });
			renderHud();
			renderBar();
		} catch (err) {
			showToast(`拾取失败：${err instanceof Error ? err.message : String(err)}`, "err");
		}
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.target instanceof Node && host.contains(e.target)) return; // 我们自己的 UI
		if (e.key === "Escape") {
			swallow(e);
			if (phase === "editing") setPhase("picking");
			else stop();
			return;
		}
		// Alt+1~6 切预设：整个流程都能用键盘走完（HUD 上写着这个提示）。
		// 焦点在输入框里时不动手 —— 页面上正打字，macOS 的 Option+数字是在打 ¡ 这类字符。
		const presetIndex = presetHotkeyIndex(e);
		if (presetIndex > 0 && !isEditable(e.target)) {
			swallow(e);
			applyPreset(SECTION_PRESETS[presetIndex - 1].id);
			return;
		}
		// Ctrl/Cmd+Enter 在编辑阶段直接发送（键盘能把整套流程走完，不依赖鼠标）
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && picked.length > 0) {
			swallow(e);
			void send();
			return;
		}
		if (phase !== "picking") return;
		if (e.key === "Enter" && picked.length > 0) {
			swallow(e);
			setPhase("editing");
		} else if (e.key === "Backspace" && picked.length > 0) {
			swallow(e);
			picked.pop();
			renderHud();
		}
	};

	const onContextMenu = (e: MouseEvent): void => {
		if (phase === "picking") swallow(e);
	};

	const onPageHide = (): void => {
		stop();
	};

	// ------------------------------------------------------------------ 投递

	const buildPayload = (): PickPayload => ({
		id: makePickId(),
		pickedAt: new Date().toISOString(),
		page: pageContext(),
		detail,
		// 只有拿到设置时才写 sections（渲染层见到 undefined 会按 detail 推，老行为不丢）
		...(sections ? { sections } : {}),
		elements: picked.map((p) => ({
			snapshot: p.snapshot,
			...(p.note.trim() ? { note: p.note.trim() } : {}),
		})),
		...(note.trim() ? { note: note.trim() } : {}),
	});

	async function send(): Promise<void> {
		if (picked.length === 0) return;
		sendBtn.disabled = true;
		sendBtn.textContent = "发送中…";
		try {
			const res = (await chrome.runtime.sendMessage({ type: "page-picker:picked", payload: buildPayload() })) as
				{ ok?: boolean; message?: string; copy?: string } | undefined;
			if (res?.copy) await copyText(res.copy);
			showToast(res?.message ?? (res?.ok ? "已添加到对话" : "发送失败"), res?.ok ? "ok" : "err");
			if (res?.ok) {
				stop();
				return;
			}
		} catch (err) {
			showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, "err");
		}
		sendBtn.disabled = false;
		sendBtn.textContent = "添加到对话";
	}

	/** 剪贴板：优先 async API，失败回退 execCommand（页面未聚焦时会走到这里）。 */
	async function copyText(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			/* fall through */
		}
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.cssText = "position:fixed;left:-9999px;top:0;";
		(document.body ?? document.documentElement).appendChild(ta);
		ta.select();
		try {
			document.execCommand("copy");
		} catch {
			/* 复制失败不致命：主路径是把内容注入对话 */
		}
		ta.remove();
	}

	// ------------------------------------------------------------------ 生命周期

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		window.cancelAnimationFrame(rafId);
		window.removeEventListener("pointermove", onPointerMove, true);
		window.removeEventListener("mousedown", onMouseDown, true);
		window.removeEventListener("click", onClick, true);
		window.removeEventListener("keydown", onKeyDown, true);
		window.removeEventListener("contextmenu", onContextMenu, true);
		window.removeEventListener("pagehide", onPageHide);
		host.remove();
		const w = window as unknown as Record<string, unknown>;
		if (w[FLAG] === runtime) delete w[FLAG];
	};

	const runtime: PickerRuntime & { start: (o?: { detail?: DetailLevel; sections?: PickSection[] }) => void } = {
		start(opts): void {
			if (!stopped) {
				showToast("已经在拾取模式了");
				return;
			}
			stopped = false;
			phase = "picking";
			picked = [];
			note = "";
			hovered = null;
			if (opts?.detail) detail = opts.detail;
			if (opts?.sections) sections = opts.sections;
			noteInput.value = "";
			presets.setPanelOpen(false); // 新一轮从「只有六个 chip」开始，不叠着上轮的展开状态
			sendBtn.disabled = false;
			sendBtn.textContent = "添加到对话";
			(document.body ?? document.documentElement).append(host);
			renderHud();
			renderBar();
			renderHover();
			window.addEventListener("pointermove", onPointerMove, true);
			window.addEventListener("mousedown", onMouseDown, true);
			window.addEventListener("click", onClick, true);
			window.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("contextmenu", onContextMenu, true);
			window.addEventListener("pagehide", onPageHide);
			rafId = window.requestAnimationFrame(tick);
		},
		destroy: stop,
	};

	sendBtn.addEventListener("click", () => void send());
	moreBtn.addEventListener("click", () => setPhase("picking"));
	cancelBtn.addEventListener("click", stop);
	noteInput.addEventListener("input", () => {
		note = noteInput.value;
	});
	noteInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") void send();
		if (e.key === "Escape") setPhase("picking");
	});

	return runtime;
}

/**
 * 入口：注入一次装一次。重复注入（再点扩展图标）只是让已有实例重新开始，
 * 不会叠出第二套 overlay。设置（详细度）从 background 取，取不到就用默认。
 */
const w = window as unknown as Record<string, unknown>;
const existing = w[FLAG] as PickerRuntime | undefined;
const runtime = existing ?? createPicker();
w[FLAG] = runtime;

void (async () => {
	let detail: DetailLevel | undefined;
	let sections: PickSection[] | undefined;
	try {
		const res = (await chrome.runtime.sendMessage({ type: "page-picker:settings" })) as
			{ detail?: DetailLevel; sections?: PickSection[] } | undefined;
		detail = res?.detail;
		sections = res?.sections;
	} catch {
		/* 拿不到设置也能用默认档拾取 */
	}
	const startOpts: { detail?: DetailLevel; sections?: PickSection[] } = {};
	if (detail) startOpts.detail = detail;
	if (sections) startOpts.sections = sections;
	runtime.start(startOpts);
})();
