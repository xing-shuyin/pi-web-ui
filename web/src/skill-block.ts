export interface SkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage?: string;
}

const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function parseSkillBlock(text: string): SkillBlock | null {
	const m = text.match(SKILL_BLOCK_RE);
	if (!m) return null;
	return {
		name: m[1],
		location: m[2],
		content: m[3],
		userMessage: m[4]?.trim() || undefined,
	};
}
