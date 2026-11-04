import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiEdit2, FiPlus, FiRotateCcw, FiSend, FiTrash2, FiX } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import { randomUuid } from "../uuid";
import { appUrl } from "../base-url";
import {
	COMMON_TEMPLATE_VARIABLES,
	normalizeTemplateCommand,
	resolveDynamicTemplateVariables,
	validTemplateCommand,
} from "../template-commands";
import { appSend, useAppField } from "../app-globals";
import { recordModelUsage } from "../model-usage";

/* ------------------------------------------------------------------ */
/* 提示词模板（prompt templates）                                        */
/*                                                                     */
/* 一套可复用的完整提示词，不只在「新对话空态」可用——通过 TemplateProvider    */
/* 把数据与弹窗提升到全局：空态显示推荐卡片，对话中途也能随时从输入框工具条    */
/* 打开同一个模板库。增删改在任意入口都可用：                               */
/*   - 模板库卡片 hover 直接出现 🗑（内置模板=移出模板库，自定义=删除）        */
/*   - 点卡片打开编辑弹窗：改内容→保存修改；内置可移出、自定义可删除；        */
/*   - 保存/删除后自动回到模板库列表，能看到变化。                           */
/* 持久化在服务端 <dataDir>/prompt-templates.json；旧浏览器数据自动迁移。 */
/* 灵感来自 https://www.aihero.dev/skills（Matt Pocock 的工程纪律技能）：  */
/* 需求澄清 → 拆解计划 → TDD → 排错 → 架构 → 代码审查。                    */
/* ------------------------------------------------------------------ */

interface Template {
	id: string;
	command?: string;
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
	command?: string;
	icon?: string;
	title?: string;
	desc?: string;
	prompt?: string;
	hidden?: boolean;
}

type I18nKey = Parameters<Translate>[0];

interface BuiltinDef {
	id: string;
	command?: string;
	icon: string;
	titleKey: I18nKey;
	descKey: I18nKey;
	promptKey: I18nKey;
}

/** 内置工程模板：收敛为研发主干与专项保障的 8 个核心黄金工作流。
 *  涵盖需求对齐、任务规划、TDD 实现、代码审查、根因排错、合并冲突、原型验证与一手调研。
 *  用户在本地新增或定制的模板 100% 完好保留，始终追加展示或优先覆盖。 */
