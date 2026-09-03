import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiEdit2, FiPlus, FiRotateCcw, FiSend, FiTrash2, FiX } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import type { ClientMessage } from "../types";
import { randomUuid } from "../uuid";

/* ------------------------------------------------------------------ */
/* 提示词模板（prompt templates）                                        */
/*                                                                     */
/* 一套可复用的完整提示词，不只在「新对话空态」可用——通过 TemplateProvider    */
/* 把数据与弹窗提升到全局：空态显示推荐卡片，对话中途也能随时从输入框工具条    */
/* 打开同一个模板库。增删改在任意入口都可用：                               */
/*   - 模板库卡片 hover 直接出现 🗑（内置模板=移出模板库，自定义=删除）        */
/*   - 点卡片打开编辑弹窗：改内容→保存修改；内置可移出、自定义可删除；        */
/*   - 保存/删除后自动回到模板库列表，能看到变化。                           */
/* 持久化在 localStorage（pi-web-ui:prompt-templates）。                  */
/* 灵感来自 https://www.aihero.dev/skills（Matt Pocock 的工程纪律技能）：  */
/* 需求澄清 → 拆解计划 → TDD → 排错 → 架构 → 代码审查。                    */
/* ------------------------------------------------------------------ */

interface Template {
	id: string;
	icon: string;
	/** 卡片上显示的短标题。 */
	title: string;
	/** 卡片上的一句话说明。 */
	desc: string;
	/** 完整的复杂提示词（与按钮文字不同，比标题长得多）。 */
	prompt: string;
	/** 内置模板（本地化默认值，可被 localStorage 覆盖 / 移出）。 */
	builtin?: boolean;
	/** 表单校验错误（仅在 modal 内短暂存在）。 */
	error?: string;
}

/** localStorage 里的一条：要么是完整模板（自定义 / 内置覆盖），要么是内置的
 *  移出标记 { id, hidden: true }。 */
interface StoredTemplate {
	id: string;
	icon?: string;
	title?: string;
	desc?: string;
	prompt?: string;
	hidden?: boolean;
}

type I18nKey = Parameters<Translate>[0];

interface BuiltinDef {
	id: string;
	icon: string;
	titleKey: I18nKey;
	descKey: I18nKey;
	promptKey: I18nKey;
}

/** 内置模板：覆盖 https://www.aihero.dev/skills 的全部 25 个 skill ——
 *  做真实工程而非「氛围编程」的常用工作流。每个模板是一段可复用的复杂
 *  提示词，模拟对应 skill 的流程（点卡片填入输入框，✏️ 可编辑/删除）。 */
