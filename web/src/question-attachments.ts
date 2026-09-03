/**
 * question-attachments — 编辑重问的「原附件恢复」收集纯函数。
 *
 * Web UI 的 prompt 会把附件作为独立的 custom "file" aside 卡片、紧跟在该条
 * 用户消息之后持久化；编辑重问时 fork 会裁掉这些 aside（它们在新分支上），
 * 所以编辑器需要这份清单来恢复。收集三类：
 *   · 粘贴/上传的图片（imageData）—— 从 aside 的 image 块取 base64（含视觉
 *     桥转写卡片的缩略图）；
 *   · 上传的文件（uploadPath）—— 服务端已把字节落在 uploads 目录，重发
 *     details.path 让服务端重读即可（不进快照、不重复 base64）；
 *   · 工作区路径附件（inline/reference/lines/folder）—— 相对路径在 fork 后
 *     仍有效，带 path+mode 重发走同一附件管线。
 *
 * 纯函数、零依赖。输入用宽类型（content: readonly unknown[]）+ 内部收窄，
 * 既不 import ./types（单测在 NodeNext 下会因扩展名缺失 shim 报 TS2835），
 * 也让任意 UiMessage 都能传入。
 */
/** PromptAttachment 的结构化镜像（与 server/protocol.ts 一致）。 */
export interface EditPromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines";
	lines?: { start: number; end: number };
	imageData?: string;
	fileData?: string;
	uploadPath?: string;
	mimeType?: string;
	name?: string;
	size?: number;
}

/** image 块（运行时收窄用）。 */
interface ImageBlock {
	type: "image";
	dataUrl?: string;
}

/** 从 image 块还原 imageData 附件（dataUrl → 纯 base64）；有图片块返回 true。 */
function pushImageAttachments(
	atts: EditPromptAttachment[],
	content: readonly unknown[],
	fallbackName?: string,
): boolean {
	let hasImage = false;
	for (const b of content) {
		const img = b as ImageBlock;
		if (img.type !== "image" || typeof img.dataUrl !== "string") continue;
		if (!img.dataUrl.startsWith("data:")) continue;
		const mm = img.dataUrl.match(/^data:([^;]*);base64,(.+)$/);
		if (!mm) continue;
		hasImage = true;
		atts.push({
			path: "",
			imageData: mm[2],
			mimeType: mm[1] || "image/png",
			name: fallbackName ?? `image.${(mm[1] || "image/png").split("/")[1] ?? "png"}`,
		});
	}
	return hasImage;
}

export function collectQuestionAttachments(
	messages: readonly {
		id?: string;
		role: string;
		content: readonly unknown[];
		details?: unknown;
		customType?: string;
	}[],
): Map<string, EditPromptAttachment[]> {
	const m = new Map<string, EditPromptAttachment[]>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" || !msg.id) continue;
		// Own image blocks first (sessions where prompt(images) put them into
		// the user content itself).
		const atts: EditPromptAttachment[] = [];
		pushImageAttachments(atts, msg.content);
		// Then the attachment-card run that follows this question (stops at
		// any other message kind — assistant/toolResult/next user/etc.).
		for (
			let j = i + 1;
			j < messages.length && messages[j].role === "custom" && messages[j].customType === "file";
			j++
		) {
			const details = (messages[j].details ?? {}) as {
				mode?: string;
				name?: string;
				size?: number;
				path?: string;
				startLine?: number;
				endLine?: number;
				upload?: boolean;
			};
			// 1) Image card (pasted/uploaded images incl. bridged thumbnails) —
			//    the raw base64 lives in the image blocks.
			if (pushImageAttachments(atts, messages[j].content, details.name)) continue;
			// 2) Uploaded file (fileData) — re-send the server-generated upload
			//    path; the server re-reads the persisted bytes from disk.
			if (details.upload && details.path) {
				atts.push({
					path: "",
					uploadPath: details.path,
					name: details.name ?? details.path,
					size: details.size,
				});
				continue;
			}
			// 3) Workspace-path attachment (inline / reference / lines / folder)
			//    — the relative path stays valid on the new branch, so a path +
			//    mode spec is enough to re-attach it.
			if (details.path && details.mode) {
				const mode = details.mode === "inline" || details.mode === "lines" ? details.mode : "reference";
				const att: EditPromptAttachment = { path: details.path, mode };
				if (details.mode === "lines" && typeof details.startLine === "number" && typeof details.endLine === "number") {
					att.lines = { start: details.startLine, end: details.endLine };
				}
				atts.push(att);
			}
		}
		if (atts.length > 0) m.set(msg.id, atts);
	}
	return m;
}