const BUILTIN_DEFS: BuiltinDef[] = [
	/* 核心研发主干（The Core Loop） */
	{
		id: "clarify",
		command: "clarify",
		icon: "🎯",
		titleKey: "tpl.sk.clarify",
		descKey: "tpl.sk.clarify.desc",
		promptKey: "tpl.sk.clarify.prompt",
	},
	{
		id: "to-plan",
		command: "plan",
		icon: "📋",
		titleKey: "tpl.sk.toplan",
		descKey: "tpl.sk.toplan.desc",
		promptKey: "tpl.sk.toplan.prompt",
	},
	{
		id: "implement",
		command: "tdd",
		icon: "🧪",
		titleKey: "tpl.sk.implement",
		descKey: "tpl.sk.implement.desc",
		promptKey: "tpl.sk.implement.prompt",
	},
	{
		id: "code-review",
		command: "review",
		icon: "🧹",
		titleKey: "tpl.sk.codeview",
		descKey: "tpl.sk.codeview.desc",
		promptKey: "tpl.sk.codeview.prompt",
	},
	/* 专项高频保障（Specialized Operations） */
	{
		id: "diagnosing-bugs",
		command: "debug",
		icon: "🐛",
		titleKey: "tpl.sk.debug",
		descKey: "tpl.sk.debug.desc",
		promptKey: "tpl.sk.debug.prompt",
	},
	{
		id: "resolving-merge-conflicts",
		command: "merge",
		icon: "🔀",
		titleKey: "tpl.sk.merge",
		descKey: "tpl.sk.merge.desc",
		promptKey: "tpl.sk.merge.prompt",
	},
	{
		id: "prototype",
		command: "spike",
		icon: "🔬",
		titleKey: "tpl.sk.prototype",
		descKey: "tpl.sk.prototype.desc",
		promptKey: "tpl.sk.prototype.prompt",
	},
	{
		id: "research",
		command: "research",
		icon: "📚",
		titleKey: "tpl.sk.research",
		descKey: "tpl.sk.research.desc",
		promptKey: "tpl.sk.research.prompt",
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
	children,
	currentModelId,
}: {
	/** 发送消息（来自 useChat；socket 未就绪时返回 false）。 */
	children: ReactNode;
	/** 当前模型的 "provider/id" 复合键（模板编辑弹窗直接发送时记一次使用次数）。 */
	currentModelId: string | null;
}) {
	const t = useT();
	const connectionStatus = useAppField("status");
	/** 服务端持久化的自定义 / 内置覆盖 / 内置移出标记。 */
	const [stored, setStored] = useState<StoredTemplate[]>([]);
	const [storageError, setStorageError] = useState("");
	const pendingWrite = useRef(false);
	const storageGeneration = useRef(0);
	const mutateStored = useCallback(async (body: object): Promise<boolean> => {
		if (pendingWrite.current) return false;
		pendingWrite.current = true;
		storageGeneration.current++;
		try {
			const response = await fetch(appUrl("/api/prompt-templates"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || response.statusText);
			if (!Array.isArray(data.templates)) throw new Error("Invalid prompt templates response");
			setStored(data.templates);
			setStorageError("");
			return true;
		} catch (error) {
			setStorageError(String(error));
			return false;
		} finally {
			pendingWrite.current = false;
		}
	}, []);
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

	// Server file is authoritative; legacy browser data is removed only after import succeeds.
	useEffect(() => {
		if (connectionStatus !== "open") return;
		let disposed = false;
		const refresh = async () => {
			if (pendingWrite.current) return;
			const generation = ++storageGeneration.current;
			try {
				const response = await fetch(appUrl("/api/prompt-templates"));
				const data = await response.json();
				if (!response.ok) throw new Error(data.error || response.statusText);
				if (!Array.isArray(data.templates)) throw new Error("Invalid prompt templates response");
				if (!disposed && !pendingWrite.current && generation === storageGeneration.current) {
					setStored(data.templates);
					setStorageError("");
				}
			} catch (error) {
				if (!disposed && !pendingWrite.current && generation === storageGeneration.current) {
					setStorageError(String(error));
				}
			}
		};
		void (async () => {
			const legacy = loadStored();
			if (legacy.length && (await mutateStored({ action: "migrate", templates: legacy }))) {
				try {
					localStorage.removeItem(STORAGE_KEY);
				} catch {
					/* import already committed */
				}
			}
			await refresh();
		})();
		window.addEventListener("focus", refresh);
		window.addEventListener("online", refresh);
		return () => {
			disposed = true;
			window.removeEventListener("focus", refresh);
			window.removeEventListener("online", refresh);
		};
	}, [mutateStored, connectionStatus]);

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
				command: typeof o?.command === "string" ? o.command : (d.command ?? ""),
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
				command: typeof s.command === "string" ? s.command : "",
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
			void mutateStored({ action: "reset" });
			setResetConfirm(false);
		} else {
			setResetConfirm(true);
		}
	}, [resetConfirm, mutateStored]);
	// 审查 #5：5s 复位走 effect（可在卸载/再次点击时清理，不再裸 setTimeout 悬挂）。
	useEffect(() => {
		if (!resetConfirm) return;
		const id = setTimeout(() => setResetConfirm(false), 5000);
		return () => clearTimeout(id);
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
		async (cleaned: Template) => {
			if (!(await mutateStored({ action: "upsert", template: cleaned }))) return;
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
		async (tpl: Template) => {
			if (
				!(await mutateStored(
					tpl.builtin ? { action: "upsert", template: { id: tpl.id, hidden: true } } : { action: "remove", id: tpl.id },
				))
			)
				return;
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
		async (tpl: Template) => {
			if (!(await mutateStored({ action: "remove", id: tpl.id }))) return;
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
			{storageError && (
				<div className="template-error" role="alert">
					{t("tpl.storageError")}: {storageError}
				</div>
			)}

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
					storageError={storageError}
					templates={templates}
					onDraft={setEditing}
					onSave={saveEdit}
					onRestore={() => restoreOverride(editing)}
					onRemove={() => removeTemplate(editing)}
					onFill={() => {
						window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: editing.prompt }));
						closeAll();
					}}
					onSend={() => {
						const raw = editing.prompt.trim();
						const text = resolveDynamicTemplateVariables(raw);
						// 模板直发同样算一次当前模型的使用（下拉按次数排序）。
						if (text && appSend({ type: "prompt", text, queue: false })) {
							if (currentModelId) recordModelUsage(currentModelId);
							closeAll();
						}
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
				{/* 顶栏（标题 + 关闭）固定，不随卡片列表滚动 */}
				<div className="template-picker-top">
					<div className="template-picker-head">
						<span className="template-picker-title">{t("tpl.pickerTitle")}</span>
						<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
					<div className="template-picker-hint">{t("tpl.pickerHint")}</div>
				</div>
				{/* 只有卡片列表滚动 */}
				<div className="template-picker-scroll">
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

const COMMON_TEMPLATE_ICONS = [
	"📌",
	"🚀",
	"⚡",
	"📝",
	"🔍",
	"🛠️",
	"🎯",
	"💡",
	"🤖",
	"🌐",
	"📦",
	"🎨",
	"🐛",
	"🧪",
	"✨",
];

function EditModal({
	storageError,
	templates,
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
	storageError: string;
	templates: Template[];
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
	const iconPickerRef = useRef<HTMLDivElement>(null);
	const [showIconPicker, setShowIconPicker] = useState(false);

	const save = useCallback(() => {
		const title = editing.title.trim();
		const prompt = editing.prompt.trim();
		if (!title || !prompt) {
			onDraft({ ...editing, error: t("tpl.required") });
			return;
		}
		const command = normalizeTemplateCommand(editing.command ?? "");
		if (command && !validTemplateCommand(command)) {
			onDraft({ ...editing, error: t("tpl.commandInvalid") });
			return;
		}
		if (
			command &&
			templates.some((tpl) => tpl.id !== editing.id && normalizeTemplateCommand(tpl.command ?? "") === command)
		) {
			onDraft({ ...editing, error: t("tpl.commandDuplicate") });
			return;
		}
		onSave({
			id: editing.id,
			command,
			icon: editing.icon.trim() || "📌",
			title,
			desc: editing.desc.trim(),
			prompt,
		});
	}, [editing, onDraft, onSave, t, templates]);

	// Esc 关闭，Ctrl/Cmd+Enter 保存。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (showIconPicker) {
					setShowIconPicker(false);
					e.stopPropagation();
					return;
				}
				onClose();
			} else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				save();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, showIconPicker, save]);

	// 点击外部关闭 Emoji 选择下拉
	useEffect(() => {
		if (!showIconPicker) return;
		const onClickOutside = (e: MouseEvent) => {
			if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
				setShowIconPicker(false);
			}
		};
		window.addEventListener("mousedown", onClickOutside);
		return () => window.removeEventListener("mousedown", onClickOutside);
	}, [showIconPicker]);

	// modal 里提示词 textarea 的自适应高度（复用输入框同款逻辑）。
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		const maxHeight = 340;
		const capped = ta.scrollHeight > maxHeight;
		ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
		ta.style.overflowY = capped ? "auto" : "hidden";
	}, [editing.prompt]);

	const insertVariable = (varKey: string) => {
		const ta = taRef.current;
		if (!ta) {
			onDraft({ ...editing, prompt: editing.prompt + varKey });
			return;
		}
		const start = ta.selectionStart ?? editing.prompt.length;
		const end = ta.selectionEnd ?? editing.prompt.length;
		const text = editing.prompt;
		const nextPrompt = text.slice(0, start) + varKey + text.slice(end);
		onDraft({ ...editing, prompt: nextPrompt });
		requestAnimationFrame(() => {
			ta.focus();
			const nextCursor = start + varKey.length;
			ta.setSelectionRange(nextCursor, nextCursor);
		});
	};

	const isBuiltin = !!editing.builtin && !isNew;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal template-modal" onClick={(e) => e.stopPropagation()}>
				{/* 顶栏：图标选择 + 标题输入 + 状态 Badge + 关闭 */}
				<div className="template-modal-head">
					<div className="template-head-left" ref={iconPickerRef}>
						<button
							type="button"
							className="btn template-icon-btn"
							title={t("tpl.fieldIcon")}
							onClick={() => setShowIconPicker((prev) => !prev)}
						>
							<span className="template-modal-icon">{editing.icon || "📌"}</span>
						</button>

						{showIconPicker && (
							<div className="template-icon-dropdown">
								<div className="template-icon-grid">
									{COMMON_TEMPLATE_ICONS.map((emoji) => (
										<button
											key={emoji}
											type="button"
											className={`template-icon-opt ${editing.icon === emoji ? "active" : ""}`}
											onClick={() => {
												onDraft({ ...editing, icon: emoji });
												setShowIconPicker(false);
											}}
										>
											{emoji}
										</button>
									))}
								</div>
								<div className="template-icon-custom">
									<input
										className="template-icon-custom-input"
										value={editing.icon}
										maxLength={4}
										placeholder="Emoji"
										onChange={(e) => onDraft({ ...editing, icon: e.target.value })}
									/>
								</div>
							</div>
						)}

						<input
							className="template-head-title-input"
							value={editing.title}
							placeholder={t("tpl.fieldTitlePh")}
							onChange={(e) => onDraft({ ...editing, title: e.target.value })}
						/>
						<span className="template-modal-badge">{isBuiltin ? t("tpl.builtin") : t("tpl.custom")}</span>
					</div>

					<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				{/* 字段区可滚动，头（标题）/ 尾（操作）固定 */}
				<div className="template-modal-body">
					{/* 2 列紧凑网格：快捷命令 + 说明 */}
					<div className="template-grid-2col">
						<label className="template-field">
							<div className="template-field-label-row">
								<span className="template-field-label">{t("tpl.fieldCommand")}</span>
							</div>
							<div className="template-cmd-input-wrap">
								<span className="template-cmd-prefix">/</span>
								<input
									className="template-field-input template-cmd-input"
									value={editing.command ? editing.command.replace(/^\//, "") : ""}
									placeholder="pr"
									onChange={(e) =>
										onDraft({ ...editing, command: e.target.value.replace(/^\//, ""), error: undefined })
									}
								/>
							</div>
						</label>

						<label className="template-field">
							<div className="template-field-label-row">
								<span className="template-field-label">{t("tpl.fieldDesc")}</span>
							</div>
							<input
								className="template-field-input"
								value={editing.desc}
								placeholder={t("tpl.fieldDescPh")}
								onChange={(e) => onDraft({ ...editing, desc: e.target.value })}
							/>
						</label>
					</div>

					{/* 提示词编辑区：工具条与常用变量快捷插入 */}
					<div className="template-field template-prompt-field">
						<div className="template-field-label-row">
							<span className="template-field-label">{t("tpl.fieldPrompt")}</span>
							<span className="template-field-subhint">{editing.prompt.length} 字符</span>
						</div>

						<div className="template-prompt-container">
							<div className="template-prompt-toolbar">
								<span className="template-vars-label">插入变量:</span>
								<div className="template-vars-chips">
									{COMMON_TEMPLATE_VARIABLES.map((v) => (
										<button
											key={v.key}
											type="button"
											className="template-var-chip"
											title={v.desc}
											onClick={() => insertVariable(v.key)}
										>
											+ {v.label}
										</button>
									))}
								</div>
							</div>

							<textarea
								ref={taRef}
								className="template-field-prompt"
								value={editing.prompt}
								placeholder={t("tpl.fieldPromptPh")}
								onChange={(e) => onDraft({ ...editing, prompt: e.target.value })}
							/>
						</div>
						<span className="template-picker-hint">{t("tpl.commandHint")}</span>
					</div>
				</div>

				{(editing.error || storageError) && (
					<div className="template-error" role="alert">
						{editing.error || `${t("tpl.storageError")}: ${storageError}`}
					</div>
				)}

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