const BUILTIN_DEFS: BuiltinDef[] = [
	/* Getting Started */
	{
		id: "setup-matt-pocock-skills",
		icon: "🛠",
		titleKey: "tpl.sk.setup",
		descKey: "tpl.sk.setup.desc",
		promptKey: "tpl.sk.setup.prompt",
	},
	{
		id: "ask-matt",
		icon: "🧭",
		titleKey: "tpl.sk.ask",
		descKey: "tpl.sk.ask.desc",
		promptKey: "tpl.sk.ask.prompt",
	},
	/* The Main Flow */
	{
		id: "grill-with-docs",
		icon: "🗣",
		titleKey: "tpl.sk.grilldocs",
		descKey: "tpl.sk.grilldocs.desc",
		promptKey: "tpl.sk.grilldocs.prompt",
	},
	{
		id: "to-spec",
		icon: "📝",
		titleKey: "tpl.sk.tospec",
		descKey: "tpl.sk.tospec.desc",
		promptKey: "tpl.sk.tospec.prompt",
	},
	{
		id: "to-tickets",
		icon: "🎫",
		titleKey: "tpl.sk.totickets",
		descKey: "tpl.sk.totickets.desc",
		promptKey: "tpl.sk.totickets.prompt",
	},
	{
		id: "implement",
		icon: "🏗",
		titleKey: "tpl.sk.implement",
		descKey: "tpl.sk.implement.desc",
		promptKey: "tpl.sk.implement.prompt",
	},
	{
		id: "code-review",
		icon: "🧹",
		titleKey: "tpl.sk.codeview",
		descKey: "tpl.sk.codeview.desc",
		promptKey: "tpl.sk.codeview.prompt",
	},
	/* Shaping */
	{
		id: "wayfinder",
		icon: "🗺",
		titleKey: "tpl.sk.wayfinder",
		descKey: "tpl.sk.wayfinder.desc",
		promptKey: "tpl.sk.wayfinder.prompt",
	},
	{
		id: "prototype",
		icon: "🔬",
		titleKey: "tpl.sk.prototype",
		descKey: "tpl.sk.prototype.desc",
		promptKey: "tpl.sk.prototype.prompt",
	},
	{
		id: "research",
		icon: "📚",
		titleKey: "tpl.sk.research",
		descKey: "tpl.sk.research.desc",
		promptKey: "tpl.sk.research.prompt",
	},
	/* Upkeep */
	{
		id: "improve-codebase-architecture",
		icon: "🏛",
		titleKey: "tpl.sk.arch",
		descKey: "tpl.sk.arch.desc",
		promptKey: "tpl.sk.arch.prompt",
	},
	{
		id: "diagnosing-bugs",
		icon: "🐛",
		titleKey: "tpl.sk.debug",
		descKey: "tpl.sk.debug.desc",
		promptKey: "tpl.sk.debug.prompt",
	},
	{
		id: "resolving-merge-conflicts",
		icon: "🔀",
		titleKey: "tpl.sk.merge",
		descKey: "tpl.sk.merge.desc",
		promptKey: "tpl.sk.merge.prompt",
	},
	{
		id: "triage",
		icon: "🗂",
		titleKey: "tpl.sk.triage",
		descKey: "tpl.sk.triage.desc",
		promptKey: "tpl.sk.triage.prompt",
	},
	{
		id: "wizard",
		icon: "✨",
		titleKey: "tpl.sk.wizard",
		descKey: "tpl.sk.wizard.desc",
		promptKey: "tpl.sk.wizard.prompt",
	},
	/* Productivity */
	{
		id: "grill-me",
		icon: "🔍",
		titleKey: "tpl.sk.grillme",
		descKey: "tpl.sk.grillme.desc",
		promptKey: "tpl.sk.grillme.prompt",
	},
	{
		id: "handoff",
		icon: "🤝",
		titleKey: "tpl.sk.handoff",
		descKey: "tpl.sk.handoff.desc",
		promptKey: "tpl.sk.handoff.prompt",
	},
	{
		id: "to-questionnaire",
		icon: "📋",
		titleKey: "tpl.sk.questionnaire",
		descKey: "tpl.sk.questionnaire.desc",
		promptKey: "tpl.sk.questionnaire.prompt",
	},
	{
		id: "teach",
		icon: "🎓",
		titleKey: "tpl.sk.teach",
		descKey: "tpl.sk.teach.desc",
		promptKey: "tpl.sk.teach.prompt",
	},
	{
		id: "wait-what",
		icon: "💬",
		titleKey: "tpl.sk.ww",
		descKey: "tpl.sk.ww.desc",
		promptKey: "tpl.sk.ww.prompt",
	},
	{
		id: "writing-for-agents",
		icon: "📄",
		titleKey: "tpl.sk.wfa",
		descKey: "tpl.sk.wfa.desc",
		promptKey: "tpl.sk.wfa.prompt",
	},
	/* Reference */
	{
		id: "codebase-design",
		icon: "🧱",
		titleKey: "tpl.sk.codesign",
		descKey: "tpl.sk.codesign.desc",
		promptKey: "tpl.sk.codesign.prompt",
	},
	{
		id: "domain-modeling",
		icon: "🏷",
		titleKey: "tpl.sk.domain",
		descKey: "tpl.sk.domain.desc",
		promptKey: "tpl.sk.domain.prompt",
	},
	{
		id: "grilling",
		icon: "🔥",
		titleKey: "tpl.sk.grilling",
		descKey: "tpl.sk.grilling.desc",
		promptKey: "tpl.sk.grilling.prompt",
	},
	{
		id: "tdd",
		icon: "🧪",
		titleKey: "tpl.sk.tdd",
		descKey: "tpl.sk.tdd.desc",
		promptKey: "tpl.sk.tdd.prompt",
	},
];

const STORAGE_KEY = "pi-web-ui:prompt-templates";

