import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appResourceCrossOrigin } from "../base-url";
import { FiList, FiSquare, FiPaperclip, FiArrowUp, FiBookOpen, FiMic, FiCamera } from "react-icons/fi";
import type { FileSearchResult, ModelInfo, ProviderKeyInfo, SlashCommandInfo, UiMessage, UiState } from "../types";
import { isZhLocale, useT, useI18n } from "../i18n";
import { appSend, useAppField, useIsDsh, useEngineCapabilities } from "../app-globals";
import { mapCanvasHits, searchCanvasMentions } from "../canvas-mentions";
import {
	applyTemplateFill,
	mergeRecalledDraft,
	selectDraftToRestore,
	shouldPreserveDraftOnSwitch,
	shouldConfirmTemplateFill,
	type TemplateFillChoice,
} from "../composer-draft";
import {
	getLastSessionSwitchTime,
	registerDraftSink,
	registerFocusSink,
	registerInsertSink,
	registerRemoveMentionSink,
} from "../composer-bridge";
import { caretVisualLineFlags } from "../caret-visual-line";
import { isRasterImage } from "../image-paste";
import { collectClipboardFiles } from "../clipboard-files";
import { recordModelUsage } from "../model-usage";
import { loadPromptHistory, pushPromptHistory } from "../prompt-history";
import { filterSlashCommands } from "../slash-filter";
import {
	mapFileHits,
	mapPageHits,
	mapSkillHits,
	matchAtToken,
	mergeAtHits,
	normalizeAtHits,
	type AtHit,
} from "../at-mention";
import { getLastBrowserControlPages, pokeBrowserControl } from "../browser-control";
import { getPluginComposerProvider, listPluginComposerProviders } from "../plugin-host";
import { detectTouchFirstDevice } from "../touch-device";
import { resolveEnterAction, useEffectiveSendKey } from "../composer-keys";
import { resolveBackspaceMention } from "../chat-input-backspace";
import { copyTextToClipboard } from "../use-copy-feedback";
import { useImeCompositionGuard } from "../use-ime-composition-guard";
import { groupByAlign } from "../ui-slots";
import { nextSearchReqId } from "../search-req-id";

import { ModelThinking } from "./ModelThinking";
import { SystemScreenshotButton } from "./SystemScreenshotButton";
import { groupConversationHits, groupMessageTargets } from "../device-group-messages";
import {
	insertGroupMember,
	registerGroupMemberSink,
	updateGroupMemberReferences,
	serializeGroupMemberReferences,
	groupReferenceDestination,
	groupMemberDeletion,
	type GroupMemberReference,
} from "../group-member-reference";
import { DshPresetBar, type DshPresetInfo } from "./DshPresetBar";
import { DshPermissionBar } from "./DshPermissionBar";
import type { DshPermissionOption, UiAgentPreset } from "../types";
import { useTemplates } from "./PromptTemplates";
import { availableTemplateCommands, expandTemplateCommand, normalizeTemplateCommand } from "../template-commands";
import { TextQuoteCard } from "./TextQuoteCard";
import { openImageLightbox } from "../image-lightbox-bridge";
import { openFilePreview } from "../file-preview-bridge";
import { resolveWorkspaceFileUrl } from "../workspace-file-url";

const IS_TOUCH = detectTouchFirstDevice();

const COMPOSER_MIN_H = 40;
const COMPOSER_MAX_H = 320;
const COMPOSER_H_KEY = "pi-web-ui:composer-height";

function getComposerSafeMaxH(): number {
	if (typeof window === "undefined") return COMPOSER_MAX_H;
	return Math.max(160, Math.min(COMPOSER_MAX_H, Math.floor(window.innerHeight * 0.42)));
}

