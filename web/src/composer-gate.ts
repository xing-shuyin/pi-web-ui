import type { MessageKey } from "./i18n/catalog";

/**
 * 发送闸门：composer 里「这份草稿为什么发不出去」的唯一判定点。
 *
 * 只收「用户能在输入框里当场改掉」的原因（引擎能力缺失）；
 * 连接断开 / 引擎未就绪属于运行态，仍由发送按钮 title 与提交时的 notice 表达，
 * 不在这里重复——否则每加一条运行态条件，`canSubmit` 与提交分支就要各改一次。
 *
 * 兼管「目标态附件 → 材料指针」的投影（`goalMaterialsOf`）：目标的规格只收路径字符串
 * （`docs/proposals/material-spec-contract.md` R1），base64 一律不进，被丢下的由调用方给 notice（R6）。
 *
 * 依赖只有 i18n 的键类型：纯函数，React 无关，可单测。
 */

/** 与 `ChatInputProps["attachments"][number]` 结构兼容的最小投影。 */
export interface SendableAttachment {
	path: string;
	mode?: string;
	key?: string;
	conversationId?: string;
	sessionPath?: string;
}

export interface SendBlock {
	level: "warning" | "error";
	/** i18n 键：直接喂给 `t()`。 */
	key: MessageKey;
}

export interface SendGateInput {
	attachments: readonly SendableAttachment[];
	/** 引擎是否支持「引用整段对话」附件。 */
	conversationRefSupported: boolean;
}

/** 草稿是否有可发内容：文本或附件任一非空。 */
export function hasSendableContent(text: string, attachments: readonly SendableAttachment[] | undefined): boolean {
	return Boolean(text.trim()) || Boolean(attachments && attachments.length > 0);
}

/**
 * 附件在 PendingAttachment 列表里的稳定身份。
 * `key` 是权威；老附件没有 key 时按 mode 回退（对话引用必须带 conversationId/sessionPath，
 * 否则两段对话引用会互相覆盖成同一个键）。
 */
export function attachmentKey(a: SendableAttachment): string {
	if (a.key) return a.key;
	return a.mode === "conversation" ? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` : a.path;
}

/** 返回阻塞原因；`null` = 可以发。 */
export function sendBlockedReason(input: SendGateInput): SendBlock | null {
	const { attachments, conversationRefSupported } = input;
	if (!conversationRefSupported && attachments.some((a) => a.mode === "conversation")) {
		return { level: "warning", key: "chatInputConversationRefUnsupported" };
	}
	return null;
}

/** 与 `buildPromptAttachments()` 结果结构兼容的最小投影（只关心「有没有可寻址路径」）。 */
export interface MaterialAttachment {
	path: string;
	imageData?: string;
	fileData?: string;
	name?: string;
	mimeType?: string;
}

export interface GoalMaterialBlob {
	name?: string;
	mimeType?: string;
	/** base64 */
	data: string;
}

export interface GoalMaterialsProjection {
	/** 可直接进规格的材料指针（工作区相对 / 绝对路径 / URI） */
	materials: string[];
	/** 无路径但有 base64 的附件：随消息瞬态上传，服务端落盘后并入 materials（R1 的唯一出口） */
	blobs: GoalMaterialBlob[];
	/** 既无路径也无数据的附件：调用方必须给 notice（R6） */
	unusable: string[];
}

/**
 * 目标态发送前把附件投影成材料指针。
 *
 * R1：规格里只能存路径字符串，`imageData` / `fileData` 这类 base64 一律不进；
 * 这些附件被跳过时**不许静默**（R6），由调用方用 `unusable` 生成一条 notice——但仍然照常发送目标。
 */
export function goalMaterialsOf(attachments: readonly MaterialAttachment[]): GoalMaterialsProjection {
	const materials: string[] = [];
	const blobs: GoalMaterialBlob[] = [];
	const unusable: string[] = [];
	for (const a of attachments) {
		const path = (a.path ?? "").trim();
		if (path) {
			if (!materials.includes(path)) materials.push(path);
			continue;
		}
		const data = (a.imageData ?? a.fileData ?? "").trim();
		if (data) {
			// 粘贴图/剪贴板文件：线上带着走，服务端落盘成内容寻址路径后再进规格。
			blobs.push({
				...(a.name ? { name: a.name } : {}),
				...(a.mimeType ? { mimeType: a.mimeType } : {}),
				data,
			});
			continue;
		}
		unusable.push(a.name?.trim() || "(unnamed)");
	}
	return { materials, blobs, unusable };
}
