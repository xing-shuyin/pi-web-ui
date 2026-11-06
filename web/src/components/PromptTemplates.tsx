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

interface Template {
	id: string;
	command?: string;
	icon: string;
	title: string;
	desc: string;
	prompt: string;
	builtin?: boolean;
	error?: string;
}

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

const BUILTIN_DEFS: BuiltinDef[] = [
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

function isFullTemplate(s: StoredTemplate): s is StoredTemplate & { title: string } {
	return typeof s.title === "string";
}

interface TemplateApi {
	templates: Template[];
	fill: (text: string) => void;
	openPicker: () => void;
	openEdit: (tpl?: Template) => void;
	resetConfirm: boolean;
	toggleReset: () => void;
}

const TemplateCtx = createContext<TemplateApi | null>(null);

export function useTemplates(): TemplateApi {
	const v = useContext(TemplateCtx);
	if (!v) throw new Error("useTemplates must be used within TemplateProvider");
	return v;
}

export function TemplateProvider({ children, currentModelId }: { children: ReactNode; currentModelId: string | null }) {
	const t = useT();
	const connectionStatus = useAppField("status");
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
	const [pickerOpen, setPickerOpen] = useState(false);
	const [editing, setEditing] = useState<Template | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [resetConfirm, setResetConfirm] = useState(false);
	const [fromPicker, setFromPicker] = useState(false);

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
				} catch {}
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

	const templates = useMemo(() => {
		const overrides = new Map<string, StoredTemplate>();
		const hiddenIds = new Set<string>();
		for (const s of stored) {
			if (s.hidden) hiddenIds.add(s.id);
			else if (isFullTemplate(s) && !isBuiltinId(s.id)) overrides.set(s.id, s);
			else if (isFullTemplate(s)) overrides.set(s.id, s);
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
	useEffect(() => {
		if (!resetConfirm) return;
		const id = setTimeout(() => setResetConfirm(false), 5000);
		return () => clearTimeout(id);
	}, [resetConfirm]);

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
				<div className="template-picker-top">
					<div className="template-picker-head">
						<span className="template-picker-title">{t("tpl.pickerTitle")}</span>
						<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
					<div className="template-picker-hint">{t("tpl.pickerHint")}</div>
				</div>
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

				<div className="template-modal-body">
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