interface ChatInputProps {
	groupDevices?: readonly import("../device-group-messages").GroupDevice[];
	groupReady?: boolean;
	groupPrimaryBotName?: string;
	groupConversationError?: string;
	groupConversations?: readonly import("../device-group-messages").GroupBotConversation[];
	onGroupSend?: (
		text: string,
		targets: string[],
		conversationId?: string,
		options?: { planOnly?: boolean },
	) => Promise<boolean>;
	onAbort?: () => void;
	composerLeading?: import("../ui-slots").UiSlotEntry[];
	composerActions?: import("../ui-slots").UiSlotEntry[];
	onUiAction?: (item: import("../ui-slots").UiSlotEntry, value?: string) => void;
	streaming: boolean;
	messages: UiMessage[];
	slashCommands: SlashCommandInfo[];
	modelState: {
		model: UiState["model"];
		thinkingLevel: UiState["thinkingLevel"];
		availableThinkingLevels: UiState["availableThinkingLevels"];
	} | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	attachments: {
		path: string;
		name: string;
		mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote" | "canvas";
		quote?: import("../types").TextQuote;
		conversationId?: string;
		sessionPath?: string;
		isDir?: boolean;
		lines?: { start: number; end: number };
		imageData?: string;
		mimeType?: string;
		fileData?: string;
		size?: number;
		key?: string;
	}[];
	onRemoveAttachment: (path: string) => void;
	onAnnotateImage?: (attachment: ChatInputProps["attachments"][number], dataUrl: string) => void | Promise<void>;
	onAddImageFiles: (files: File[]) => void;
	onAddLocalFiles: (files: File[]) => void;
	onAddPathAttachment?: (a: {
		path: string;
		name: string;
		mode?: "inline" | "reference" | "lines" | "page" | "canvas";
		isDir?: boolean;
		lines?: { start: number; end: number };
		silent?: boolean;
	}) => void;
	fileSearch?: { reqId: number; ok: boolean; results: FileSearchResult[] } | null;
	onSearchFiles?: (reqId: number, query: string) => void;
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	onSent: () => void;
	onManageModels: () => void;
	recallDrafts?: { text: string; seq: number }[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	defaultModel?: string | null;
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	dshPermCurrent?: string | null;
	dshPermOptions?: DshPermissionOption[];
	dshPermDefault?: string;
	dshPreset?: DshPresetInfo | null;
	dshPresets?: UiAgentPreset[];
	dshPresetDefault?: string;
	dshBlank?: boolean;
	conversationId?: string;
	planMode?: boolean;
	sessionDraft?: { text: string; ts: number } | null;
	sessionId?: string;
	preserveDraftAcrossConversations?: boolean;
}

export const ChatInput = memo(function ChatInput({
	groupDevices,
	groupReady,
	groupPrimaryBotName,
	groupConversationError,
	groupConversations = [],
	onGroupSend,
	onAbort,
	streaming,
	planMode,
	messages,
	slashCommands,
	modelState,
	models,
	modelsLoading,
	attachments,
	onRemoveAttachment,
	onAnnotateImage,
	onAddImageFiles,
	onAddLocalFiles,
	onAddPathAttachment,
	fileSearch,
	onSearchFiles,
	onNotice,
	onSent,
	onManageModels,
	providerKeys,
	defaultModel,
	quickPhrases,
	quickPhrasesEnabled,
	recallDrafts,
	composerLeading,
	composerActions,
	onUiAction,
	dshPermCurrent,
	dshPermOptions,
	dshPermDefault,
	dshPreset,
	dshPresets,
	dshPresetDefault,
	dshBlank,
	conversationId,
	sessionDraft,
	sessionId,
	preserveDraftAcrossConversations = false,
}: ChatInputProps) {
	const t = useT();
	const localReady = useAppField("ready");
	const ready = groupDevices ? Boolean(groupReady) : localReady;
	const isDsh = useIsDsh();
	const capabilities = useEngineCapabilities();
	const effectivePlanMode = Boolean(planMode && capabilities.planMode);
	const { locale } = useI18n();
	const effectiveSendKey = useEffectiveSendKey(IS_TOUCH);
	const isModEnter = effectiveSendKey === "mod-enter";
	const { openPicker, templates } = useTemplates();
	const commandTemplates = availableTemplateCommands(templates, slashCommands);
	const allSlashCommands: SlashCommandInfo[] = [
		...slashCommands,
		...commandTemplates.map((tpl) => ({
			name: normalizeTemplateCommand(tpl.command ?? ""),
			description: tpl.desc || tpl.title,
			source: "prompt" as const,
		})),
	];
	const slashDesc = (c: SlashCommandInfo) =>
		!isZhLocale(locale) && c.descriptionEn ? c.descriptionEn : (c.description ?? "");
	const slashHint = (c: SlashCommandInfo) =>
		!isZhLocale(locale) && c.argumentHintEn ? c.argumentHintEn : (c.argumentHint ?? "");
	const [text, setText] = useState("");
	const [composerH, setComposerH] = useState<number | null>(() => {
		try {
			const v = Number(localStorage.getItem(COMPOSER_H_KEY));
			if (Number.isFinite(v) && v > COMPOSER_MIN_H + 4) {
				return Math.min(v, COMPOSER_MAX_H);
			}
		} catch {}
		return null;
	});
	const dragResizeRef = useRef<{ startY: number; startH: number; next: number | null } | null>(null);
	type ComposerMenu =
		{ kind: "slash"; items: SlashCommandInfo[] } | { kind: "at"; start: number; end: number; items: AtHit[] };
	const [menu, setMenu] = useState<ComposerMenu | null>(null);
	const [menuIndex, setMenuIndex] = useState(0);
	const atReqRef = useRef(0);
	const fileWaiters = useRef(new Map<number, (v: unknown) => void>());
	const menuTextRef = useRef("");
	const [showHelp, setShowHelp] = useState(false);
	const [helpWidth, setHelpWidth] = useState<number | undefined>(undefined);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const historyIndexRef = useRef(-1);
	const draftRef = useRef("");
	const [groupPlanOnly, setGroupPlanOnly] = useState(false);

	const lastRecallSeqRef = useRef(0);
	useEffect(() => {
		if (!recallDrafts || recallDrafts.length === 0) return;
		const pending = recallDrafts.filter((d) => d.text && d.seq > lastRecallSeqRef.current);
		if (pending.length === 0) return;
		lastRecallSeqRef.current = pending[pending.length - 1].seq;
		setMenu(null);
		setText((prev) => {
			const next = pending.reduce((acc, d) => mergeRecalledDraft(acc, d.text), prev);
			menuTextRef.current = next;
			return next;
		});
		historyIndexRef.current = -1;
		draftRef.current = "";
		requestAnimationFrame(() => {
			const ta = taRef.current;
			if (!ta) return;
			ta.focus();
			ta.selectionStart = ta.selectionEnd = ta.value.length;
		});
	}, [recallDrafts]);

	useEffect(() => {
		if (groupDevices) return;
		registerDraftSink((incoming) => {
			setMenu(null);
			setText((prev) => {
				const next = mergeRecalledDraft(prev, incoming);
				menuTextRef.current = next;
				return next;
			});
			historyIndexRef.current = -1;
			draftRef.current = "";
			requestAnimationFrame(() => {
				const ta = taRef.current;
				if (!ta) return;
				ta.focus();
				ta.selectionStart = ta.selectionEnd = ta.value.length;
			});
		});
		return () => registerDraftSink(null);
	}, []);

	useEffect(() => {
		registerFocusSink(() => {
			if (!IS_TOUCH) {
				requestAnimationFrame(() => {
					taRef.current?.focus();
				});
			}
		});
		return () => registerFocusSink(null);
	}, []);

	const textRef = useRef("");
	textRef.current = text;
	useEffect(() => {
		if (groupDevices) return;
		registerInsertSink((textToInsert) => {
			{
				const core = textToInsert.trim();
				const specials = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
				const esc = core
					.split("")
					.map((ch) => (specials.has(ch) ? "\\" + ch : ch))
					.join("");
				const re = new RegExp("(^|[\\s(（\"'“‘[【])" + esc + "(?=[\\s,.;:!?，。！？)\\]】」]|$)");
				if (core && re.test(textRef.current)) return;
			}
			const ta = taRef.current;
			if (!ta) {
				setText((prev) => {
					const next = prev + (prev && !prev.endsWith(" ") ? " " : "") + textToInsert;
					menuTextRef.current = next;
					return next;
				});
				return;
			}
			const start = ta.selectionStart ?? textRef.current.length;
			const end = ta.selectionEnd ?? textRef.current.length;
			const current = textRef.current;
			const needsPrefixSpace = start > 0 && !/[\s([{]$/.test(current.slice(0, start));
			const prefix = needsPrefixSpace ? " " : "";
			const insert = prefix + textToInsert;
			const next = current.slice(0, start) + insert + current.slice(end);
			menuTextRef.current = next;
			setText(next);
			const newCursor = start + insert.length;
			requestAnimationFrame(() => {
				ta.focus();
				ta.selectionStart = ta.selectionEnd = newCursor;
			});
		});
		return () => registerInsertSink(null);
	}, []);

	useEffect(() => {
		if (groupDevices) return;
		registerRemoveMentionSink((mention) => {
			setText((prev) => {
				const special = new Set([
					".",
					"*",
					"+",
					"?",
					"^",
					"$",
					"{",
					"}",
					"(",
					")",
					"|",
					"[",
					"]",
					String.fromCharCode(92),
				]);
				const escaped = mention
					.split("")
					.map((ch) => (special.has(ch) ? String.fromCharCode(92) + ch : ch))
					.join("");
				const regex = new RegExp("(^|\\s)" + escaped + "(?:\\s|$)", "g");
				let next = prev.replace(regex, (m, p) => (p === " " ? " " : ""));
				next = next.replace(/ {2,}/g, " ").trim();
				menuTextRef.current = next;
				return next;
			});
		});
		return () => registerRemoveMentionSink(null);
	}, []);

	const DRAFT_TEXT_CAP = 20000;
	const DRAFT_SAVE_DEBOUNCE_MS = 2000;
	const draftSessionKey = sessionId ? `${conversationId ?? ""}${sessionId}` : null;
	const draftLocalKey = draftSessionKey && sessionId ? `pi-web-ui:composer-draft:${sessionId}` : null;
	const textMirrorRef = useRef("");
	const lastEditTsRef = useRef(0);
	const touchedRef = useRef(false);
	const appliedDraftTsRef = useRef(0);
	const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftScopeRef = useRef<string | null>(null);
	const pendingCarryOverRef = useRef<{ text: string; userEditedAfterSwitch: boolean } | null>(null);
	const preserveAcrossRef = useRef(preserveDraftAcrossConversations);
	preserveAcrossRef.current = preserveDraftAcrossConversations;
	const imeGuard = useImeCompositionGuard();

	const readLocalDraft = (key: string): { text: string; ts: number } | null => {
		try {
			const raw = localStorage.getItem(key);
			if (!raw) return null;
			const o = JSON.parse(raw) as { text?: unknown; ts?: unknown };
			if (typeof o.text !== "string" || !o.text || typeof o.ts !== "number") return null;
			return { text: o.text.slice(0, DRAFT_TEXT_CAP), ts: o.ts };
		} catch {
			return null;
		}
	};

	const persistComposerDraft = (sid: string, localKey: string, text: string, ts: number) => {
		const capped = text.slice(0, DRAFT_TEXT_CAP);
		try {
			if (capped.trim()) localStorage.setItem(localKey, JSON.stringify({ text: capped, ts }));
			else localStorage.removeItem(localKey);
		} catch {}
		if (!groupDevices) appSend({ type: "draft_update", sessionId: sid, text: capped, ts });
	};

	const flushComposerDraft = () => {
		if (draftTimerRef.current) {
			clearTimeout(draftTimerRef.current);
			draftTimerRef.current = null;
		}
		if (!touchedRef.current || !draftSessionKey || !draftLocalKey || !sessionId || !connected) return;
		persistComposerDraft(sessionId, draftLocalKey, textMirrorRef.current, lastEditTsRef.current);
	};

	const selectedGroupDevices = useRef(new Set<string>());
	const groupReferences = useRef<GroupMemberReference[]>([]);
	const groupReferenceText = useRef("");
	useEffect(() => {
		groupReferences.current = [];
		groupReferenceText.current = textRef.current;
		if (!groupDevices || !sessionId?.startsWith("device-group:")) return;
		return registerGroupMemberSink(sessionId.slice("device-group:".length), (member) => {
			const existing = groupReferences.current.find((ref) => ref.member.id === member.id);
			if (existing) {
				taRef.current?.focus();
				return;
			}
			const ta = taRef.current;
			const next = insertGroupMember(textRef.current, ta?.selectionStart ?? textRef.current.length, member);
			groupReferences.current = updateGroupMemberReferences(textRef.current, next.text, groupReferences.current);
			groupReferences.current.push({ start: next.cursor - member.name.length - 2, end: next.cursor - 1, member });
			groupReferenceText.current = next.text;
			textMirrorRef.current = next.text;
			textRef.current = next.text;
			menuTextRef.current = next.text;
			setText(next.text);
			requestAnimationFrame(() => {
				taRef.current?.focus();
				taRef.current?.setSelectionRange(next.cursor, next.cursor);
			});
		});
	}, [sessionId, Boolean(groupDevices)]);
	const noteComposerEdit = (value: string) => {
		if (groupDevices) {
			groupReferences.current = updateGroupMemberReferences(groupReferenceText.current, value, groupReferences.current);
			groupReferenceText.current = value;
			const present = new Set(groupMessageTargets(value, groupDevices));
			for (const id of selectedGroupDevices.current) if (!present.has(id)) selectedGroupDevices.current.delete(id);
		}
		textMirrorRef.current = value;
		touchedRef.current = true;
		lastEditTsRef.current = Date.now();
		if (draftLocalKey) {
			const capped = value.slice(0, DRAFT_TEXT_CAP);
			try {
				if (capped.trim())
					localStorage.setItem(draftLocalKey, JSON.stringify({ text: capped, ts: lastEditTsRef.current }));
				else localStorage.removeItem(draftLocalKey);
			} catch {}
		}
		if (draftSessionKey && sessionId && connected) {
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			const sid = sessionId;
			const localKey = draftLocalKey;
			const ts = lastEditTsRef.current;
			const scope = draftSessionKey;
			draftTimerRef.current = setTimeout(() => {
				draftTimerRef.current = null;
				if (scope !== draftScopeRef.current || !localKey) return;
				persistComposerDraft(sid, localKey, textMirrorRef.current, ts);
			}, DRAFT_SAVE_DEBOUNCE_MS);
		}
	};

	const handleTextChange = (value: string, cursor: number | null) => {
		historyIndexRef.current = -1;
		setText(value);
		refreshMenus(value, cursor);
		noteComposerEdit(value);
	};

	useEffect(() => {
		const scope = draftSessionKey;
		const sid = sessionId;
		const localKey = draftLocalKey;
		return () => {
			if (draftTimerRef.current) {
				clearTimeout(draftTimerRef.current);
				draftTimerRef.current = null;
			}
			const curText = textMirrorRef.current;
			if (touchedRef.current && curText.trim()) {
				if (scope && sid && localKey) {
					persistComposerDraft(sid, localKey, curText, lastEditTsRef.current);
				}
				const switchTime = getLastSessionSwitchTime();
				const userEditedAfterSwitch = Boolean(switchTime > 0 && lastEditTsRef.current > switchTime);
				pendingCarryOverRef.current = { text: curText, userEditedAfterSwitch };
			} else {
				pendingCarryOverRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftSessionKey]);

	useEffect(() => {
		draftScopeRef.current = draftSessionKey;
		const carryInfo = pendingCarryOverRef.current;
		pendingCarryOverRef.current = null;
		const carryText = carryInfo?.text ?? null;
		const userEditedAfterSwitch = carryInfo?.userEditedAfterSwitch ?? false;

		const existingLocal = draftLocalKey ? readLocalDraft(draftLocalKey) : null;
		const hasExistingDraft = Boolean(
			(sessionDraft && sessionDraft.text?.trim() && sessionDraft.ts > 0) ||
			(existingLocal && existingLocal.text?.trim()),
		);

		const shouldPreserve = shouldPreserveDraftOnSwitch(
			carryText,
			userEditedAfterSwitch,
			messages.length,
			hasExistingDraft,
			preserveAcrossRef.current,
		);

		if (shouldPreserve && carryText !== null && draftLocalKey && sessionId) {
			touchedRef.current = true;
			appliedDraftTsRef.current = Date.now();
			textMirrorRef.current = carryText;
			lastEditTsRef.current = appliedDraftTsRef.current;
			setText(carryText);
			if (!hasExistingDraft) {
				persistComposerDraft(sessionId, draftLocalKey, carryText, lastEditTsRef.current);
			}
		} else {
			touchedRef.current = false;
			appliedDraftTsRef.current = 0;
			textMirrorRef.current = "";
			lastEditTsRef.current = 0;
			setText("");
		}
		setMenu(null);
		historyIndexRef.current = -1;
	}, [draftSessionKey]);

	const prevSessionKeyRef = useRef<string | null>(null);
	useEffect(() => {
		const isNewChat = messages.length === 0;
		const sessionChanged = prevSessionKeyRef.current !== null && prevSessionKeyRef.current !== draftSessionKey;
		const isInitialNewChat = prevSessionKeyRef.current === null && isNewChat;
		prevSessionKeyRef.current = draftSessionKey;
		if (ready && !IS_TOUCH && (sessionChanged || isInitialNewChat)) {
			requestAnimationFrame(() => {
				taRef.current?.focus();
			});
		}
	}, [draftSessionKey, messages.length, ready]);

	useEffect(() => {
		if (!draftSessionKey || !draftLocalKey) return;
		if (touchedRef.current) return;
		if (textMirrorRef.current !== "") return;
		const cappedServer =
			sessionDraft && sessionDraft.text
				? { text: sessionDraft.text.slice(0, DRAFT_TEXT_CAP), ts: sessionDraft.ts }
				: null;
		const best = selectDraftToRestore(cappedServer, readLocalDraft(draftLocalKey), appliedDraftTsRef.current);
		if (!best) return;
		appliedDraftTsRef.current = best.ts;
		textMirrorRef.current = best.text;
		lastEditTsRef.current = best.ts;
		setText(best.text);
		refreshMenus(best.text, null);
	});

	const SOURCE_LABEL: Record<SlashCommandInfo["source"], string> = {
		builtin: t("slashBuiltin"),
		extension: t("slashExtension"),
		prompt: t("slashPrompt"),
		skill: t("slashSkill"),
		plugin: t("slashPlugin"),
	};

	const refreshMenus = (value: string, cursor: number | null) => {
		menuTextRef.current = value;
		const m = value.match(/^\/([^\s]*)$/);
		if (m && ready && !groupDevices) {
			const prefix = m[1].toLowerCase();
			const matches = filterSlashCommands(allSlashCommands, prefix);
			setMenu(matches.length > 0 ? { kind: "slash", items: matches } : null);
			setMenuIndex(0);
			return;
		}
		if (cursor === null || !ready) {
			setMenu(null);
			return;
		}
		const tok = matchAtToken(value, cursor);
		if (!tok) {
			setMenu(null);
			return;
		}
		if (groupDevices) {
			const items = groupConversationHits(groupDevices, groupConversations, tok.query, isZhLocale(locale));
			setMenu(items.length ? { kind: "at", start: tok.start, end: cursor, items } : null);
			setMenuIndex(0);
			return;
		}
		let ids: { id: string; label: string }[] = [];
		try {
			ids = listPluginComposerProviders();
		} catch {
			ids = [];
		}
		const req = ++atReqRef.current;
		const snapshot = value;
		const start = tok.start;
		const query = tok.query;
		const end = start + 1 + query.length;
		const jobs: { id: string; label: string; run: () => Promise<unknown> }[] = ids.map((p) => ({
			id: p.id,
			label: p.label,
			run: () => {
				let search: ((q: string) => Promise<unknown>) | undefined;
				try {
					search = getPluginComposerProvider(p.id)?.search as ((q: string) => Promise<unknown>) | undefined;
				} catch {
					search = undefined;
				}
				if (typeof search !== "function") return Promise.resolve([]);
				return search(query);
			},
		}));
		jobs.push({
			id: "host:canvases",
			label: t("canvasTab"),
			run: async () =>
				mapCanvasHits(await searchCanvasMentions(() => appSend({ type: "canvas_list" })), query, t("canvasTab")),
		});
		if (query && typeof onSearchFiles === "function") {
			jobs.push({ id: "host:files", label: t("openFiles"), run: () => searchBuiltinFiles(query) });
		}
		let immediatePages: AtHit[] = [];
		if (capabilities.pageRef) {
			pokeBrowserControl();
			immediatePages = mapPageHits(t("browserControl"), getLastBrowserControlPages(), query);
			jobs.push({
				id: "host:pages",
				label: t("browserControl"),
				run: () => Promise.resolve(immediatePages),
			});
		}
		if (jobs.length === 0) {
			setMenu(null);
			return;
		}
		const skillItems = mapSkillHits(t("slashSkill"), slashCommands, query, 15, slashDesc);
		const eagerItems = mergeAtHits({ pages: immediatePages, skills: skillItems }, query, 30);
		let eagerRendered = false;
		if (eagerItems.length > 0) {
			eagerRendered = true;
			setMenu({ kind: "at", start, end, items: eagerItems });
			setMenuIndex(0);
		}
		void Promise.allSettled(
			jobs.map((j) =>
				Promise.race([
					j.run(),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("at-mention timeout")), 2000)),
				]),
			),
		).then((results) => {
			if (atReqRef.current !== req || menuTextRef.current !== snapshot) return;
			const canvasItems: AtHit[] = [];
			const pageItems: AtHit[] = [];
			const fileItems: AtHit[] = [];
			const pluginItems: AtHit[] = [];
			results.forEach((r, i) => {
				if (r.status !== "fulfilled") return;
				if (jobs[i].id === "host:pages" && Array.isArray(r.value)) pageItems.push(...(r.value as AtHit[]));
				else if (jobs[i].id === "host:canvases" && Array.isArray(r.value)) canvasItems.push(...(r.value as AtHit[]));
				else if (jobs[i].id === "host:files") fileItems.push(...mapFileHits(jobs[i].label, r.value));
				else pluginItems.push(...normalizeAtHits(jobs[i].id, jobs[i].label, r.value));
			});
			const items = mergeAtHits(
				{ canvases: canvasItems, pages: pageItems, skills: skillItems, files: fileItems, plugins: pluginItems },
				query,
				30,
			);
			setMenu(items.length > 0 ? { kind: "at", start, end, items } : null);
			if (!eagerRendered && items.length > 0) {
				setMenuIndex(0);
			}
		});
	};

	const searchBuiltinFiles = (query: string): Promise<unknown> => {
		if (typeof onSearchFiles !== "function") return Promise.resolve([]);
		const reqId = nextSearchReqId();
		return new Promise((resolve) => {
			fileWaiters.current.set(reqId, resolve);
			try {
				onSearchFiles(reqId, query);
			} catch {
				fileWaiters.current.delete(reqId);
				resolve([]);
				return;
			}
			setTimeout(() => {
				if (fileWaiters.current.get(reqId) === resolve) {
					fileWaiters.current.delete(reqId);
					resolve([]);
				}
			}, 3000);
		});
	};

	useEffect(() => {
		if (!fileSearch || !fileSearch.ok) return;
		const resolve = fileWaiters.current.get(fileSearch.reqId);
		if (!resolve) return;
		fileWaiters.current.delete(fileSearch.reqId);
		resolve(fileSearch.results ?? []);
	}, [fileSearch]);

	const updateCompletions = (value: string) => refreshMenus(value, null);

	useEffect(() => {
		const el = menuRef.current?.querySelector(".slash-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [menuIndex, menu]);

	const acceptSlash = (cmd?: SlashCommandInfo) => {
		const list = menu?.kind === "slash" ? menu.items : [];
		const pick = cmd ?? list[menuIndex % Math.max(list.length, 1)];
		if (!pick) {
			setMenu(null);
			return;
		}
		const m = text.match(/^\/([^\s]*)([\s\S]*)$/);
		const rest = m ? m[2] : "";
		const next = `/${pick.name} ${rest}`;
		menuTextRef.current = next;
		setText(next);
		noteComposerEdit(next);
		setMenu(null);
		taRef.current?.focus();
	};

	const acceptAt = (hit?: AtHit, start?: number) => {
		const cur = menu?.kind === "at" ? menu : null;
		const list = cur?.items ?? [];
		const pick = hit ?? list[menuIndex % Math.max(list.length, 1)];
		const at = start ?? cur?.start;
		if (!pick || at === undefined) {
			setMenu(null);
			return;
		}
		const ta = taRef.current;
		const cursor = ta ? (ta.selectionStart ?? text.length) : text.length;
		const replaceEnd = cur?.end !== undefined && cur.end >= at ? cur.end : cursor;
		const atts = pick.attachments ?? [];
		const conversation =
			pick.providerId === "host:group-conversations"
				? groupConversations.find((item) => item.id === pick.hint)
				: undefined;
		const groupMember = groupDevices?.find((member) =>
			pick.providerId === "host:group-devices" ? member.id === pick.hint : member.id === conversation?.botId,
		);
		const rawText = pick.text ?? (groupMember ? `@${groupMember.name}` : pick.title);
		if (groupDevices && pick.providerId === "host:group-devices" && pick.hint)
			selectedGroupDevices.current.add(pick.hint);
		const insert = atts.length > 0 && !rawText.startsWith("@") ? `@${rawText} ` : `${rawText} `;
		const next = `${text.slice(0, at)}${insert}${text.slice(replaceEnd)}`;
		menuTextRef.current = next;
		setText(next);
		noteComposerEdit(next);
		if (groupMember)
			groupReferences.current.push({
				start: at,
				end: at + rawText.length,
				member: groupMember,
				conversationId: conversation?.id,
			});
		setMenu(null);
		for (const a of atts) {
			try {
				onAddPathAttachment?.({
					path: a.path,
					name: a.name ?? a.path.split("/").pop() ?? a.path,
					...(a.mode ? { mode: a.mode } : { mode: "reference" as const }),
					...(typeof a.isDir === "boolean" ? { isDir: a.isDir } : {}),
					...(a.lines ? { lines: a.lines } : {}),
					silent: true,
				});
			} catch {}
		}
		requestAnimationFrame(() => {
			const el = taRef.current;
			if (!el) return;
			el.focus();
			el.selectionStart = el.selectionEnd = at + insert.length;
		});
	};

	const renderSlashRows = () => {
		if (menu?.kind !== "slash") return null;
		return menu.items.map((c, i) => (
			<button
				type="button"
				key={c.name}
				className={`slash-item${i === menuIndex ? " active" : ""}`}
				onMouseEnter={() => setMenuIndex(i)}
				onClick={() => acceptMenu(c)}
			>
				<span className="slash-name">/{c.name}</span>
				<span className={`slash-source ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
				<span className="slash-desc">
					{slashDesc(c)}
					{c.argumentHint && <span className="slash-hint">{slashHint(c)}</span>}
				</span>
			</button>
		));
	};
	const renderAtRows = () => {
		if (menu?.kind !== "at") return null;
		return menu.items.map((h, i) => (
			<button
				type="button"
				key={`${h.providerId}:${h.title}:${i}`}
				className={`slash-item${i === menuIndex ? " active" : ""}`}
				onMouseEnter={() => setMenuIndex(i)}
				onClick={() => acceptMenu(h)}
				title={groupDevices ? h.title : (h.hint ?? h.title)}
			>
				<span className="slash-name">@{h.title}</span>
				<span className={`slash-source ${h.providerId === "host:skills" ? "skill" : "plugin"}`}>{h.providerLabel}</span>
				{h.hint && !groupDevices && <span className="slash-desc">{h.hint}</span>}
			</button>
		));
	};

	const acceptMenu = (item?: SlashCommandInfo | AtHit) => {
		if (!menu) return;
		if (menu.kind === "slash") acceptSlash(item as SlashCommandInfo | undefined);
		else acceptAt(item as AtHit | undefined, menu.start);
	};

	const copyLastAssistant = async () => {
		const msgs = messages;
		const last = [...msgs]
			.reverse()
			.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && (b as { text?: string }).text));
		const textToCopy = last?.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		if (!textToCopy) {
			onNotice("warning", t("slashCopyEmpty"));
			return;
		}
		const ok = await copyTextToClipboard(textToCopy);
		if (ok) {
			onNotice("info", t("slashCopied"));
		} else {
			onNotice("error", t("slashCopyFailed"));
		}
	};

	const handleFiles = (files: FileList | File[] | null) => {
		if (groupDevices) return;
		if (!files || files.length === 0) {
			onNotice("warning", t("foldersNotSupported"));
			return;
		}
		const images = Array.from(files).filter((f) => isRasterImage(f.type));
		const others = Array.from(files).filter((f) => !isRasterImage(f.type));
		const noVision = currentModelNoVision();
		if (images.length > 0 && noVision) {
			onNotice("warning", noVision);
		} else if (images.length > 0) {
			onAddImageFiles(images);
		}
		if (others.length > 0) onAddLocalFiles(others);
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const files = collectClipboardFiles(e.clipboardData?.items, e.clipboardData?.files);
		if (files.length === 0) return;
		e.preventDefault();
		handleFiles(files);
	};

	const currentModelNoVision = (): string | null => {
		const m = modelState?.model;
		if (!m?.id) return null;
		const info = models.find((x) => x.id === m.id);
		return info && info.vision === false ? t("modelNoVision", { name: info.name }) : null;
	};

	const connected = ready;
	const sessionReady = ready && Boolean(sessionId);

	const lastTextRef = useRef(text);
	useEffect(() => {
		lastTextRef.current = text;
	}, [text]);
	useEffect(() => {
		if (!groupDevices && /^\/[^\s]*$/.test(lastTextRef.current)) updateCompletions(lastTextRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slashCommands]);

	const [pendingFill, setPendingFill] = useState<string | null>(null);
	const resolvePendingFill = (choice: TemplateFillChoice) => {
		const incoming = pendingFill;
		setPendingFill(null);
		if (incoming === null) return;
		const next = applyTemplateFill(lastTextRef.current, incoming, choice);
		if (next !== null) {
			setMenu(null);
			menuTextRef.current = next;
			setText(next);
		}
		requestAnimationFrame(() => taRef.current?.focus());
	};
	useEffect(() => {
		if (groupDevices) return;
		const onFill = (e: Event) => {
			const detail = (e as CustomEvent<string>).detail;
			if (typeof detail !== "string") return;
			if (shouldConfirmTemplateFill(lastTextRef.current, detail)) {
				setPendingFill(detail);
				return;
			}
			setMenu(null);
			menuTextRef.current = detail;
			setText(detail);
			taRef.current?.focus();
		};
		window.addEventListener("pi-web:fill", onFill);
		return () => window.removeEventListener("pi-web:fill", onFill);
	}, []);

	useEffect(() => {
		if (!showHelp && pendingFill === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (pendingFill !== null) {
					setPendingFill(null);
					requestAnimationFrame(() => taRef.current?.focus());
				} else {
					setShowHelp(false);
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showHelp, pendingFill]);

	const composerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const ta = taRef.current;
		const box = composerRef.current;
		if (!ta || !box) return;
		const list = ta.closest("main")?.querySelector<HTMLElement>(".messages");
		const hBefore = box.getBoundingClientRect().height;
		const stBefore = list?.scrollTop ?? 0;

		const maxCap = getComposerSafeMaxH();
		ta.style.maxHeight = `${maxCap}px`;

		const isManualFixed = composerH != null && composerH > COMPOSER_MIN_H + 4;
		let h: number;

		ta.style.height = "auto";
		const naturalH = ta.scrollHeight;

		if (isManualFixed) {
			h = Math.min(composerH, maxCap);
		} else {
			h = Math.min(Math.max(naturalH, COMPOSER_MIN_H), maxCap);
		}

		ta.style.height = `${h}px`;
		ta.style.overflowY = naturalH > h ? "auto" : "hidden";

		if (list) {
			const grew = box.getBoundingClientRect().height - hBefore;
			list.scrollTop = stBefore + grew;
		}
	}, [text, composerH]);

	const attachRowRef = useRef<HTMLDivElement>(null);
	const quickRowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const attachEl = attachRowRef.current;
		const quickEl = quickRowRef.current;
		const root = document.documentElement;
		if (!attachEl && !quickEl) {
			root.style.removeProperty("--quick-row-h");
			return;
		}
		const apply = () => {
			const ah = attachEl ? attachEl.offsetHeight : 0;
			const qh = quickEl ? quickEl.offsetHeight : 0;
			const gap = attachEl && quickEl ? 6 : 0;
			root.style.setProperty("--quick-row-h", `${ah + gap + qh}px`);
		};
		apply();
		const ro = new ResizeObserver(apply);
		if (attachEl) ro.observe(attachEl);
		if (quickEl) ro.observe(quickEl);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--quick-row-h");
		};
	}, [attachments.length, quickPhrasesEnabled, quickPhrases.length]);

	const buildPromptAttachments = () =>
		attachments.map((a) => {
			if (a.mode === "quote") return { path: "", mode: "quote" as const, quote: a.quote };
			if (a.imageData) {
				return {
					path: "",
					imageData: a.imageData,
					mimeType: a.mimeType,
					name: a.name,
				};
			}
			if (a.fileData) {
				return {
					path: "",
					fileData: a.fileData,
					mimeType: a.mimeType,
					name: a.name,
					size: a.size,
				};
			}
			return {
				path: a.path,
				mode: a.mode,
				...(a.lines ? { lines: a.lines } : {}),
				...(a.mode === "page" || a.mode === "canvas" ? { name: a.name } : {}),
				...(a.mode === "conversation"
					? {
							name: a.name,
							...(a.conversationId ? { conversationId: a.conversationId } : {}),
							...(a.sessionPath ? { sessionPath: a.sessionPath } : {}),
						}
					: {}),
			};
		});

	const clearDraftAfterConsume = () => {
		if (draftLocalKey) {
			try {
				localStorage.removeItem(draftLocalKey);
			} catch {}
		}
		if (draftTimerRef.current) {
			clearTimeout(draftTimerRef.current);
			draftTimerRef.current = null;
		}
		touchedRef.current = false;
		appliedDraftTsRef.current = Date.now();
		textMirrorRef.current = "";
		lastEditTsRef.current = 0;
	};

	const groupSending = useRef(false);
	const submit = (queue = false) => {
		const trimmed = text.trim();
		const hasAttach = attachments.length > 0;
		if (!trimmed && !hasAttach) return;
		if (!connected) {
			onNotice("error", t("netDisconnected"));
			return;
		}
		if (!sessionReady) {
			onNotice("warning", t("sessionInitializingNotice"));
			return;
		}
		if (groupDevices) {
			if (!onGroupSend || groupSending.current) return;
			let destination: string | undefined;
			try {
				destination = groupReferenceDestination(groupReferences.current);
			} catch (error) {
				onNotice("error", (error as Error).message);
				return;
			}
			groupSending.current = true;
			const serialized = serializeGroupMemberReferences(text, groupReferences.current);
			void onGroupSend(
				serialized.text.trim(),
				[
					...new Set([
						...serialized.targets,
						...groupMessageTargets(trimmed, groupDevices).filter((id) => selectedGroupDevices.current.has(id)),
					]),
				],
				destination,
				{ planOnly: groupPlanOnly },
			)
				.then((ok) => {
					if (ok && textMirrorRef.current.trim() === trimmed) {
						setText("");
						selectedGroupDevices.current.clear();
						groupReferences.current = [];
						groupReferenceText.current = "";
						clearDraftAfterConsume();
						onSent();
					}
				})
				.catch((error: unknown) => onNotice("error", String(error)))
				.finally(() => {
					groupSending.current = false;
				});
			return;
		}
		if (!capabilities.conversationRef && attachments.some((a) => a.mode === "conversation")) {
			onNotice(
				"warning",
				isZhLocale(locale)
					? "当前底层智能体不支持跨对话引用（缺少 conversation_read 工具），请移除会话引用后再发送。"
					: "The current agent engine does not support conversation references (conversation_read tool unavailable). Remove conversation references before sending.",
			);
			return;
		}
		if (trimmed === "/help") {
			const box = taRef.current?.closest(".inputbox")?.getBoundingClientRect();
			setHelpWidth(box?.width);
			setShowHelp(true);
			setText("");
			clearDraftAfterConsume();
			taRef.current?.focus();
			return;
		}
		if (trimmed === "/copy") {
			setText("");
			clearDraftAfterConsume();
			taRef.current?.focus();
			void copyLastAssistant();
			return;
		}
		if (
			appSend({
				type: "prompt",
				text: expandTemplateCommand(trimmed, commandTemplates),
				queue,
				attachments: buildPromptAttachments(),
			})
		) {
			if (trimmed) pushPromptHistory(trimmed);
			historyIndexRef.current = -1;
			draftRef.current = "";
			setText("");
			clearDraftAfterConsume();
			onSent();
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			taRef.current?.focus();
		} else {
			onNotice("error", t("netDisconnected"));
		}
	};

	const sendPhrase = (phrase: string, queue = false) => {
		if (groupDevices) return;
		const trimmed = phrase.trim();
		if (!trimmed) return;
		if (!connected) {
			onNotice("error", t("netDisconnected"));
			return;
		}
		if (!sessionReady) {
			onNotice("warning", t("sessionInitializingNotice"));
			return;
		}
		if (appSend({ type: "prompt", text: trimmed, queue, attachments: buildPromptAttachments() })) {
			if (trimmed) pushPromptHistory(trimmed);
			historyIndexRef.current = -1;
			draftRef.current = "";
			flushComposerDraft();
			onSent();
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			if (!IS_TOUCH) taRef.current?.focus();
		} else {
			onNotice("error", t("netDisconnected"));
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (imeGuard.isImeKey(e.nativeEvent)) return;
		if (menu && menu.items.length > 0) {
			const len = menu.items.length;
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setMenuIndex((i) => (i + 1) % len);
					return;
				case "ArrowUp":
					e.preventDefault();
					setMenuIndex((i) => (i - 1 + len) % len);
					return;
				case "Tab":
				case "Enter":
					e.preventDefault();
					acceptMenu();
					return;
				case "Escape":
					e.preventDefault();
					setMenu(null);
					return;
			}
		}

		if (groupDevices && (e.key === "Backspace" || e.key === "Delete") && !e.nativeEvent.isComposing) {
			const ta = taRef.current;
			if (ta) {
				const range = groupMemberDeletion(text, ta.selectionStart, ta.selectionEnd, e.key, groupReferences.current);
				if (range) {
					e.preventDefault();
					const next = text.slice(0, range.start) + text.slice(range.end);
					noteComposerEdit(next);
					setText(next);
					textRef.current = next;
					requestAnimationFrame(() => ta.setSelectionRange(range.start, range.start));
					return;
				}
			}
		}
		if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const ta = taRef.current;
			if (ta && ta.selectionStart === ta.selectionEnd && ta.selectionStart > 0) {
				const pos = ta.selectionStart;
				const before = text.slice(0, pos);
				const res = resolveBackspaceMention(before, pos, attachments);
				if (res && res.tokenStart >= 0 && res.tokenStart < pos) {
					e.preventDefault();
					const tokenStart = res.tokenStart;
					const nextText = text.slice(0, tokenStart) + text.slice(pos);
					menuTextRef.current = nextText;
					setText(nextText);
					requestAnimationFrame(() => {
						if (taRef.current) {
							taRef.current.selectionStart = taRef.current.selectionEnd = tokenStart;
						}
					});
					const hit = res.attachment;
					if (hit) {
						onRemoveAttachment(
							hit.key ??
								(hit.mode === "conversation" ? `conv|${hit.conversationId ?? ""}|${hit.sessionPath ?? ""}` : hit.path),
						);
					}
					return;
				}
			}
		}
		// Global prompt history cycling (issue #68): Up = older, Down = newer.
		if (!groupDevices && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const ta = taRef.current;
			if (!ta) return;
			const isUp = e.key === "ArrowUp";
			const lineFlags = caretVisualLineFlags(ta);
			if (isUp && !lineFlags.first) return;
			if (!isUp && !lineFlags.last) return;
			if (!isUp && historyIndexRef.current === -1) return;
			const history = loadPromptHistory();
			if (history.length === 0) return;
			e.preventDefault();
			if (isUp) {
				if (historyIndexRef.current === -1) {
					draftRef.current = text;
					const idx = history.length - 1;
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				} else if (historyIndexRef.current > 0) {
					const idx = historyIndexRef.current - 1;
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				}
			} else {
				const idx = historyIndexRef.current + 1;
				if (idx < history.length) {
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				} else {
					historyIndexRef.current = -1;
					const draft = draftRef.current;
					setText(draft);
					updateCompletions(draft);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = draft.length;
					});
				}
			}
			return;
		}
		if (e.key === "Escape" && historyIndexRef.current !== -1) {
			e.preventDefault();
			const draft = draftRef.current;
			historyIndexRef.current = -1;
			setText(draft);
			updateCompletions(draft);
			requestAnimationFrame(() => {
				const el = taRef.current;
				if (el) el.selectionStart = el.selectionEnd = draft.length;
			});
			return;
		}
		const enterAction = resolveEnterAction({
			key: e.key,
			shiftKey: e.shiftKey,
			ctrlKey: e.ctrlKey,
			metaKey: e.metaKey,
			isTouch: IS_TOUCH,
			pref: effectiveSendKey,
		});
		if (enterAction === "send") {
			e.preventDefault();
			submit();
			return;
		}
		if (enterAction === "newline") {
			return;
		}
	};

	const canSubmit = sessionReady && (text.trim() !== "" || attachments.length > 0);

	const pluginActions = useMemo(
		() => groupByAlign((composerActions ?? []).filter((it) => it.source !== "host" && !it.hidden)),
		[composerActions],
	);
	const leadingActions = useMemo(
		() => (composerLeading ?? []).filter((it) => it.source !== "host" && !it.hidden),
		[composerLeading],
	);
	const composerWired = composerActions !== undefined;
	const composerGroups = useMemo(
		() => groupByAlign((composerActions ?? []).filter((it) => !it.hidden)),
		[composerActions],
	);
	const renderPluginAction = (it: import("../ui-slots").UiSlotEntry) => {
		if (it.kind === "select" && it.options?.length) {
			const cur = it.options.some((o) => o.value === it.value) ? (it.value as string) : it.options[0]!.value;
			return (
				<select
					key={it.id}
					className="composer-plugin-select"
					title={it.hint || it.label}
					aria-label={it.label}
					value={cur}
					onChange={(e) => onUiAction?.(it, e.target.value)}
				>
					{it.options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			);
		}
		const icon = it.icon === "mic" ? <FiMic /> : it.icon === "camera" ? <FiCamera /> : it.icon || it.label;
		return (
			<button
				key={it.id}
				type="button"
				className="btn composer-plugin-action"
				data-action={it.action}
				data-plugin-slot-id={it.id}
				title={it.hint || it.label}
				aria-label={it.label}
				onClick={() => onUiAction?.(it)}
			>
				{icon}
			</button>
		);
	};

	const canSteer = Boolean(capabilities.steer !== false && !isDsh);
	const renderActions = () => (
		<div className="inputbox-actions">
			{streaming ? (
				canSubmit ? (
					<div className={`split-send${!canSteer ? " single" : ""}`}>
						<button
							type="button"
							className="split-queue"
							title={t("supplementTip")}
							aria-label={t("queueFollowTag")}
							onClick={() => submit(true)}
						>
							<FiList />
						</button>
						{canSteer && (
							<button
								type="button"
								className="split-steer"
								title={isModEnter ? t("steerTipMod") : t("steerTip")}
								aria-label={t("queueSteerTag")}
								onClick={() => submit()}
							>
								<FiArrowUp />
							</button>
						)}
					</div>
				) : (
					<button
						type="button"
						className="btn stop"
						title={t("stopAgent")}
						onClick={() => (onAbort ? onAbort() : appSend({ type: "abort" }))}
					>
						<FiSquare />
					</button>
				)
			) : (
				<button
					type="button"
					className="btn send"
					title={
						!connected
							? t("netDisconnected")
							: !sessionReady
								? t("sessionInitializingNotice")
								: isModEnter
									? t("sendTipMod")
									: t("sendTip")
					}
					disabled={!canSubmit}
					onClick={() => submit()}
				>
					<FiArrowUp />
				</button>
			)}
		</div>
	);
	const composerHostNodes: Record<string, ReactNode> = {
		"host:composer-upload": (
			<button
				type="button"
				className="btn attach-img"
				title={t("uploadFile")}
				disabled={!connected}
				onClick={() => fileInputRef.current?.click()}
			>
				<FiPaperclip />
			</button>
		),
		"host:composer-screenshot": <SystemScreenshotButton onNotice={onNotice} />,
		"host:composer-templates": (
			<button type="button" className="btn tpl-open" title={t("tpl.openPicker")} onClick={openPicker}>
				<FiBookOpen />
			</button>
		),
		"host:composer-model": (
			<ModelThinking
				only="model"
				state={modelState}
				models={models}
				modelsLoading={modelsLoading}
				onManageModels={onManageModels}
				providerKeys={providerKeys}
				defaultModel={defaultModel}
				compact
			/>
		),
		"host:composer-thinking": (
			<ModelThinking
				only="thinking"
				state={modelState}
				models={models}
				modelsLoading={modelsLoading}
				onManageModels={onManageModels}
				providerKeys={providerKeys}
				compact
			/>
		),
		"host:composer-dsh-perm":
			dshPermOptions && dshPermOptions.length > 0 && dshPermDefault !== undefined ? (
				<DshPermissionBar
					compact
					current={dshPermCurrent ?? null}
					options={dshPermOptions}
					defaultPreset={dshPermDefault}
					conversationId={conversationId ?? ""}
				/>
			) : null,
		"host:composer-dsh-preset":
			dshPresets && dshPresets.length > 0 && dshPresetDefault !== undefined ? (
				<DshPresetBar
					compact
					preset={dshPreset ?? null}
					presets={dshPresets}
					defaultPreset={dshPresetDefault}
					blank={dshBlank ?? false}
					conversationId={conversationId ?? ""}
				/>
			) : null,
		"host:composer-send": renderActions(),
	};
	const renderComposerEntry = (it: import("../ui-slots").UiSlotEntry) => {
		if (it.source === "host") return <Fragment key={it.id}>{composerHostNodes[it.id] ?? null}</Fragment>;
		return renderPluginAction(it);
	};

	return (
		<div
			ref={composerRef}
			className="inputbar"
			onDragOver={(e) => {
				e.preventDefault();
			}}
			onDrop={(e) => {
				e.preventDefault();
				e.stopPropagation();
				handleFiles(e.dataTransfer?.files ?? null);
			}}
		>
			{attachments.length > 0 && (
				<div className="attach-row" ref={attachRowRef}>
					{attachments.map((a) => {
						if (a.mode === "quote" && a.quote) {
							return <TextQuoteCard key={a.key} quote={a.quote} onRemove={() => onRemoveAttachment(a.key ?? "")} />;
						}
						const isImage = Boolean(a.imageData || (a.path && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.path)));
						const isFile = Boolean(
							a.path && !a.isDir && a.mode !== "conversation" && a.mode !== "page" && a.mode !== "canvas",
						);
						const isPreviewable = Boolean(a.imageData || isFile);
						const imgSrc = a.imageData
							? a.imageData.startsWith("data:")
								? a.imageData
								: `data:${a.mimeType ?? "image/png"};base64,${a.imageData}`
							: isImage && a.path
								? resolveWorkspaceFileUrl(a.path)
								: undefined;
						const handlePreview = () => {
							if (imgSrc) {
								openImageLightbox({
									src: imgSrc,
									alt: a.name,
									onSaveAnnotation: onAnnotateImage ? (dataUrl) => onAnnotateImage(a, dataUrl) : undefined,
								});
							} else if (isFile && a.path) {
								openFilePreview({ path: a.path, name: a.name });
							}
						};
						const baseTitle = a.imageData
							? t("attachImage", { name: a.name })
							: a.fileData
								? t("attachFile", { name: a.name })
								: a.isDir
									? t("folderRef", { path: a.path })
									: a.mode === "page"
										? t("attachPage", { name: a.name })
										: a.mode === "canvas"
											? `${t("canvasTab")} · ${a.name}`
											: a.mode === "conversation"
												? t("attachConversation", { name: a.name })
												: a.mode === "reference"
													? t("refOnly", { path: a.path })
													: a.mode === "lines" && a.lines
														? t("attachLines", {
																path: a.path,
																start: a.lines.start,
																end: a.lines.end,
															})
														: t("attachContent", { path: a.path });
						return (
							<span
								key={
									a.key ??
									(a.mode === "conversation"
										? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}`
										: `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`)
								}
								className={`attach-chip ${a.imageData ? "image" : a.fileData ? "file" : a.mode}${isPreviewable ? " previewable" : ""}`}
								title={baseTitle + (isPreviewable ? ` (${isImage ? t("toolImageZoom") : t("fileOpenPreview")})` : "")}
								onClick={isPreviewable ? handlePreview : undefined}
								role={isPreviewable ? "button" : undefined}
								tabIndex={isPreviewable ? 0 : undefined}
								onKeyDown={
									isPreviewable
										? (e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													handlePreview();
												}
											}
										: undefined
								}
							>
								{imgSrc ? (
									<img
										crossOrigin={appResourceCrossOrigin(imgSrc)}
										src={imgSrc}
										alt={a.name}
										className="attach-thumb"
									/>
								) : a.fileData ? (
									"📄"
								) : a.isDir ? (
									"📁"
								) : a.mode === "page" ? (
									"🌐"
								) : a.mode === "canvas" ? (
									"◇"
								) : a.mode === "conversation" ? (
									"💬"
								) : a.mode === "reference" ? (
									"🔗"
								) : (
									"📎"
								)}
								{a.name}
								{a.mode === "lines" && a.lines && (
									<span className="attach-range">
										L{a.lines.start}-{a.lines.end}
									</span>
								)}
								<button
									type="button"
									className="attach-remove"
									title={t("removeAttachment")}
									onClick={(e) => {
										e.stopPropagation();
										onRemoveAttachment(
											a.key ??
												(a.mode === "conversation" ? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` : a.path),
										);
									}}
								>
									×
								</button>
							</span>
						);
					})}
					<span className="attach-hint">{t("attachHint")}</span>
				</div>
			)}
			{menu && menu.items.length > 0 && (
				<div
					className="slash-menu"
					role="listbox"
					ref={menuRef}
					aria-label={menu.kind === "slash" ? t("slashCommands") : t("atMentions")}
					data-menu-kind={menu.kind}
				>
					<div className="slash-menu-hint">
						<span>{menu.kind === "slash" ? t("slashMenuHint") : t("atMenuHint")}</span>
						<span className="slash-menu-close" onClick={() => setMenu(null)}>
							Esc
						</span>
					</div>
					{menu.kind === "slash" ? renderSlashRows() : renderAtRows()}
					{groupDevices && menu.kind === "at" && groupConversationError && (
						<div className="slash-desc" role="status">
							{groupConversationError}
						</div>
					)}
				</div>
			)}
			{pendingFill !== null && (
				<div className="modal-backdrop" onClick={() => resolvePendingFill("cancel")}>
					<div
						className="slash-help"
						role="dialog"
						aria-modal="true"
						aria-label={t("tpl.confirmFillTitle")}
						style={{ maxWidth: 420 }}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="slash-help-head">
							<span>{t("tpl.confirmFillTitle")}</span>
						</div>
						<div className="slash-help-body" style={{ padding: "12px 16px" }}>
							<p style={{ margin: "0 0 14px", lineHeight: 1.5 }}>{t("tpl.confirmFillDesc")}</p>
							<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
								<button type="button" className="btn" autoFocus onClick={() => resolvePendingFill("cancel")}>
									{t("cancel")}
								</button>
								<button type="button" className="btn" onClick={() => resolvePendingFill("append")}>
									{t("tpl.confirmFillAppend")}
								</button>
								<button type="button" className="btn primary" onClick={() => resolvePendingFill("overwrite")}>
									{t("tpl.confirmFillOverwrite")}
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
			{showHelp && (
				<div className="modal-backdrop" onClick={() => setShowHelp(false)}>
					<div
						className="slash-help"
						style={helpWidth ? { width: helpWidth } : undefined}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="slash-help-head">
							<span>⚡ {t("slashHelpTitle")}</span>
							<button type="button" className="btn" onClick={() => setShowHelp(false)}>
								{t("close")}
							</button>
						</div>
						<div className="slash-help-body">
							{allSlashCommands.length === 0 ? (
								<div className="slash-help-empty">{t("slashLoading")}</div>
							) : (
								allSlashCommands.map((c) => (
									<div className="slash-help-row" key={c.name}>
										<span className="slash-help-cmd">/{c.name}</span>
										<span className={`slash-source ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
										<span className="slash-help-desc">
											{slashDesc(c)}
											{c.argumentHint && <span className="slash-hint">{slashHint(c)}</span>}
										</span>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			)}
			{quickPhrasesEnabled && quickPhrases.length > 0 && (
				<div className="quick-row" aria-label={t("quickPhrases")} ref={quickRowRef}>
					{quickPhrases.map((p) => (
						<button
							key={p}
							type="button"
							className="quick-chip"
							title={`${t("quickPhrasesTip", { text: p })}（${t("quickPhrasesSendTip")}）`}
							disabled={!connected}
							onClick={() => sendPhrase(p)}
							onContextMenu={(e) => {
								e.preventDefault();
								e.stopPropagation();
								sendPhrase(p, true);
							}}
						>
							{p}
						</button>
					))}
				</div>
			)}
			<div className="inputbox" data-pi-anchor="composer">
				<div
					className={`composer-resize${composerH != null && composerH > COMPOSER_MIN_H + 4 ? " is-manual" : ""}`}
					aria-label={
						composerH != null && composerH > COMPOSER_MIN_H + 4 ? t("composerResizeFixed") : t("composerResize")
					}
					role="separator"
					aria-orientation="horizontal"
					aria-valuenow={Math.round(composerH ?? COMPOSER_MIN_H)}
					aria-valuemin={COMPOSER_MIN_H}
					aria-valuemax={COMPOSER_MAX_H}
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture?.(e.pointerId);
						const cur = taRef.current?.getBoundingClientRect().height;
						dragResizeRef.current = {
							startY: e.clientY,
							startH: typeof cur === "number" && Number.isFinite(cur) ? cur : (composerH ?? COMPOSER_MIN_H),
							next: null,
						};
					}}
					onPointerMove={(e) => {
						const d = dragResizeRef.current;
						if (!d) return;
						const maxCap = getComposerSafeMaxH();
						const next = Math.min(maxCap, Math.max(COMPOSER_MIN_H, d.startH + (d.startY - e.clientY)));
						d.next = next;
						if (next <= COMPOSER_MIN_H + 4) {
							setComposerH(null);
						} else {
							setComposerH(next);
						}
					}}
					onPointerUp={() => {
						const next = dragResizeRef.current?.next;
						dragResizeRef.current = null;
						if (next == null) return;
						try {
							if (next <= COMPOSER_MIN_H + 4) {
								setComposerH(null);
								localStorage.removeItem(COMPOSER_H_KEY);
							} else {
								const rounded = Math.round(next);
								setComposerH(rounded);
								localStorage.setItem(COMPOSER_H_KEY, String(rounded));
							}
						} catch {}
					}}
					onPointerCancel={() => {
						dragResizeRef.current = null;
					}}
					onDoubleClick={() => {
						setComposerH(null);
						try {
							localStorage.removeItem(COMPOSER_H_KEY);
						} catch {}
					}}
				>
					<span className="composer-resize-tip">
						{composerH != null && composerH > COMPOSER_MIN_H + 4 ? t("composerResizeFixed") : t("composerResize")}
					</span>
				</div>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						handleFiles(e.target.files);
						e.target.value = "";
					}}
				/>
				<textarea
					ref={taRef}
					value={text}
					rows={1}
					placeholder={
						groupDevices
							? groupPrimaryBotName
								? isZhLocale(locale)
									? `直接发送给 ${groupPrimaryBotName}，或 @ 其他 Bot`
									: `Message ${groupPrimaryBotName}, or @ another Bot`
								: isZhLocale(locale)
									? "输入 @，选择 Bot 开始新对话或继续之前的对话"
									: "Type @ to start or continue a Bot conversation"
							: connected
								? streaming
									? isDsh
										? t("placeholderStreamingQueued")
										: t("placeholderStreaming")
									: effectivePlanMode
										? t("placeholderPlanMode")
										: isModEnter
											? t("placeholderIdleMod")
											: t("placeholderIdle")
								: t("placeholderConnecting")
					}
					disabled={!connected}
					onChange={(e) => {
						handleTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
					}}
					onSelect={(e) => {
						if (menu?.kind === "at") {
							const cur = (e.target as HTMLTextAreaElement).selectionStart;
							if (cur < menu.start || cur > menu.end) {
								setMenu(null);
							}
						}
					}}
					onCompositionEnd={imeGuard.onCompositionEnd}
					onBlur={flushComposerDraft}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
				{effectivePlanMode && (
					<button
						type="button"
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							fontSize: 11,
							color: "var(--accent, #38bdf8)",
							background: "var(--accent-soft, rgba(56, 189, 248, 0.1))",
							padding: "2px 8px",
							borderRadius: 12,
							position: "absolute",
							right: 12,
							top: 8,
							cursor: "pointer",
							border: "1px solid var(--border, rgba(255, 255, 255, 0.1))",
							zIndex: 2,
						}}
						onClick={() => appSend({ type: "set_plan_mode", enabled: false })}
						title={t("planModeTip")}
					>
						📋 {t("planModeBadge")} <span style={{ marginLeft: 2, opacity: 0.7 }}>✕</span>
					</button>
				)}
				{groupDevices && groupPlanOnly && (
					<button
						type="button"
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							fontSize: 11,
							color: "var(--accent, #38bdf8)",
							background: "var(--accent-soft, rgba(56, 189, 248, 0.1))",
							padding: "2px 8px",
							borderRadius: 12,
							position: "absolute",
							right: 12,
							top: 8,
							cursor: "pointer",
							border: "1px solid var(--border, rgba(255, 255, 255, 0.1))",
							zIndex: 2,
						}}
						onClick={() => setGroupPlanOnly(false)}
						title={isZhLocale(locale) ? "群计划模式（只规划，不实施写操作）" : "Group plan mode (planning only)"}
					>
						📋 {isZhLocale(locale) ? "群计划模式" : "Group Plan Mode"}{" "}
						<span style={{ marginLeft: 2, opacity: 0.7 }}>✕</span>
					</button>
				)}
				<div className="composer-tools">
					{groupDevices ? (
						<>
							<div className="composer-tools-left">
								<button
									type="button"
									className="btn group-at-btn"
									title={isZhLocale(locale) ? "选择或 @ 群成员 Bot" : "Mention a Bot (@)"}
									onClick={() => {
										const ta = taRef.current;
										const cur = ta ? ta.selectionStart : text.length;
										const next = text.slice(0, cur) + "@" + text.slice(cur);
										handleTextChange(next, cur + 1);
										ta?.focus();
									}}
								>
									@
								</button>
								<button
									type="button"
									className={`btn group-plan-toggle ${groupPlanOnly ? "active" : ""}`}
									title={isZhLocale(locale) ? "群任务计划模式（只规划不实施）" : "Group task plan mode (plan only)"}
									onClick={() => setGroupPlanOnly((prev) => !prev)}
								>
									<span className="group-plan-icon">📋</span>
									<span className="group-plan-label">{isZhLocale(locale) ? "只规划" : "Plan Only"}</span>
								</button>
							</div>
							<div className="composer-tools-right">{renderActions()}</div>
						</>
					) : composerWired ? (
						<>
							<div className="composer-tools-left">
								{leadingActions.map(renderPluginAction)}
								{composerGroups.start.map(renderComposerEntry)}
							</div>
							{composerGroups.center.length > 0 && (
								<div className="composer-tools-center">{composerGroups.center.map(renderComposerEntry)}</div>
							)}
							<div className="composer-tools-right">{composerGroups.end.map(renderComposerEntry)}</div>
						</>
					) : (
						<>
							<div className="composer-tools-left">
								{leadingActions.map(renderPluginAction)}
								<button
									type="button"
									className="btn attach-img"
									title={t("uploadFile")}
									disabled={!connected}
									onClick={() => fileInputRef.current?.click()}
								>
									<FiPaperclip />
								</button>
								{pluginActions.start.map(renderPluginAction)}
								<button type="button" className="btn tpl-open" title={t("tpl.openPicker")} onClick={openPicker}>
									<FiBookOpen />
								</button>
								<ModelThinking
									state={modelState}
									models={models}
									modelsLoading={modelsLoading}
									onManageModels={onManageModels}
									providerKeys={providerKeys}
									defaultModel={defaultModel}
									compact
								/>
								{dshPermOptions && dshPermOptions.length > 0 && dshPermDefault !== undefined && (
									<DshPermissionBar
										compact
										current={dshPermCurrent ?? null}
										options={dshPermOptions}
										defaultPreset={dshPermDefault}
										conversationId={conversationId ?? ""}
									/>
								)}
								{dshPresets && dshPresets.length > 0 && dshPresetDefault !== undefined && (
									<DshPresetBar
										compact
										preset={dshPreset ?? null}
										presets={dshPresets}
										defaultPreset={dshPresetDefault}
										blank={dshBlank ?? false}
										conversationId={conversationId ?? ""}
									/>
								)}
							</div>
							{pluginActions.center.length > 0 && (
								<div className="composer-tools-center">{pluginActions.center.map(renderPluginAction)}</div>
							)}
							<div className="composer-tools-right">
								{pluginActions.end.map(renderPluginAction)}
								{renderActions()}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
});
