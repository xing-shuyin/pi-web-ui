import type { ReactNode } from "react";
import type { UiApprovalHit } from "./types";
import { DEFAULT_APPROVAL_RULES } from "../../server/approval-default-rules.js";

export interface DangerousSegment {
	start: number;
	end: number;
	label?: string;
}

const FALLBACK_RULES = DEFAULT_APPROVAL_RULES.filter(
	(r) =>
		r.enabled && r.field === "command" && r.match === "regex" && r.tools.some((t) => t.trim().toLowerCase() === "bash"),
);

function mergeSegments(segments: DangerousSegment[]): DangerousSegment[] {
	if (segments.length <= 1) return segments;
	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const merged: DangerousSegment[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const cur = sorted[i];
		const last = merged[merged.length - 1];
		if (cur.start <= last.end) {
			last.end = Math.max(last.end, cur.end);
			if (cur.label && (!last.label || !last.label.includes(cur.label))) {
				last.label = last.label ? `${last.label} / ${cur.label}` : cur.label;
			}
		} else {
			merged.push(cur);
		}
	}
	return merged;
}

export function findDangerousBashSegments(command: string, hits?: UiApprovalHit[]): DangerousSegment[] {
	if (!command || typeof command !== "string") return [];

	if (hits && hits.length > 0) {
		const segments: DangerousSegment[] = [];
		for (const h of hits) {
			if (h.field === "command" && h.length > 0) {
				const start = Math.max(0, h.index);
				const end = Math.min(command.length, start + h.length);
				if (end > start) {
					segments.push({ start, end, label: h.label });
				}
			}
		}
		if (segments.length > 0) {
			return mergeSegments(segments);
		}
	}

	const found: DangerousSegment[] = [];
	for (const rule of FALLBACK_RULES) {
		let re: RegExp;
		try {
			re = new RegExp(rule.value, "gi");
		} catch {
			continue;
		}
		for (const m of command.matchAll(re)) {
			const start = m.index ?? 0;
			if (m[0].length > 0) found.push({ start, end: start + m[0].length, label: rule.label });
		}
	}
	return mergeSegments(found);
}

export function renderHighlightedCommand(command: string, hits?: UiApprovalHit[]): ReactNode {
	const segments = findDangerousBashSegments(command, hits);
	if (segments.length === 0) return command;

	const parts: ReactNode[] = [];
	let lastIndex = 0;
	segments.forEach((seg, i) => {
		if (seg.start > lastIndex) {
			parts.push(command.slice(lastIndex, seg.start));
		}
		const highlightedText = command.slice(seg.start, seg.end);
		parts.push(
			<mark key={i} className="bash-danger-hit" title={seg.label ?? "高危命令片段"}>
				{highlightedText}
			</mark>,
		);
		lastIndex = seg.end;
	});
	if (lastIndex < command.length) {
		parts.push(command.slice(lastIndex));
	}
	return <>{parts}</>;
}
