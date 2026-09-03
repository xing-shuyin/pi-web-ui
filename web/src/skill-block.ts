/**
 * Skill-invocation block parsing — mirrors the pi SDK's `parseSkillBlock`
 * (dist/core/agent-session.js). When the user sends `/skill:name args`, the
 * SDK expands the prompt text into:
 *
 *     <skill name="..." location="...">
 *     ...full SKILL.md body...
 *     </skill>
 *
 *     <args>
 *
 * The CLI renders this as a compact collapsible [skill] card plus the user's
 * own args as a separate message; the web UI used to dump the whole block
 * into the user bubble. Keep the regex in sync with the SDK's.
 */

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
