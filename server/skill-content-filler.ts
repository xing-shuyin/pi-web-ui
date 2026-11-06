import { readFileSync, statSync } from "node:fs";
import { decodeText } from "./text-sniff.js";
import {
	DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES,
	DEFAULT_SKILLS_MAX_FILE_BYTES,
	normalizeSkillList,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
} from "./client-state.js";

export interface SkillContentLimits {
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export function fillSkillContents(
	skills: { name: string; description: string; filePath: string }[],
	skillsFullTextConfig: string[] | undefined,
	limits: SkillContentLimits = {},
): { name: string; description: string; filePath: string; content?: string }[] {
	const wanted = new Set(normalizeSkillList(skillsFullTextConfig));
	if (wanted.size === 0) return skills;
	const maxFile =
		limits.maxFileBytes === undefined
			? DEFAULT_SKILLS_MAX_FILE_BYTES
			: normalizeSkillsMaxFileBytes(limits.maxFileBytes);
	const maxTotal =
		limits.maxTotalBytes === undefined
			? DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES
			: normalizeSkillsFullTextMaxBytes(limits.maxTotalBytes);
	let budget = maxTotal > 0 ? maxTotal : Number.POSITIVE_INFINITY;
	return skills.map((s) => {
		if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
		try {
			const st = statSync(s.filePath);
			if (!st.isFile() || st.size <= 0) return s;
			if (maxFile > 0 && st.size > maxFile) return s;
			const room = Math.min(st.size, budget);
			const slice = readFileSync(s.filePath).subarray(0, room);
			const text = decodeText(slice);
			const raw = (room < st.size ? text.replace(/\uFFFD+$/u, "") : text).trim();
			if (!raw) return s;
			budget -= Buffer.byteLength(raw, "utf8");
			return { ...s, content: raw };
		} catch {
			return s;
		}
	});
}
