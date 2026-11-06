import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { PromptAttachment, UiMessage } from "../protocol.js";
import { readSkillInstruction, type DiscoveredSkill } from "../skill-discovery.js";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";

export function formatUnavailableCanvasReference(att: PromptAttachment): string {
	const escape = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<canvas-ref id="${escape(att.path)}" title="${escape(att.name || att.path)}">Canvas tooling is unavailable in this engine. This is a graph identifier, not a file path; do not read it as a file or start a run.</canvas-ref>`;
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
