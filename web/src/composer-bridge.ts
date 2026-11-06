/// <reference lib="dom" />

import type { DraftAttachment } from "./composer-draft";

export interface ComposerPayload {
	text?: string;
	attachments?: DraftAttachment[];
}

export interface ComposerTarget {
	compose(payload: ComposerPayload): boolean;
	insertText(text: string): boolean;
	focus(): boolean;
	removeMention?(mention: string): boolean;
}

let activeTarget: { target: ComposerTarget } | null = null;

export function getComposerTarget(): ComposerTarget | null {
	return activeTarget?.target ?? null;
}

export function registerComposerTarget(target: ComposerTarget): () => void {
	const registration = { target };
	activeTarget = registration;
	return () => {
		if (activeTarget === registration) activeTarget = null;
	};
}

type DraftSink = (text: string) => void;
type AttachmentSink = (items: DraftAttachment[]) => void;
type FocusSink = () => void;

let draftSink: DraftSink | null = null;
let attachmentSink: AttachmentSink | null = null;
let focusSink: FocusSink | null = null;
let insertSink: ((text: string) => void) | null = null;
let removeMentionSink: ((mention: string) => void) | null = null;

export function registerInsertSink(fn: ((text: string) => void) | null): void {
	insertSink = fn;
}

export function registerRemoveMentionSink(fn: ((mention: string) => void) | null): void {
	removeMentionSink = fn;
}

export function insertTextAtCursor(text: string): boolean {
	if (activeTarget) return activeTarget.target.insertText(text);
	if (!insertSink) return false;
	insertSink(text);
	return true;
}

export function removeMentionFromComposer(mention: string): boolean {
	if (activeTarget) return activeTarget.target.removeMention?.(mention) ?? false;
	if (!removeMentionSink) return false;
	removeMentionSink(mention);
	return true;
}

export function registerDraftSink(fn: DraftSink | null): void {
	draftSink = fn;
}

export function registerAttachmentSink(fn: AttachmentSink | null): void {
	attachmentSink = fn;
}

export function registerFocusSink(fn: FocusSink | null): void {
	focusSink = fn;
}

export function focusComposer(): boolean {
	if (activeTarget) return activeTarget.target.focus();
	if (!focusSink) return false;
	focusSink();
	return true;
}

let lastSessionSwitchInitiatedAt = 0;
let sessionSwitchSink: (() => void) | null = null;

export function registerSessionSwitchSink(fn: (() => void) | null): void {
	sessionSwitchSink = fn;
}

export function notifySessionSwitch(): void {
	lastSessionSwitchInitiatedAt = Date.now();
	sessionSwitchSink?.();
	focusComposer();
}

export function getLastSessionSwitchTime(): number {
	return lastSessionSwitchInitiatedAt;
}

export function isComposerReady(): boolean {
	return Boolean(activeTarget || draftSink || attachmentSink);
}

export function resetComposerSinks(): void {
	activeTarget = null;
	draftSink = null;
	attachmentSink = null;
	focusSink = null;
	insertSink = null;
	removeMentionSink = null;
	lastSessionSwitchInitiatedAt = 0;
	sessionSwitchSink = null;
}

export function composeToComposer(payload: ComposerPayload): boolean {
	const text = typeof payload?.text === "string" ? payload.text : "";
	const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
	const wantsText = text.trim() !== "";
	const wantsAttachments = attachments.length > 0;
	if (!wantsText && !wantsAttachments) return false;
	if (activeTarget) return activeTarget.target.compose({ text, attachments });
	if (wantsText && !draftSink) return false;
	if (wantsAttachments && !attachmentSink) return false;
	if (wantsAttachments) attachmentSink?.(attachments);
	if (wantsText) draftSink?.(text);
	return true;
}