function loadStored(): StoredTemplate[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(c): c is StoredTemplate => !!c && typeof c === "object" && typeof (c as StoredTemplate).id === "string",
		);
	} catch {
		return [];
	}
}

function isBuiltinId(id: string): boolean {
	return BUILTIN_DEFS.some((b) => b.id === id);
}

/** 该 stored 条目是否为「完整模板」（区别于内置移出标记）。 */
function isFullTemplate(s: StoredTemplate): s is StoredTemplate & { title: string } {
	return typeof s.title === "string";
}

/* ------------------------------------------------------------------ */
/* context                                                              */
/* ------------------------------------------------------------------ */

interface TemplateApi {
	/** 有效模板：内置（未移出，应用覆盖）+ 自定义，按序排列。 */
	templates: Template[];
	/** 把一段提示词填入输入框（dispatch pi-web:fill）。 */
	fill: (text: string) => void;
	/** 打开模板库弹窗（对话中输入框按钮入口）。 */
	openPicker: () => void;
	/** 打开某个模板的编辑弹窗；无参 = 新建。 */
	openEdit: (tpl?: Template) => void;
	/** 「恢复默认模板」两步确认状态。 */
	resetConfirm: boolean;
	/** 「恢复默认模板」：第一次点进入确认态，确认态下再点清空自定义/覆盖/移出。 */
	toggleReset: () => void;
}

const TemplateCtx = createContext<TemplateApi | null>(null);

/** 在 TemplateProvider 内读取模板库能力。 */
export function useTemplates(): TemplateApi {
	const v = useContext(TemplateCtx);
	if (!v) throw new Error("useTemplates must be used within TemplateProvider");
	return v;
}

/* ------------------------------------------------------------------ */
/* Provider：数据 + 选择器弹窗 + 编辑弹窗                                */
/* ------------------------------------------------------------------ */

