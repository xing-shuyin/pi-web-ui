import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { PromptAttachment, UiMessage } from "../protocol.js";
import { readSkillInstruction, type DiscoveredSkill } from "../skill-discovery.js";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";
import { CLIENT_ID_PATTERN, saveUpload, uploadsRoot } from "../uploads.js";

export function formatUnavailableCanvasReference(att: PromptAttachment): string {
	const escape = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<canvas-ref id="${escape(att.path)}" title="${escape(att.name || att.path)}">Canvas tooling is unavailable in this engine. This is a graph identifier, not a file path; do not read it as a file or start a run.</canvas-ref>`;
}

/** Image MIME types the native CLIs accept as inline image input. */
export const CLI_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** Splits `data:<mime>;base64,<data>` (or bare base64 + mimeType) into its parts. */
export function decodeInlineImage(att: PromptAttachment): { mimeType: string; data: string } | null {
	if (!att.imageData) return null;
	const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(att.imageData);
	const mimeType = (match?.[1] ?? att.mimeType ?? "").toLowerCase();
	const data = (match?.[2] ?? att.imageData).replace(/\s+/g, "");
	if (!(CLI_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType) || !data) return null;
	return { mimeType, data };
}

/**
 * Persists browser uploads (`fileData`, or unsupported inline images) into the per-client upload
 * dir so the native CLI can open them by absolute path; turns relative `uploadPath`s absolute.
 * Upload retention/cleanup is shared with the pi engine (`server/uploads.ts`).
 */
export function materializeUploads(
	attachments: readonly PromptAttachment[],
	opts: { clientId: string; dataDir?: string; maxInlineImageBytes?: number },
): PromptAttachment[] {
	const clientId = CLIENT_ID_PATTERN.test(opts.clientId) ? opts.clientId : "universal";
	const root = uploadsRoot(opts.dataDir || undefined);
	return attachments.map((att) => {
		const image = decodeInlineImage(att);
		const oversized =
			image !== null &&
			opts.maxInlineImageBytes !== undefined &&
			(image.data.length * 3) / 4 > opts.maxInlineImageBytes;
		const encoded = att.fileData ?? (att.imageData && (!image || oversized) ? att.imageData : undefined);
		if (encoded) {
			const raw = encoded.replace(/^data:[^;,]+;base64,/, "");
			const { abs } = saveUpload(clientId, att.name || "file", Buffer.from(raw, "base64"), opts.dataDir || undefined);
			const { fileData: _f, imageData: _i, ...rest } = att;
			return { ...rest, uploadPath: abs, name: att.name || basename(abs) };
		}
		if (att.uploadPath) {
			const abs = resolve(root, att.uploadPath);
			const rel = relative(root, abs);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
				const { uploadPath: _u, ...rest } = att;
				return rest;
			}
			return { ...att, uploadPath: abs };
		}
		return att;
	});
}

/** Plain-text pointer for a non-image attachment, shared by the CLI drivers. */
export function describeCliAttachment(att: PromptAttachment): string | null {
	if (att.mode === "canvas") return formatUnavailableCanvasReference(att);
	if (att.mode === "page" || att.mode === "conversation")
		return `Referenced ${att.mode}: ${JSON.stringify(att.path)} (host access unavailable in this engine).`;
	if (att.mode === "quote" && att.quote) return `<quote>\n${att.quote.text}\n</quote>`;
	if (att.uploadPath)
		return `Attached file: ${JSON.stringify(att.uploadPath)}${att.name ? ` (${att.name})` : ""}. Read it from this path.`;
	if (att.path)
		return `File reference: ${JSON.stringify(att.path)}${att.mode === "lines" && att.lines ? ` (lines ${att.lines.start}-${att.lines.end})` : ""}`;
	return null;
}

export interface ScanResult {
	detectedAttachments: PromptAttachment[];
	detectedSkills: DiscoveredSkill[];
}

export function scanAtMentions(
	text: string,
	cwd: string,
	availableSkills: readonly DiscoveredSkill[] = [],
	existingAttachments: readonly PromptAttachment[] = [],
): ScanResult {
	const detectedAttachments: PromptAttachment[] = [];
	const detectedSkills: DiscoveredSkill[] = [];
	const existingPaths = new Set(existingAttachments.map((a) => a.path).filter(Boolean));

	const skillRegex = /@skill:([A-Za-z0-9_-]+)/g;
	let sm: RegExpExecArray | null;
	const matchedSkillNames = new Set<string>();
	while ((sm = skillRegex.exec(text)) !== null) {
		matchedSkillNames.add(sm[1].toLowerCase());
	}

	for (const sk of availableSkills) {
		const bareName = sk.name.startsWith("skill:") ? sk.name.slice(6) : sk.name;
		if (matchedSkillNames.has(bareName.toLowerCase()) || matchedSkillNames.has(sk.name.toLowerCase())) {
			detectedSkills.push(sk);
		}
	}

	if (isRemoteWorkspaceUri(cwd)) {
		return { detectedAttachments, detectedSkills };
	}

	const pathRegex = /(?:^|\s)@([^\s@:"'<>|?*]+)/g;
	let pm: RegExpExecArray | null;
	const root = resolve(cwd);

	let pathText = text;
	for (const att of existingAttachments) {
		if (att.mode !== "canvas" || !att.name) continue;
		const escaped = att.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		pathText = pathText.replace(new RegExp(`(^|\\s)@${escaped}(?=$|\\s)`, "g"), "$1");
	}
	while ((pm = pathRegex.exec(pathText)) !== null) {
		const rawCandidate = pm[1].trim();
		if (!rawCandidate || rawCandidate.startsWith("skill:")) continue;

		const candidate = rawCandidate.replace(/^[/\\]+/, "");
		const absPath = isAbsolute(rawCandidate) ? rawCandidate : resolve(root, candidate);

		if (existsSync(absPath)) {
			try {
				const rel = relative(root, absPath).replace(/\\/g, "/");
				if (!existingPaths.has(rel) && !existingPaths.has(rawCandidate)) {
					existingPaths.add(rel);
					detectedAttachments.push({
						path: rel,
						name: basename(absPath),
						mode: "reference",
					});
				}
			} catch {}
		}
	}

	return { detectedAttachments, detectedSkills };
}

export function createAttachmentUiMessages(attachments: PromptAttachment[], timestamp = Date.now()): UiMessage[] {
	const out: UiMessage[] = [];

	for (const att of attachments) {
		const cardId = `u-att-${timestamp}-${randomUUID().slice(0, 6)}`;

		if (att.imageData) {
			const dataUrl = att.imageData.startsWith("data:")
				? att.imageData
				: `data:${att.mimeType || "image/png"};base64,${att.imageData}`;
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "image", dataUrl }],
				details: {
					name: att.name || "image.png",
					mode: "reference",
				},
			});
			continue;
		}

		if (att.mode === "quote" && att.quote) {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: att.quote.text }],
				details: {
					mode: "quote",
					quote: att.quote,
				},
			});
			continue;
		}

		if (att.mode === "page") {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: `<browser-page url="${att.path}" title="${att.name || att.path}" />` }],
				details: {
					name: att.name || att.path,
					path: att.path,
					mode: "page",
				},
			});
			continue;
		}

		if (att.uploadPath) {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: `<file path="${att.uploadPath}" />` }],
				details: {
					name: att.name || basename(att.uploadPath),
					path: att.uploadPath,
					mode: "reference",
					isDir: false,
				},
			});
			continue;
		}

		if (att.mode === "canvas") {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: formatUnavailableCanvasReference(att) }],
				details: { mode: "canvas", path: att.path, name: att.name || att.path, title: att.name || att.path },
			});
			continue;
		}
		if (att.path) {
			const isLines = att.mode === "lines" && att.lines;
			let isDir = false;
			try {
				if (existsSync(att.path)) {
					isDir = statSync(att.path).isDirectory();
				}
			} catch {}
			const text = isLines
				? `<file path="${att.path}" lines="${att.lines!.start}-${att.lines!.end}" />`
				: isDir
					? `<folder path="${att.path}" />`
					: `<file path="${att.path}" />`;

			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text }],
				details: {
					name: att.name || basename(att.path),
					path: att.path,
					mode: isLines ? "lines" : "reference",
					isDir,
					...(isLines ? { startLine: att.lines!.start, endLine: att.lines!.end } : {}),
				},
			});
		}
	}

	return out;
}

export function formatPromptWithSkills(rawPrompt: string, skills: readonly DiscoveredSkill[]): string {
	if (!skills || skills.length === 0) return rawPrompt;

	const skillSnippets: string[] = [];
	for (const sk of skills) {
		const body = readSkillInstruction(sk.filePath);
		if (body) {
			const title = sk.name.startsWith("skill:") ? sk.name.slice(6) : sk.name;
			skillSnippets.push(`[Skill: ${title}]\n${body}`);
		}
	}

	if (skillSnippets.length === 0) return rawPrompt;

	return `${skillSnippets.join("\n\n")}\n\n[User Prompt]\n${rawPrompt}`;
}
