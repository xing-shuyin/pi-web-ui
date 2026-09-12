/// <reference lib="dom" />
/**
 * 输入框注入桥 —— 宿主把内容**放进输入框草稿**的反向通道。
 *
 * 与 plugin-host.ts 的分工：那边是「新建对话并把一段话直接发出去」（startChat）；
 * 这里解决另一半：把外部拾取 / 生成的内容塞进输入框，**让用户补一句话再自己发**。
 * 第一个用户是浏览器元素拾取扩展（plugins/page-picker）：在开发网页上选元素 →
 * 渲染成 Markdown → 注入 pi-web-ui 输入框 → 用户补「这三处间距不一致」再发。
 *
 * 为什么要 sink 注册：草稿文本在 ChatInput 内部 state（text），待发附件在 App state
 * （attachments），两处各自在自己挂载时注册自己那一半。宿主侧只认这一个模块级入口，
 * 不关心谁实现。
 *
 * 与 app-globals 的纪律一致：这里只放**跨边界动作**，不放状态、不吃快照流
 * （store 通知会绕过 memo）。
 */

import type { DraftAttachment } from "./composer-draft";

/** 注入内容。 */
export interface ComposerPayload {
	/** 要并入输入框的文本（空 / 全空白 = 只加附件）。 */
	text?: string;
	/** 要追加到待发附件的项（如元素截图）。 */
	attachments?: DraftAttachment[];
}

/** 文本 sink：ChatInput 挂载时注册（自己决定怎么并入，见 mergeRecalledDraft）。 */
type DraftSink = (text: string) => void;
/** 附件 sink：App 挂载时注册（自己决定怎么追加，见 appendDraftAttachments）。 */
type AttachmentSink = (items: DraftAttachment[]) => void;

let draftSink: DraftSink | null = null;
let attachmentSink: AttachmentSink | null = null;

/** ChatInput 注册 / 注销（传 null）文本那一半。可重复调用，后注册的覆盖先前的。 */
export function registerDraftSink(fn: DraftSink | null): void {
	draftSink = fn;
}

/** App 注册 / 注销（传 null）附件那一半。 */
export function registerAttachmentSink(fn: AttachmentSink | null): void {
	attachmentSink = fn;
}

/** 有没有输入框在听（页面还没挂载好 = false，宿主该拒收而不是静默丢）。 */
export function isComposerReady(): boolean {
	return Boolean(draftSink || attachmentSink);
}

/** 仅供单测：清掉注册表（避免用例之间互相串）。 */
export function resetComposerSinks(): void {
	draftSink = null;
	attachmentSink = null;
}

/**
 * 把内容注入输入框草稿，返回是否受理。
 *
 * 语义要点：
 * - **不要求连接就绪**：草稿是纯本地状态，断线也能先攒着（与 startChat 不同）。
 * - **全有或全无**：先检查两半 sink 是否都在，任一缺失就整笔拒收并返回 false ——
 *   免得「附件加进去了、文本没加」这种半截状态让调用方重试时附件翻倍。
 * - 内容全空（无文本且无附件）→ false。
 * - 附件先落、文本后并：用户看到的是「草稿带上附件」。
 */
export function composeToComposer(payload: ComposerPayload): boolean {
	const text = typeof payload?.text === "string" ? payload.text : "";
	const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
	const wantsText = text.trim() !== "";
	const wantsAttachments = attachments.length > 0;
	if (!wantsText && !wantsAttachments) return false;
	if (wantsText && !draftSink) return false;
	if (wantsAttachments && !attachmentSink) return false;
	// 前置检查已通过 → 后面不会再失败，不会出现半截状态
	if (wantsAttachments) attachmentSink?.(attachments);
	if (wantsText) draftSink?.(text);
	return true;
}