export function TemplateProvider({
	send,
	children,
}: {
	/** 发送消息（来自 useChat；socket 未就绪时返回 false）。 */
	send: (msg: ClientMessage) => boolean;
	children: ReactNode;
}) {
	const t = useT();
	/** 持久化的自定义 / 内置覆盖 / 内置移出标记。 */
	const [stored, setStored] = useState<StoredTemplate[]>(loadStored);
	/** 模板库（选择器）弹窗是否打开。 */
	const [pickerOpen, setPickerOpen] = useState(false);
	/** 正在编辑的模板（modal 工作副本）；null = 关闭。 */
	const [editing, setEditing] = useState<Template | null>(null);
	/** 是否「新建」模式（区别于编辑已有模板）。 */
	const [isNew, setIsNew] = useState(false);
	/** 「恢复默认模板」两步确认。 */
	const [resetConfirm, setResetConfirm] = useState(false);
	/** 编辑弹窗是否由模板库发起（保存/删除后应回到列表）。 */
	const [fromPicker, setFromPicker] = useState(false);

	// 持久化：localStorage 里存的是自定义 + 内置覆盖 + 移出标记。
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		} catch {
			/* storage 不可用则忽略 */
		}
	}, [stored]);

	// 有效模板 = 内置（未移出，应用覆盖） + 自定义。
	const templates = useMemo(() => {
		const overrides = new Map<string, StoredTemplate>();
		const hiddenIds = new Set<string>();
		for (const s of stored) {
			if (s.hidden) hiddenIds.add(s.id);
			else if (isFullTemplate(s) && !isBuiltinId(s.id)) overrides.set(s.id, s);
			else if (isFullTemplate(s)) overrides.set(s.id, s); // 内置覆盖
		}
		const builtins: Template[] = BUILTIN_DEFS.filter((d) => !hiddenIds.has(d.id)).map((d) => {
			const o = overrides.get(d.id);
			return {
				id: d.id,
				icon: o?.icon ?? d.icon,
				title: o?.title ?? t(d.titleKey),
				desc: o?.desc ?? t(d.descKey),
				prompt: o?.prompt ?? t(d.promptKey),
				builtin: true,
			};
		});
		const extras = stored
			.filter((s) => isFullTemplate(s) && !isBuiltinId(s.id))
			.map((s) => ({
				id: s.id,
				icon: s.icon ?? "📌",
				title: s.title ?? "",
				desc: s.desc ?? "",
				prompt: s.prompt ?? "",
			}));
		return [...builtins, ...extras];
	}, [stored, t]);

	const openPicker = useCallback(() => setPickerOpen(true), []);
	const fill = useCallback((text: string) => {
		window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: text }));
	}, []);
	const openEdit = useCallback((tpl?: Template, from = false) => {
		setFromPicker(from);
		if (tpl) {
			setIsNew(false);
			setEditing({ ...tpl });
		} else {
			setIsNew(true);
			setEditing({
				id: randomUuid(),
				icon: "📌",
				title: "",
				desc: "",
				prompt: "",
			});
		}
	}, []);
	const closeAll = useCallback(() => {
		setPickerOpen(false);
		setEditing(null);
		setFromPicker(false);
	}, []);
	const toggleReset = useCallback(() => {
		if (resetConfirm) {
			setStored([]);
			setResetConfirm(false);
		} else {
			setResetConfirm(true);
			setTimeout(() => setResetConfirm(false), 5000);
		}
	}, [resetConfirm]);

	// 选择器里：点卡片 = 直接填入输入框；点 ✏️ = 进编辑弹窗；点「新建」= 新建。
	const pickFill = useCallback(
		(tpl: Template) => {
			setPickerOpen(false);
			fill(tpl.prompt);
		},
		[fill],
	);
	const pickEdit = useCallback(
		(tpl: Template) => {
			setPickerOpen(false);
			openEdit(tpl, true);
		},
		[openEdit],
	);
	const pickNew = useCallback(() => {
		setPickerOpen(false);
		openEdit(undefined, true);
	}, [openEdit]);

	// 保存：校验后的清理值写入 stored。
	const saveEdit = useCallback(
		(cleaned: Template) => {
			setStored((prev) => {
				const idx = prev.findIndex((c) => c.id === cleaned.id);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = cleaned;
					return next;
				}
				return [...prev, cleaned];
			});
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	// 删除：自定义 = 移除；内置 = 移出模板库（打 hidden 标记，可在「恢复默认」找回）。
	const removeTemplate = useCallback(
		(tpl: Template) => {
			setStored((prev) => {
				if (tpl.builtin) {
					const rest = prev.filter((c) => c.id !== tpl.id);
					return [...rest, { id: tpl.id, hidden: true }];
				}
				return prev.filter((c) => c.id !== tpl.id);
			});
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	// 恢复默认：撤掉内置模板的覆盖（保留在列表，显示内置默认；不取消移出标记）。
	const restoreOverride = useCallback(
		(tpl: Template) => {
			setStored((prev) => prev.filter((c) => c.id !== tpl.id || c.hidden));
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	const api = useMemo<TemplateApi>(
		() => ({
			templates,
			fill,
			openPicker,
			openEdit,
			resetConfirm,
			toggleReset,
		}),
		[templates, fill, openPicker, openEdit, resetConfirm, toggleReset],
	);

	const hasOverride = editing ? stored.some((c) => c.id === editing.id && !c.hidden && isFullTemplate(c)) : false;

	return (
		<TemplateCtx.Provider value={api}>
			{children}

			{pickerOpen && (
				<PickerModal
					templates={templates}
					resetConfirm={resetConfirm}
					onFill={pickFill}
					onEditTpl={pickEdit}
					onNew={pickNew}
					onResetToggle={toggleReset}
					onClose={closeAll}
				/>
			)}

			{editing && (
				<EditModal
					editing={editing}
					isNew={isNew}
					hasOverride={hasOverride}
					onDraft={setEditing}
					onSave={saveEdit}
					onRestore={() => restoreOverride(editing)}
					onRemove={() => removeTemplate(editing)}
					onFill={() => {
						window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: editing.prompt }));
						closeAll();
					}}
					onSend={() => {
						const text = editing.prompt.trim();
						if (text && send({ type: "prompt", text, queue: false })) closeAll();
					}}
					onClose={closeAll}
				/>
			)}
		</TemplateCtx.Provider>
	);
}

/* ------------------------------------------------------------------ */
/* 空态推荐卡片（新对话 welcome 页）                                     */
/* ------------------------------------------------------------------ */

export function EmptyTemplateCards() {
	const t = useT();
	const { templates, fill, openEdit, toggleReset, resetConfirm } = useTemplates();

	return (
		<div className="empty-templates">
			<div className="empty-templates-head">
				<span className="empty-templates-title">{t("tpl.title")}</span>
				<span className="empty-templates-hint">{t("tpl.hint")}</span>
			</div>
			<div className="empty-templates-grid">
				{templates.map((tpl) => (
					<TemplateCard
						key={tpl.id}
						tpl={tpl}
						title={t("tpl.clickCard")}
						onFill={() => fill(tpl.prompt)}
						onEdit={() => openEdit(tpl)}
						editTitle={t("tpl.editTpl")}
					/>
				))}
				<button type="button" className="empty-template add" onClick={() => openEdit()} title={t("tpl.add")}>
					<span className="empty-template-icon">
						<FiPlus />
					</span>
					<span className="empty-template-main">
						<span className="empty-template-title">{t("tpl.add")}</span>
						<span className="empty-template-desc">{t("tpl.addDesc")}</span>
					</span>
				</button>
			</div>
			<div className="empty-templates-foot">
				<button type="button" className="empty-templates-reset" onClick={toggleReset}>
					<FiRotateCcw />
					{resetConfirm ? t("tpl.resetConfirm") : t("tpl.reset")}
				</button>
			</div>
		</div>
	);
}

/** 单张模板卡片（空态与选择器弹窗共用）：点卡片 = 填入输入框；✏️ = 编辑/删除。 */
function TemplateCard({
	tpl,
	title,
	onFill,
	onEdit,
	editTitle,
}: {
	tpl: Template;
	title?: string;
	onFill: () => void;
	onEdit: () => void;
	editTitle?: string;
}) {
	const t = useT();
	return (
		<button type="button" className="empty-template" title={title} onClick={onFill}>
			<span className="empty-template-icon">{tpl.icon}</span>
			<span className="empty-template-main">
				<span className="empty-template-title">{tpl.title}</span>
				<span className="empty-template-desc">{tpl.desc}</span>
			</span>
			<span
				className="template-card-ops"
				role="button"
				title={editTitle ?? t("tpl.editTpl")}
				onClick={(e) => {
					e.stopPropagation();
					onEdit();
				}}
			>
				<FiEdit2 />
			</span>
		</button>
	);
}

/* ------------------------------------------------------------------ */
/* 模板库（选择器）弹窗                                                  */
/* ------------------------------------------------------------------ */

function PickerModal({
	templates,
	resetConfirm,
	onFill,
	onEditTpl,
	onNew,
	onResetToggle,
	onClose,
}: {
	templates: Template[];
	resetConfirm: boolean;
	onFill: (tpl: Template) => void;
	onEditTpl: (tpl: Template) => void;
	onNew: () => void;
	onResetToggle: () => void;
	onClose: () => void;
}) {
	const t = useT();

	// Esc 关闭。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal template-picker" onClick={(e) => e.stopPropagation()}>
				<div className="template-picker-head">
					<span className="template-picker-title">{t("tpl.pickerTitle")}</span>
					<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
				<div className="template-picker-hint">{t("tpl.pickerHint")}</div>
				<div className="template-picker-grid">
					{templates.map((tpl) => (
						<TemplateCard
							key={tpl.id}
							tpl={tpl}
							title={t("tpl.clickCard")}
							onFill={() => onFill(tpl)}
							onEdit={() => onEditTpl(tpl)}
							editTitle={t("tpl.editTpl")}
						/>
					))}
					<button type="button" className="empty-template add" onClick={onNew} title={t("tpl.add")}>
						<span className="empty-template-icon">
							<FiPlus />
						</span>
						<span className="empty-template-main">
							<span className="empty-template-title">{t("tpl.add")}</span>
							<span className="empty-template-desc">{t("tpl.addDesc")}</span>
						</span>
					</button>
				</div>
				<div className="template-picker-foot">
					<button type="button" className="empty-templates-reset" onClick={onResetToggle}>
						<FiRotateCcw />
						{resetConfirm ? t("tpl.resetConfirm") : t("tpl.reset")}
					</button>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* 编辑弹窗                                                             */
/* ------------------------------------------------------------------ */

function EditModal({
	editing,
	isNew,
	hasOverride,
	onDraft,
	onSave,
	onRestore,
	onRemove,
	onFill,
	onSend,
	onClose,
}: {
	editing: Template;
	isNew: boolean;
	hasOverride: boolean;
	onDraft: (t: Template) => void;
	onSave: (cleaned: Template) => void;
	onRestore: () => void;
	onRemove: () => void;
	onFill: () => void;
	onSend: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const taRef = useRef<HTMLTextAreaElement>(null);

	// Esc 关闭。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// modal 里提示词 textarea 的自适应高度（复用输入框同款逻辑）。
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		const capped = ta.scrollHeight > 300;
		ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`;
		ta.style.overflowY = capped ? "auto" : "hidden";
	}, [editing.prompt]);

	const save = () => {
		const title = editing.title.trim();
		const prompt = editing.prompt.trim();
		if (!title || !prompt) {
			onDraft({ ...editing, error: t("tpl.required") });
			return;
		}
		onSave({
			id: editing.id,
			icon: editing.icon.trim() || "📌",
			title,
			desc: editing.desc.trim(),
			prompt,
		});
	};

	const isBuiltin = !!editing.builtin && !isNew;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal template-modal" onClick={(e) => e.stopPropagation()}>
				<div className="template-modal-head">
					<span className="template-modal-icon">{editing.icon}</span>
					<span className="template-modal-badge">{isBuiltin ? t("tpl.builtin") : t("tpl.custom")}</span>
					<span className="template-modal-title">{isNew ? t("tpl.newTitle") : t("tpl.editTitle")}</span>
					<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				<label className="template-field">
					<span className="template-field-label">{t("tpl.fieldIcon")}</span>
					<input
						className="template-field-input icon"
						value={editing.icon}
						maxLength={4}
						onChange={(e) => onDraft({ ...editing, icon: e.target.value })}
					/>
				</label>

				<label className="template-field">
					<span className="template-field-label">{t("tpl.fieldTitle")}</span>
					<input
						className="template-field-input"
						value={editing.title}
						placeholder={t("tpl.fieldTitlePh")}
						onChange={(e) => onDraft({ ...editing, title: e.target.value })}
					/>
				</label>

				<label className="template-field">
					<span className="template-field-label">{t("tpl.fieldDesc")}</span>
					<input
						className="template-field-input"
						value={editing.desc}
						placeholder={t("tpl.fieldDescPh")}
						onChange={(e) => onDraft({ ...editing, desc: e.target.value })}
					/>
				</label>

				<label className="template-field">
					<span className="template-field-label">{t("tpl.fieldPrompt")}</span>
					<textarea
						ref={taRef}
						className="template-field-prompt"
						value={editing.prompt}
						placeholder={t("tpl.fieldPromptPh")}
						onChange={(e) => onDraft({ ...editing, prompt: e.target.value })}
					/>
				</label>

				{editing.error && <div className="template-error">{editing.error}</div>}

				<div className="template-modal-actions">
					<div className="template-modal-actions-left">
						{!isNew && isBuiltin && hasOverride && (
							<button type="button" className="btn template-btn ghost" title={t("tpl.restoreTip")} onClick={onRestore}>
								{t("tpl.restore")}
							</button>
						)}
						{!isNew && isBuiltin && (
							<button
								type="button"
								className="btn template-btn ghost danger"
								title={t("tpl.removeTip")}
								onClick={onRemove}
							>
								<FiTrash2 /> {t("tpl.remove")}
							</button>
						)}
						{!isNew && !isBuiltin && (
							<button
								type="button"
								className="btn template-btn ghost danger"
								title={t("tpl.deleteTip")}
								onClick={onRemove}
							>
								<FiTrash2 /> {t("tpl.delete")}
							</button>
						)}
					</div>
					<div className="template-modal-actions-right">
						<button type="button" className="btn template-btn" onClick={save}>
							{t("tpl.save")}
						</button>
						<button type="button" className="btn template-btn fill" onClick={onFill} title={t("tpl.fillTip")}>
							{t("tpl.fill")}
						</button>
						<button type="button" className="btn template-btn send" onClick={onSend} title={t("tpl.sendTip")}>
							<FiSend /> {t("tpl.sendNow")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
