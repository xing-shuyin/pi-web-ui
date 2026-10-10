import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiList, FiSquare, FiPaperclip, FiArrowUp, FiBookOpen, FiMic, FiCamera } from "react-icons/fi";
import type { FileSearchResult, ModelInfo, ProviderKeyInfo, SlashCommandInfo, UiMessage, UiState } from "../types";
import { useT, useI18n } from "../i18n";
import { appSend, useAppField, useIsDsh } from "../app-globals";
import {
	applyTemplateFill,
	mergeRecalledDraft,
	selectDraftToRestore,
	shouldCarryOverDraft,
	shouldConfirmTemplateFill,
	type TemplateFillChoice,
} from "../composer-draft";
import {
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
import { resolveBackspaceMention } from "../chat-input-backspace";
import { copyTextToClipboard } from "../use-copy-feedback";
import { useImeCompositionGuard } from "../use-ime-composition-guard";
import { groupByAlign } from "../ui-slots";
import { nextSearchReqId } from "../search-req-id";

import { ModelThinking } from "./ModelThinking";
import { DshPresetBar, type DshPresetInfo } from "./DshPresetBar";
import { DshPermissionBar } from "./DshPermissionBar";
import type { DshPermissionOption, UiAgentPreset } from "../types";
import { useTemplates } from "./PromptTemplates";
import { TextQuoteCard } from "./TextQuoteCard";

/** True on touch-first devices (phones / tablets driven by a soft keyboard) —
 *  see `touch-device.ts` for the detection rules (Windows 触屏笔记本不算触屏，
 *  否则回车只换行、发不出去). */
const IS_TOUCH = detectTouchFirstDevice();

/** 输入框高度的拖拽范围（px）：composerH 是手动拉出的**保底高度**（默认没拖过是
 * 自适应、上限 220，与历史行为一致）。拖过之后：内容少时撑到这个高度（主动拉高
 * 可见），内容变多照样跟着长高到 720 才滚——自适应和手动两边都要；双击拖拽条
 * 恢复默认。持久化在 localStorage。 */
const COMPOSER_MIN_H = 40;
const COMPOSER_AUTO_H = 220;
const COMPOSER_MAX_H = 720;
const COMPOSER_H_KEY = "pi-web-ui:composer-height";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in (the messages ARRAY reference is kept stable
 *  by the server when the persisted set is unchanged), so the shallow-compared
 *  memo() below skips this input bar on every text delta. */
interface ChatInputProps {
	/** 输入框前置区条目（composer.leading 槽位：纯插件，无内置条目；渲染在文件上传按钮左侧）。 */
	composerLeading?: import("../ui-slots").UiSlotEntry[];
	/** 输入框动作区条目（composer.actions 槽位：内置 + 插件的最终结果）。 */
	composerActions?: import("../ui-slots").UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action/select）交给贡献它的插件
	 *  （select 切选项时第二个参数带选中的 value）。 */
	onUiAction?: (item: import("../ui-slots").UiSlotEntry, value?: string) => void;
	streaming: boolean;
	/** Persisted messages (stable reference while unchanged) — used by /copy. */
	messages: UiMessage[];
	slashCommands: SlashCommandInfo[];
	/** Forwarded to ModelThinking (all fields stable while streaming). */
	modelState: {
		model: UiState["model"];
		thinkingLevel: UiState["thinkingLevel"];
		availableThinkingLevels: UiState["availableThinkingLevels"];
	} | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	/** Files/folders attached via the right panel / preview, waiting to be sent. */
	attachments: {
		path: string;
		name: string;
		/** "page" = 已授权给 AI 的网页（page-picker）：path 是 origin、name 是标题。
		 *  "conversation" = 引用的另一个对话：path 不用，引用走 conversationId
		 *  （运行中，含子代理）或 sessionPath（历史转录）。
		 *  "inline" = 旧版「全文注入」的遗留值（服务端按 reference 处理）。
		 *  粘贴图片/上传文件没有 mode（path 为空）。 */
		mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote";
		quote?: import("../types").TextQuote;
		/** mode "conversation" + 引用运行中对话的 id（如 "c3"）。 */
		conversationId?: string;
		/** mode "conversation" + 引用历史会话的转录文件 path。 */
		sessionPath?: string;
		isDir?: boolean;
		lines?: { start: number; end: number };
		/** Raw pasted/dropped/uploaded image (no workspace path). */
		imageData?: string;
		mimeType?: string;
		/** Raw uploaded file bytes (no workspace path). */
		fileData?: string;
		size?: number;
		/** Stable key for pasted images (path is ""). */
		key?: string;
	}[];
	onRemoveAttachment: (path: string) => void;
	/** Images pasted into the input / dropped onto it / picked via upload. */
	onAddImageFiles: (files: File[]) => void;
	/** Any dropped/uploaded file (images go through onAddImageFiles instead). */
	onAddLocalFiles: (files: File[]) => void;
	/** `@` 提及命中带的路径附件（App.attach 包装，无则只插文本）。
	 *  silent = 本组件 acceptAt 已亲自插好提及文本，attach 不要再插一遍。 */
	onAddPathAttachment?: (a: {
		path: string;
		name: string;
		mode?: "inline" | "reference" | "lines" | "page";
		isDir?: boolean;
		lines?: { start: number; end: number };
		silent?: boolean;
	}) => void;
	/** 服务端文件名搜索结果（App 透传 chat.fileSearch；`@` 内置文件提供方消费）。 */
	fileSearch?: { reqId: number; ok: boolean; results: FileSearchResult[] } | null;
	/** 触发一次服务端文件名搜索（App 透传，内部 appSend search_files）。 */
	onSearchFiles?: (reqId: number, query: string) => void;
	/** Client-side notices (e.g. folders dropped). */
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	/** Called after a prompt is successfully sent — clears pending attachments. */
	onSent: () => void;
	/** Opens the custom-model config modal (mobile input row). */
	onManageModels: () => void;
	/** 被撤回的排队/插队消息队列：每项 seq 递增，effect 按序合并回输入框（空则填入、非空追加）。数组保证连续撤回多条不丢。 */
	recallDrafts?: { text: string; seq: number }[];
	/** Stored API keys per built-in provider (masked) — drives the picker's
	 *  multi-key grouping (click a model under a key to switch to it). */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 全局默认模型（undefined = 隐藏该功能，App 按 engine==='pi' 才传）。 */
	defaultModel?: string | null;
	/** 输入框上方的快捷短语（点击即发送；与文件引用 chips 是两套独立 UI，互不干扰）。 */
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	/** DSH 引擎：权限下拉（思考强度右侧；undefined/空 = 非 dsh 或未就绪，不渲染）。 */
	dshPermCurrent?: string | null;
	dshPermOptions?: DshPermissionOption[];
	dshPermDefault?: string;
	/** DSH 引擎：模式下拉（思考强度右侧；undefined/空 = 非 dsh 或未就绪，不渲染）。 */
	dshPreset?: DshPresetInfo | null;
	dshPresets?: UiAgentPreset[];
	dshPresetDefault?: string;
	dshBlank?: boolean;
	/** 会话 id（dsh 下拉切换会话时重置选中值）。 */
	conversationId?: string;
	/** 当前会话是否处于只读规划模式。 */
	planMode?: boolean;
	/** 服务端存过的未发送草稿（全量快照携带，issue #166 单中心文件方案；
	 *  DSH 引擎不填，传了也忽略）。 */
	sessionDraft?: { text: string; ts: number } | null;
	/** 当前会话的 sessionId（草稿跨重启的稳定 key；空 = 未就绪，不存不取）。 */
	sessionId?: string;
}

export const ChatInput = memo(function ChatInput({
	streaming,
	planMode,
	messages,
	slashCommands,
	modelState,
	models,
	modelsLoading,
	attachments,
	onRemoveAttachment,
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
}: ChatInputProps) {
	const t = useT();
	/** 连接/会话就绪：走全局（web/src/app-globals.ts），不再从 App 传。 */
	const ready = useAppField("ready");
	/** DSH 无 mid-run steering（isStreaming 时 prompt 全部走 followUp，
	 *  见 server/dsh/dsh-agent-service.ts）—— 只渲染「排队」半段，不摆一个说了不算的「插队」。 */
	const isDsh = useIsDsh();
	const { locale } = useI18n();
	/** 打开模板库（对话中途也可随时取用提示词模板）。 */
	const { openPicker } = useTemplates();
	const slashDesc = (c: SlashCommandInfo) =>
		locale !== "zh" && c.descriptionEn ? c.descriptionEn : (c.description ?? "");
	const slashHint = (c: SlashCommandInfo) =>
		locale !== "zh" && c.argumentHintEn ? c.argumentHintEn : (c.argumentHint ?? "");
	const [text, setText] = useState("");
	/** 手动拉出的保底高度：null = 没拖过（纯自适应，上限 220）；数字 = 保底（持久化）。
	 * 注意：这是下限不是固定值——内容少时撑到它，内容多时继续往上长。 */
	const [composerH, setComposerH] = useState<number | null>(() => {
		try {
			const v = Number(localStorage.getItem(COMPOSER_H_KEY));
			if (Number.isFinite(v) && v >= COMPOSER_MIN_H && v <= COMPOSER_MAX_H) return v;
		} catch {
			/* 无痕/配额满：用自适应 */
		}
		return null;
	});
	/** 拖拽中的起点（clientY + 起始高度；up 拉高、down 压低，见 onPointerMove）。
	 * next 记最后一次 move 算出的保底高度：pointerup 持久化走它（state 在连续 move 下
	 * 可能还没 flush，直接读 state 会存个落后几像素的旧值）；全程没 move（纯点击）
	 * 时 next 为 null，不写盘，自适应不被一次点击锁死。 */
	const dragResizeRef = useRef<{ startY: number; startH: number; next: number | null } | null>(null);
	/** 统一补全浮层：`/` 命令与 `@` 提及共用一个浮层，按 kind 换内容（互斥，
	 *  同一时间只可能开一个：slash 优先全文匹配，否则看光标前的 @ 词元）。 */
	type ComposerMenu =
		{ kind: "slash"; items: SlashCommandInfo[] } | { kind: "at"; start: number; end: number; items: AtHit[] };
	const [menu, setMenu] = useState<ComposerMenu | null>(null);
	const [menuIndex, setMenuIndex] = useState(0);
	/** `@` 异步查询的竞态 guard：迟到响应直接丢弃。 */
	const atReqRef = useRef(0);
	/** 等 search_files 回填的 waiter（reqId → resolve；超时/命中即删）。 */
	const fileWaiters = useRef(new Map<number, (v: unknown) => void>());
	/** 最近一次 refreshMenus 的输入（迟到响应与快照不一致即丢弃）。 */
	const menuTextRef = useRef("");
	/** /help modal — shows the full command catalog. */
	const [showHelp, setShowHelp] = useState(false);
	/** Width captured from the input box when /help opens — the modal overlays
	 *  the whole viewport, so it must measure the chat column to match. */
	const [helpWidth, setHelpWidth] = useState<number | undefined>(undefined);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	/** 全局 prompt 历史导航状态（issue #68）：-1 = 未在历史中，>=0 = 历史下标。 */
	const historyIndexRef = useRef(-1);
	const draftRef = useRef("");

	// 撤回的排队/插队消息 → 按序合并回输入框（空则填入、非空追加，见 composer-draft.ts）。
	// 用 lastRecallSeqRef 去重：已消费的 seq 不再应用（StrictMode/重复渲染下不会重复追加）；
	// 数组形式保证连续点两条时第一条不丢失（单槽会被后一次覆盖）。
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
		// 与 prompt 历史导航状态解耦：撤回后从「当前草稿」重新开始。
		historyIndexRef.current = -1;
		draftRef.current = "";
		requestAnimationFrame(() => {
			const ta = taRef.current;
			if (!ta) return;
			ta.focus();
			ta.selectionStart = ta.selectionEnd = ta.value.length;
		});
	}, [recallDrafts]);

	// 宿主注入草稿（浏览器元素拾取扩展 / 插件 → window.__piWebUiHost.compose）：
	// 合并语义与撤回完全一致（空则填入、非空追加、绝不覆盖），所以直接复用同一个纯函数。
	// 挂载时装一次：setText 是 useState 的稳定引用，不依赖任何会变的闭包。
	useEffect(() => {
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

	// 宿主触发聚焦（点击新对话等）。
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

	// 宿主触发在光标处插入文本（文件树/预览点击「引用路径」联动插入 @文件名）
	// 审查 #15：正文走 textRef（effect 每键重注册会让宿主桥反复解绑/挂载，
	// 且错过注册窗口的插入会丢）。textRef 在每次渲染同步最新正文，effect 依赖 []。
	const textRef = useRef("");
	textRef.current = text;
	useEffect(() => {
		registerInsertSink((textToInsert) => {
			// 第二道防线：正文里已有同一 @提及（重复点同一文件等）→ 跳过不重复插。
			// 同 tick 的双通道（@ 选单 acceptAt + attach）由 silent 分工，这里管跨 tick。
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

	// 宿主触发移除特定提及（用户点击附件 chip 的 ✕ 时联动从正文中删除对应的 @文件名）
	useEffect(() => {
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

	// 未发送草稿持久化（issue #166，单中心文件方案）：L1 localStorage（同步写，
	// 保住刷新/崩溃/beforeunload 的最后一击——beforeunload 时 WS 发已不可靠，
	// 但同步写过的 L1 还在）+ L2 服务端 <dataDir>/composer-drafts.json
	//（draft_update：防抖 2s + blur/切会话即时刷，保重启/换 tab）。
	// 恢复只在「本地没动过且输入框为空」时做（绝不覆盖用户正在打的字、撤回/注入/
	// 历史导航进来的内容），服务端快照 vs 本地 L1 按 ts 新的赢。DSH 引擎不参与。
	const DRAFT_TEXT_CAP = 20000; // 与服务端 DRAFT_TEXT_MAX 同值（两端各自截断）
	const DRAFT_SAVE_DEBOUNCE_MS = 2000;
	const draftSessionKey = !isDsh && sessionId ? `${conversationId ?? ""}${sessionId}` : null;
	const draftLocalKey = draftSessionKey && sessionId ? `pi-web-ui:composer-draft:${sessionId}` : null;
	const textMirrorRef = useRef("");
	const lastEditTsRef = useRef(0);
	/** 当前会话本地是否动过键盘（切会话重置；恢复的守卫条件之一）。 */
	const touchedRef = useRef(false);
	/** 已应用的恢复 ts（迟到的重复全量快照不再重应用）。 */
	const appliedDraftTsRef = useRef(0);
	const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftScopeRef = useRef<string | null>(null);
	const pendingCarryOverRef = useRef<string | null>(null);
	/** 输入法守卫（issue #248：macOS 中文输入法下敲英文字母按 Enter 上屏时，浏览器会先派发
	 *  compositionend 再派发 keydown(Enter, isComposing=false)，需通过时间差拦截误发送）。
	 *  判定与 ask_user_question 问卷输入框同源：web/src/ime-guard.ts。 */
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

	/** L1+L2 一起写（空文本 = 删除两边；sid 显式传——清理旧会话时调的是旧闭包）。 */
	const persistComposerDraft = (sid: string, localKey: string, text: string, ts: number) => {
		const capped = text.slice(0, DRAFT_TEXT_CAP);
		try {
			if (capped.trim()) localStorage.setItem(localKey, JSON.stringify({ text: capped, ts }));
			else localStorage.removeItem(localKey);
		} catch {
			// 配额满等：L2 还在，不崩
		}
		appSend({ type: "draft_update", sessionId: sid, text: capped, ts });
	};

	/** 把镜像里的当前内容刷出去（timer 到期 / blur / 切会话 / 快捷短语发送后回存）。 */
	const flushComposerDraft = () => {
		if (draftTimerRef.current) {
			clearTimeout(draftTimerRef.current);
			draftTimerRef.current = null;
		}
		// 没动过键盘就没东西可刷（恢复进来的内容不回刷，避免空转写盘）。
		if (!touchedRef.current || !draftSessionKey || !draftLocalKey || !sessionId || !connected) return;
		persistComposerDraft(sessionId, draftLocalKey, textMirrorRef.current, lastEditTsRef.current);
	};

	/** 用户一次键盘编辑：镜像 + L1 同步写 + L2 防抖。 */
	const noteComposerEdit = (value: string) => {
		textMirrorRef.current = value;
		touchedRef.current = true;
		lastEditTsRef.current = Date.now();
		if (draftLocalKey) {
			const capped = value.slice(0, DRAFT_TEXT_CAP);
			try {
				if (capped.trim())
					localStorage.setItem(draftLocalKey, JSON.stringify({ text: capped, ts: lastEditTsRef.current }));
				else localStorage.removeItem(draftLocalKey);
			} catch {
				// ignore
			}
		}
		if (draftSessionKey && sessionId && connected) {
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			const sid = sessionId;
			const localKey = draftLocalKey;
			const ts = lastEditTsRef.current;
			const scope = draftSessionKey;
			draftTimerRef.current = setTimeout(() => {
				draftTimerRef.current = null;
				// 开火时会话已切走 → 旧 timer 作废（切会话的 cleanup 刷过旧内容了）。
				if (scope !== draftScopeRef.current || !localKey) return;
				persistComposerDraft(sid, localKey, textMirrorRef.current, ts);
			}, DRAFT_SAVE_DEBOUNCE_MS);
		}
	};

	const handleTextChange = (value: string, cursor: number | null) => {
		// 用户手动编辑则退出历史导航（下次 Up 从最新开始）
		historyIndexRef.current = -1;
		setText(value);
		refreshMenus(value, cursor);
		noteComposerEdit(value);
	};

	// 切会话（conversationId/sessionId 任一变）：旧会话 timer 里没发出去的先刷掉
	//（cleanup 闭包里还是旧 sid/旧文本，key 不会写错），并记下未发出的打字内容。
	useEffect(() => {
		const scope = draftSessionKey;
		const sid = sessionId;
		const localKey = draftLocalKey;
		return () => {
			if (draftTimerRef.current) {
				clearTimeout(draftTimerRef.current);
				draftTimerRef.current = null;
			}
			if (touchedRef.current && textMirrorRef.current.trim()) {
				if (scope && sid && localKey) {
					persistComposerDraft(sid, localKey, textMirrorRef.current, lastEditTsRef.current);
				}
				pendingCarryOverRef.current = textMirrorRef.current;
			} else {
				pendingCarryOverRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftSessionKey]);

	// 新会话就绪：若切到全新空会话（messages 为空）且新会话无自身草稿，保留并承接用户未提交的正在输入内容。
	useEffect(() => {
		draftScopeRef.current = draftSessionKey;
		const carry = pendingCarryOverRef.current;
		pendingCarryOverRef.current = null;

		const existingLocal = draftLocalKey ? readLocalDraft(draftLocalKey) : null;
		const hasExistingDraft = Boolean(
			(sessionDraft && sessionDraft.text?.trim() && sessionDraft.ts > 0) ||
			(existingLocal && existingLocal.text?.trim()),
		);

		if (
			carry !== null &&
			shouldCarryOverDraft(carry, messages.length, hasExistingDraft) &&
			draftLocalKey &&
			sessionId
		) {
			touchedRef.current = true;
			appliedDraftTsRef.current = Date.now();
			textMirrorRef.current = carry;
			lastEditTsRef.current = appliedDraftTsRef.current;
			setText(carry);
			persistComposerDraft(sessionId, draftLocalKey, carry, lastEditTsRef.current);
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

	// 新对话自动聚焦：初次加载为新对话、或切到新对话（messages 为空）时自动聚焦。
	const prevSessionKeyRef = useRef<string | null>(null);
	useEffect(() => {
		const isNewChat = messages.length === 0;
		const sessionChanged = prevSessionKeyRef.current !== draftSessionKey;
		prevSessionKeyRef.current = draftSessionKey;
		if (ready && isNewChat && (!IS_TOUCH || sessionChanged)) {
			requestAnimationFrame(() => {
				taRef.current?.focus();
			});
		}
	}, [draftSessionKey, messages.length, ready]);

	// 恢复：服务端快照 vs 本地 L1，新的赢；本地动过 / 框里有东西一律不碰。
	// 无 dep 数组刻意不用——快照可能晚于会话切换到达，靠守卫条件保证幂等。
	// 决策见 composer-draft.ts 的 selectDraftToRestore（单测覆盖）。
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

	/** 重算统一浮层：slash 全文优先，否则看光标前的 @ 词元（异步问各 provider）。
	 *  cursor === null = 程序化改文本（历史导航/撤回/补全接受）：直接关浮层，
	 *  不猜光标（猜错位置会吞字）。 */
	const refreshMenus = (value: string, cursor: number | null) => {
		menuTextRef.current = value;
		// Match the RAW value (no trim): a trailing space must close the picker
		// so Enter right after it submits instead of completing the command.
		const m = value.match(/^\/([^\s]*)$/);
		if (m && ready) {
			const prefix = m[1].toLowerCase();
			// skill 条目名是 `skill:<name>`，这里额外用裸名匹配（见 ../slash-filter）。
			const matches = filterSlashCommands(slashCommands, prefix);
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
		// 查询作业 = 插件注册表 + 内置文件提供方（宿主自带，零插件也可用；
		// 空 query 不走文件搜索，裸 @ 不刷全量）。
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
		if (query && typeof onSearchFiles === "function") {
			jobs.push({ id: "host:files", label: t("openFiles"), run: () => searchBuiltinFiles(query) });
		}
		// 内置页面提供方（page-picker 已授权页）：读缓存同步出结果，后台节流刷新
		// （扩展在线才会问，桌面壳/未装扩展时缓存恒空，零打扰）。
		pokeBrowserControl();
		const immediatePages = mapPageHits(t("browserControl"), getLastBrowserControlPages(), query);
		jobs.push({
			id: "host:pages",
			label: t("browserControl"),
			run: () => Promise.resolve(immediatePages),
		});
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
			const pageItems: AtHit[] = [];
			const fileItems: AtHit[] = [];
			const pluginItems: AtHit[] = [];
			results.forEach((r, i) => {
				if (r.status !== "fulfilled") return;
				if (jobs[i].id === "host:pages" && Array.isArray(r.value)) pageItems.push(...(r.value as AtHit[]));
				else if (jobs[i].id === "host:files") fileItems.push(...mapFileHits(jobs[i].label, r.value));
				else pluginItems.push(...normalizeAtHits(jobs[i].id, jobs[i].label, r.value));
			});
			const items = mergeAtHits(
				{ pages: pageItems, skills: skillItems, files: fileItems, plugins: pluginItems },
				query,
				30,
			);
			setMenu(items.length > 0 ? { kind: "at", start, end, items } : null);
			// 仅在初次渲染浮层时重置高亮；若已展示过 eager 结果，保留用户已有键盘/鼠标选项目
			if (!eagerRendered && items.length > 0) {
				setMenuIndex(0);
			}
		});
	};

	/** 内置文件查询：发 search_files，命中回填时 resolve（超时 3s 回空）。 */
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

	// search_files 回填：按 reqId 唤醒等它的内置查询（对不上就丢，
	// 与 GlobalSearchModal 同口径；这里只管 waiter，展示走统一浮层）。
	useEffect(() => {
		if (!fileSearch || !fileSearch.ok) return;
		const resolve = fileWaiters.current.get(fileSearch.reqId);
		if (!resolve) return;
		fileWaiters.current.delete(fileSearch.reqId);
		resolve(fileSearch.results ?? []);
	}, [fileSearch]);

	/** 旧名（= refreshMenus 全文分支）：slash 全文匹配逻辑未动。 */
	const updateCompletions = (value: string) => refreshMenus(value, null);

	// Keep the highlighted command visible while navigating with the keyboard
	// (the picker scrolls; arrow keys must not leave the selection off-screen —
	// same behavior as the FooterBar path completions).
	useEffect(() => {
		const el = menuRef.current?.querySelector(".slash-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [menuIndex, menu]);

	/** Insert the highlighted command into the input (" /cmd " + rest). */
	const acceptSlash = (cmd?: SlashCommandInfo) => {
		const list = menu?.kind === "slash" ? menu.items : [];
		const pick = cmd ?? list[menuIndex % Math.max(list.length, 1)];
		if (!pick) {
			setMenu(null);
			return;
		}
		// Replace the current "/prefix" token with the completed command. The
		// trailing space closes the picker and lets the user type args right away.
		const m = text.match(/^\/([^\s]*)([\s\S]*)$/);
		const rest = m ? m[2] : "";
		const next = `/${pick.name} ${rest}`;
		menuTextRef.current = next;
		setText(next);
		noteComposerEdit(next);
		setMenu(null);
		taRef.current?.focus();
	};

	/** `@` 命中接受：光标处词元换成文本 + 附件进 chips（无文本回落 title）。 */
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
		const rawText = pick.text ?? pick.title;
		// 附件型命中（文件/目录/页签…）统一插 `@提及` 形式：正文里的 `@x` 与附件 chip
		// 双向联动（点 ✕ 双向删、退格整块删）；纯文本命中保持原样。
		const insert = atts.length > 0 && !rawText.startsWith("@") ? `@${rawText} ` : `${rawText} `;
		const next = `${text.slice(0, at)}${insert}${text.slice(replaceEnd)}`;
		menuTextRef.current = next;
		setText(next);
		noteComposerEdit(next);
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
			} catch {
				/* 单条附件失败不挡文本插入 */
			}
		}
		requestAnimationFrame(() => {
			const el = taRef.current;
			if (!el) return;
			el.focus();
			el.selectionStart = el.selectionEnd = at + insert.length;
		});
	};

	/** 统一浮层的两套行渲染（抽成函数：三元内联 JSX 在 .tsx 里解析脆弱）。 */
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
				title={h.hint ?? h.title}
			>
				<span className="slash-name">@{h.title}</span>
				<span className={`slash-source ${h.providerId === "host:skills" ? "skill" : "plugin"}`}>{h.providerLabel}</span>
				{h.hint && <span className="slash-desc">{h.hint}</span>}
			</button>
		));
	};

	/** 统一接受：按浮层 kind 分发（回车/Tab/点击共用）。 */
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
		if (!files || files.length === 0) {
			// A folder drag lands here with an empty FileList — tell the user.
			onNotice("warning", t("foldersNotSupported"));
			return;
		}
		const images = Array.from(files).filter((f) => isRasterImage(f.type));
		const others = Array.from(files).filter((f) => !isRasterImage(f.type));
		// P1-7：当前模型明确不支持图片（vision === false）时拒绝图片附件。
		const noVision = currentModelNoVision();
		if (images.length > 0 && noVision) {
			onNotice("warning", noVision);
		} else if (images.length > 0) {
			onAddImageFiles(images);
		}
		if (others.length > 0) onAddLocalFiles(others);
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		// 粘贴板里带真文件（文件管理器复制 / 截图 / 混合内容）→ 当附件附加；
		// 与拖拽同走 handleFiles：图片走视觉管线（含 noVision 拦截），其余走
		// fileData 上传。拿不到文件就是纯文本粘贴，不 preventDefault。
		const files = collectClipboardFiles(e.clipboardData?.items, e.clipboardData?.files);
		if (files.length === 0) return; // plain text paste — leave the default
		e.preventDefault();
		handleFiles(files);
	};

	/** 当前模型在模型清单中标记为 text-only（vision === false）→ 返回提示文案。
	 *  pi 引擎/自定义模型无此标记（undefined）→ 不阻止（视觉桥/后端兜底）。 */
	const currentModelNoVision = (): string | null => {
		const m = modelState?.model;
		if (!m?.id) return null;
		const info = models.find((x) => x.id === m.id);
		return info && info.vision === false ? t("modelNoVision", { name: info.name }) : null;
	};

	const connected = ready;

	// Re-open the picker when the command catalog arrives late — the user may
	// have typed "/" before the server pushed slash_commands (cold start).
	const lastTextRef = useRef(text);
	useEffect(() => {
		lastTextRef.current = text;
	}, [text]);
	useEffect(() => {
		updateCompletions(lastTextRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slashCommands]);

	// Fill the input from the welcome-page example cards / template picker (issue #586:
	// confirm before overwriting a non-empty composer draft).
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

	// Esc closes the /help modal or the template-fill confirm modal.
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

	// Auto-grow the textarea; no scrollbar until it hits the height cap.
	// composerH 是手动拉出的**保底高度**：没拖过走老逻辑（贴合内容，上限 220）；
	// 拖过之后高度 = max(内容高度, 保底)，上探到 720 才滚——内容少时手动拉高可见，
	// 内容多时照样自适应长高。maxHeight 写行内：样式表写死的 220px 会盖掉拖拽值，
	// 这里覆盖它（styles.css 那边另有改动在飞，不碰它；null 分支要写回 220，
	// 不然之前拖过的行内 720 会残留）。
	// Pin the anchor row: the composer sits BELOW the message list, so its
	// growth shrinks the list box from the bottom. Hold the row above the
	// composer stationary by scrolling down the exact grown amount, pre-paint.
	// Without this the input covers one more line per row. Runs in useEffect
	// on purpose: the layout effect measured the composer BEFORE the browser
	// applied the new textarea height (getBoundingClientRect reads the stale
	// box), so lines 2+ computed delta 0. The passive effect runs after the
	// flex layout settles — the measured delta is real each line.
	const composerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const ta = taRef.current;
		const box = composerRef.current;
		if (!ta || !box) return;
		// Save BEFORE the auto reset below: collapsing the textarea transiently
		// grows the list box, which clamps its scrollTop down. Restore after.
		const list = ta.closest("main")?.querySelector<HTMLElement>(".messages");
		const hBefore = box.getBoundingClientRect().height;
		const stBefore = list?.scrollTop ?? 0;
		ta.style.height = "auto"; // natural height first, then clamp
		const cap = composerH != null ? COMPOSER_MAX_H : COMPOSER_AUTO_H;
		ta.style.maxHeight = `${cap}px`;
		const h = Math.min(Math.max(ta.scrollHeight, composerH ?? 0), cap);
		ta.style.height = `${h}px`;
		ta.style.overflowY = ta.scrollHeight > h ? "auto" : "hidden";
		if (list) {
			const grew = box.getBoundingClientRect().height - hBefore;
			// Pre-transient position plus net growth: the row above the composer
			// stays stationary, pinned or reading history. grew=0 still
			// restores (undoes the transient clamp).
			list.scrollTop = stBefore + grew;
		}
	}, [text, composerH]);

	/** 快捷短语按钮行：整行高度实测写进 CSS 变量 `--quick-row-h`。消息区要按这个值
	 *  往下铺一层（.messages-wrap 的负 margin / .messages 的底部留白，见 styles.css
	 *  的「消息列表」），正文才能从短语行后面透出来；行高会随短语条数/窗口宽度变
	 *  （窄屏折行），所以挂 ResizeObserver 而不是只量一次。行不存在时归 0。 */
	const quickRowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = quickRowRef.current;
		const root = document.documentElement;
		if (!el) {
			root.style.removeProperty("--quick-row-h");
			return;
		}
		const apply = () => root.style.setProperty("--quick-row-h", `${el.offsetHeight}px`);
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--quick-row-h");
		};
	}, [quickPhrasesEnabled, quickPhrases.length]);

	/* 光标是否在首/末**视觉行**交给 caret-visual-line.ts：自动折行的长草稿（没有 \n，
	 * 但界面上是多行）也必须先让 ↑/↓ 走普通光标移动，不能误触发历史（issue #127）。 */

	/** 把当前待发送附件（含粘贴图/上传文件/工作区引用）转成 prompt 消息格式。
	 *  submit 与快捷短语发送共用 —— 点短语时文件引用同样带上，不丢失。 */
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
				// 网页引用：标题要一起送（服务端不读文件，用标题当卡片名）。
				...(a.mode === "page" ? { name: a.name } : {}),
				// 对话引用：id/path 二选一 + 标题（服务端只发 <conversation-ref>，转录由 AI 按需读）。
				...(a.mode === "conversation"
					? {
							name: a.name,
							...(a.conversationId ? { conversationId: a.conversationId } : {}),
							...(a.sessionPath ? { sessionPath: a.sessionPath } : {}),
						}
					: {}),
			};
		});

	const submit = (queue = false) => {
		const trimmed = text.trim();
		const hasAttach = attachments.length > 0;
		if (!trimmed && !hasAttach) return;
		if (!connected) {
			// 输入框在断连时不禁用（只有发送按钮禁用），Enter 仍进 submit：
			// 别静默吞掉，文本保留并给出可见提示供重连后重发。
			onNotice("error", t("netDisconnected"));
			return;
		}
		// Client-side slash commands (never sent to the server).
		if (trimmed === "/help") {
			// Match the modal width to the input box (the backdrop spans the full
			// viewport, so the CSS max-width would be wider than the chat column).
			const box = taRef.current?.closest(".inputbox")?.getBoundingClientRect();
			setHelpWidth(box?.width);
			setShowHelp(true);
			setText("");
			taRef.current?.focus();
			return;
		}
		if (trimmed === "/copy") {
			setText("");
			taRef.current?.focus();
			void copyLastAssistant();
			return;
		}
		// While the agent is streaming, the server queues this prompt as a
		// steering message (delivered as soon as the current assistant turn
		// settles, skipping remaining tool calls — the pi CLI Enter semantic)
		// and the agent immediately responds to it — see AgentService.prompt()
		// in agent-service.ts. 运行中发送位那颗「对半胶囊」的右半（插队）走这条；
		// 左半（排队）传 queue=true，服务端改走 followUp —— 整轮跑完才发
		// ("AI 生成结束才发送")。
		if (
			appSend({
				type: "prompt",
				text: trimmed,
				queue,
				attachments: buildPromptAttachments(),
			})
		) {
			// 入全局历史（连续重复不重复入队，已在 pushPromptHistory 内去重）——仅提交成功才记。
			if (trimmed) pushPromptHistory(trimmed);
			// 退出历史导航状态，下次 Up 从最新开始。
			historyIndexRef.current = -1;
			draftRef.current = "";
			setText("");
			// 发送成功：草稿作废（服务端 prompt() 里已清），本地 L1/定时器/追踪重置。
			if (draftLocalKey) {
				try {
					localStorage.removeItem(draftLocalKey);
				} catch {
					// ignore
				}
			}
			if (draftTimerRef.current) {
				clearTimeout(draftTimerRef.current);
				draftTimerRef.current = null;
			}
			touchedRef.current = false;
			// 提交时刻打水位（不是 0）：之前打的旧草稿（防抖延迟的 draft_update、
			// prompt() 处理前的全量快照里带的旧 draft）ts 都 <= 此刻，恢复 effect
			// 因此不再把刚发出去的文本倒回输入框（TODO 9）。提交后新打的字 ts
			// 更大，照常恢复；同 ms 的并列按「不恢复」算（`<=` 守卫）。
			appliedDraftTsRef.current = Date.now();
			textMirrorRef.current = "";
			lastEditTsRef.current = 0;
			onSent();
			// 提交成功 → 把本次使用的模型使用次数 +1（模型下拉按次数排序）。
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			taRef.current?.focus();
		} else {
			// 发送瞬间连接断开（appSend 返回 false）：文本保留，给出可见提示，
			// 否则与草稿恢复竞态的表现完全一样（字还在、无任何提示）。
			onNotice("error", t("netDisconnected"));
		}
	};

	/** 快捷短语一键发送：直接发出短语文本（带上当前文件附件），不碰输入框草稿。
	 *  左键 = 立即发送（运行中为插队 steer）；右键 = 排队发送（followUp，整轮结束后才发）。 */
	const sendPhrase = (phrase: string, queue = false) => {
		const trimmed = phrase.trim();
		if (!trimmed) return;
		if (!connected) {
			onNotice("error", t("netDisconnected"));
			return;
		}
		if (appSend({ type: "prompt", text: trimmed, queue, attachments: buildPromptAttachments() })) {
			if (trimmed) pushPromptHistory(trimmed);
			historyIndexRef.current = -1;
			draftRef.current = "";
			// 快捷短语不碰输入框：服务端 prompt() 会清草稿，这里把当前内容重存回去。
			flushComposerDraft();
			onSent();
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			// 触屏设备点击快捷短语后不回焦输入框：点按钮时虚拟键盘本未弹出，回焦会
			// 立刻把它弹起来盖住界面（发送按钮/回车路径本就处于键盘开启状态，不受
			// 影响，仍保留 submit() 里的回焦）。桌面端保留回焦，方便直接接着输入。
			if (!IS_TOUCH) taRef.current?.focus();
		} else {
			onNotice("error", t("netDisconnected"));
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// macOS 中文输入法下输入英文字母按 Enter 上屏时，浏览器会先触发 compositionend，
		// 紧接着立即派发 keydown (Enter, isComposing=false, keyCode=13)。
		// 若只查 isComposing 会漏掉该 Enter，导致文字刚上屏就误发送（issue #248）。
		// 三条件判定（isComposing / keyCode 229 / 距 compositionend < 50ms）见 web/src/ime-guard.ts。
		if (imeGuard.isImeKey(e.nativeEvent)) return;
		// 统一浮层导航（`/` 与 `@` 同一个浮层，按 kind 换内容）：上下 + 回车/Tab
		// 接受 + Esc 关闭。历史导航在浮层打开时让路（浮层优先级更高）。
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

		// 退格键原子化整块删除 @提及 并联动摘掉对应附件 chip（文件/目录/页签同一套）。
		// 逻辑收敛在纯函数 resolveBackspaceMention（单测锁定）：优先按最长相对路径精确匹配，
		// 彻底杜绝同名 basename（如 根目录报告 vs 方案/报告）退格误删。
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
		// 不绑定到特定会话；存储在 localStorage，跨对话全局共享。
		// 多行编辑时：仅当光标在首/末**视觉行**才进入历史（自动折行的长草稿同样算多行，
		// 见 caret-visual-line.ts），否则交给浏览器做普通光标移动，避免打断行内编辑。
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			// 修饰键组合不触发历史（避免与快捷键冲突）。
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const ta = taRef.current;
			if (!ta) return;
			const isUp = e.key === "ArrowUp";
			// 非边界视觉行：走光标移动，不进历史（自动折行也算多行）。
			const lineFlags = caretVisualLineFlags(ta);
			if (isUp && !lineFlags.first) return;
			if (!isUp && !lineFlags.last) return;
			// Down 且当前不在历史中：不消耗，让光标正常移动（末行 Down 本来就是无操作）。
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
				// 已在最旧一条：保持不动
			} else {
				// ArrowDown: 往更新方向
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
					// 越过最新一条：回到草稿（通常是空）
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
		// Esc：在历史中时先退出历史并回到草稿
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
		// Enter semantics: on touch-first devices (soft keyboard, no physical
		// Shift — see touch-device.ts) Enter inserts a newline and sending goes
		// through the on-screen button (Ctrl/Cmd+Enter also sends). Everywhere
		// else (desktop, incl. Windows 触屏笔记本) plain Enter sends.
		if (e.key === "Enter") {
			if (IS_TOUCH) {
				// Plain Return → default textarea behavior (insert a line break).
				if (!e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
			}
			if (!e.shiftKey) {
				e.preventDefault();
				submit();
			}
		}
	};

	// 有东西可发才允许提交（空文本 + 无附件时 submit() 直接 return）：
	// 空闲态的发送按钮和运行中的对半胶囊共用这一个条件。与 submit() 口径保持一致。
	const canSubmit = connected && (text.trim() !== "" || attachments.length > 0);

	// 插件输入框动作按 align 分组（未接线回落用；接线后统一走下面的 composerGroups）。
	const pluginActions = useMemo(
		() => groupByAlign((composerActions ?? []).filter((it) => it.source !== "host" && !it.hidden)),
		[composerActions],
	);
	// 输入框前置区（composer.leading）：纯插件槽位，按合并后的顺序整串渲染在上传按钮左侧。
	const leadingActions = useMemo(
		() => (composerLeading ?? []).filter((it) => it.source !== "host" && !it.hidden),
		[composerLeading],
	);
	// 输入框槽位是否已接线（App 传全量 slot 数组，含 hidden；单测/未传时回落旧硬编码顺序）。
	const composerWired = composerActions !== undefined;
	// 接线后的统一分组：宿主内置（上传/模板/模型/思考/DSH/发送）+ 插件贡献按合并顺序来，
	// hidden 已滤掉；align=start 落左列，center 居中，end 落右列（发送簇 align=end）。
	const composerGroups = useMemo(
		() => groupByAlign((composerActions ?? []).filter((it) => !it.hidden)),
		[composerActions],
	);
	const renderPluginAction = (it: import("../ui-slots").UiSlotEntry) => {
		// kind="select"：下拉框（当前值取 value ?? options[0]；切换直接回插件，不等确认）。
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
		// 插件 icon 是宿主图标词表名时映射到 feather 线条图标（与文件上传 FiPaperclip 同风格），
		// emoji/文字则原样当文本画。
		const icon = it.icon === "mic" ? <FiMic /> : it.icon === "camera" ? <FiCamera /> : it.icon || it.label;
		return (
			<button
				key={it.id}
				type="button"
				className="btn composer-plugin-action"
				title={it.hint || it.label}
				aria-label={it.label}
				onClick={() => onUiAction?.(it)}
			>
				{icon}
			</button>
		);
	};

	// Send / stop / steer+queue — rendered once inside the composer toolbar
	// (ChatInput .composer-tools-right). 运行中发送位与停止位二选一互斥：
	// 空输入（含无附件）时只显示停止键（蓝圆），插队/排队胶囊隐藏；
	// 一旦有可发送内容（canSubmit）则胶囊出现、停止键隐藏。
	// 胶囊：左半 = 排队（followUp，整轮结束才发），右半 = 插队（steer，回车语义，
	// 本回合立刻响应）；两半同宽、中间一条细分隔线。DSH 引擎没有 mid-run
	// steering（prompt 一律 followUp），所以那里只留下左半（.single 收成 38px）。
	const renderActions = () => (
		<div className="inputbox-actions">
			{streaming ? (
				canSubmit ? (
					<div className={`split-send${isDsh ? " single" : ""}`}>
						<button
							type="button"
							className="split-queue"
							title={t("supplementTip")}
							aria-label={t("queueFollowTag")}
							onClick={() => submit(true)}
						>
							<FiList />
						</button>
						{!isDsh && (
							<button
								type="button"
								className="split-steer"
								title={t("steerTip")}
								aria-label={t("queueSteerTag")}
								onClick={() => submit()}
							>
								<FiArrowUp />
							</button>
						)}
					</div>
				) : (
					<button type="button" className="btn stop" title={t("stopAgent")} onClick={() => appSend({ type: "abort" })}>
						<FiSquare />
					</button>
				)
			) : (
				<button type="button" className="btn send" title={t("sendTip")} disabled={!canSubmit} onClick={() => submit()}>
					<FiArrowUp />
				</button>
			)}
		</div>
	);
	/** 宿主内置输入框节点（key = composer.actions 条目 id；显隐与顺序由 composerGroups 决定）。
	 *  DSH 两项自带运行时条件（非 DSH / 未就绪时画 null，不占位）；发送簇含发送/排队/停止三种形态。 */
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
	/** 单条目渲染：宿主走工厂（未知 id 画 null，不白屏），插件走 renderPluginAction。 */
	const renderComposerEntry = (it: import("../ui-slots").UiSlotEntry) => {
		if (it.source === "host") return <Fragment key={it.id}>{composerHostNodes[it.id] ?? null}</Fragment>;
		return renderPluginAction(it);
	};

	return (
		<div
			ref={composerRef}
			className="inputbar"
			onDragOver={(e) => {
				// 只做 preventDefault（允许落点 drop）；提示交给全窗口遮罩
				// （App.tsx 的 .app-drop-overlay），输入条不再叠一层局部遮罩。
				e.preventDefault();
			}}
			onDrop={(e) => {
				// 输入条优先：stopPropagation 后 App 的 onDrop 不再重复附加。
				e.preventDefault();
				e.stopPropagation();
				handleFiles(e.dataTransfer?.files ?? null);
			}}
		>
			{attachments.length > 0 && (
				<div className="attach-row">
					{attachments.map((a) =>
						a.mode === "quote" && a.quote ? (
							<TextQuoteCard key={a.key} quote={a.quote} onRemove={() => onRemoveAttachment(a.key ?? "")} />
						) : (
							<span
								key={
									a.key ??
									(a.mode === "conversation"
										? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}`
										: `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`)
								}
								className={`attach-chip ${a.imageData ? "image" : a.fileData ? "file" : a.mode}`}
								title={
									a.imageData
										? t("attachImage", { name: a.name })
										: a.fileData
											? t("attachFile", { name: a.name })
											: a.isDir
												? t("folderRef", { path: a.path })
												: a.mode === "page"
													? t("attachPage", { name: a.name })
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
																: t("attachContent", { path: a.path })
								}
							>
								{a.imageData
									? "🖼"
									: a.fileData
										? "📄"
										: a.isDir
											? "📁"
											: a.mode === "page"
												? "🌐"
												: a.mode === "conversation"
													? "💬"
													: a.mode === "reference"
														? "🔗"
														: "📎"}
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
									onClick={() =>
										onRemoveAttachment(
											a.key ??
												(a.mode === "conversation" ? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` : a.path),
										)
									}
								>
									×
								</button>
							</span>
						),
					)}
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
							{slashCommands.length === 0 ? (
								<div className="slash-help-empty">{t("slashLoading")}</div>
							) : (
								slashCommands.map((c) => (
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
				{/* 顶部拖拽条：上下拖动定保底高度（40–720px，localStorage 持久化；
				 * 内容少时撑到这个高度，内容多时继续往上长），双击恢复默认。 */}
				<div
					className="composer-resize"
					title={t("composerResize")}
					aria-label={t("composerResize")}
					role="separator"
					aria-orientation="horizontal"
					aria-valuenow={Math.round(composerH ?? COMPOSER_AUTO_H)}
					aria-valuemin={COMPOSER_MIN_H}
					aria-valuemax={COMPOSER_MAX_H}
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture?.(e.pointerId);
						// 从当前渲染高度起算：第一次拖也没有跳变（保底语义下起算点只影响
						// 本次拖拽的手感，松手后高度仍由内容+保底重算）。
						const cur = taRef.current?.getBoundingClientRect().height;
						dragResizeRef.current = {
							startY: e.clientY,
							startH: typeof cur === "number" && Number.isFinite(cur) ? cur : (composerH ?? COMPOSER_AUTO_H),
							next: null,
						};
					}}
					onPointerMove={(e) => {
						const d = dragResizeRef.current;
						if (!d) return;
						// 往上拖（clientY 变小）= 抬保底，往下拖 = 压保底，所见即所得
						//（内容少时输入框跟着变高/变矮；内容很多时撑着内容，往下压暂不可见）。
						const next = Math.min(COMPOSER_MAX_H, Math.max(COMPOSER_MIN_H, d.startH + (d.startY - e.clientY)));
						d.next = next;
						setComposerH(next);
					}}
					onPointerUp={() => {
						const next = dragResizeRef.current?.next;
						dragResizeRef.current = null;
						// 没拖动过的纯点击不写盘（否则一次点击就把保底变成当前高度）；
						// 读 ref 不读 state：连续 move 下 state 可能落后一次渲染。
						if (next == null) return;
						try {
							localStorage.setItem(COMPOSER_H_KEY, String(Math.round(next)));
						} catch {
							/* 配额满：本次生效，下次回默认 */
						}
					}}
					onPointerCancel={() => {
						dragResizeRef.current = null;
					}}
					onDoubleClick={() => {
						setComposerH(null);
						try {
							localStorage.removeItem(COMPOSER_H_KEY);
						} catch {
							/* ignore */
						}
					}}
				/>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						handleFiles(e.target.files);
						e.target.value = ""; // allow re-picking the same file
					}}
				/>
				<textarea
					ref={taRef}
					value={text}
					rows={1}
					placeholder={
						connected
							? streaming
								? isDsh
									? t("placeholderStreamingQueued")
									: t("placeholderStreaming")
								: planMode
									? t("placeholderPlanMode")
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
				{planMode && (
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
				{/* 底部工具条（ChatGPT 风格）：附件 / 模型 / 思考强度 在左，
				    发送 / 停止 在右，全部收进输入框容器内。 */}
				<div className="composer-tools">
					{composerWired ? (
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
								{/* 插件输入框动作（start 组）：紧跟文件上传右侧，与上传同一组线条图标风格。 */}
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
								{/* DSH 引擎：权限 + 模式下拉（思考强度右侧，只留按钮）。 */}
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
								{/* 插件贡献的输入框动作（issue #146）：align 分三组：start 已在文件上传右侧渲染，center 居中，end 紧贴发送键；
 只画图标（label 进 title/aria），无图标的才回落显示文字。 */}
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
