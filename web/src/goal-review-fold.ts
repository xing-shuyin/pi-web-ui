import type { UiMessage } from "./types";
import { asText } from "./components/Message";

const GOAL_REVIEW_MARK = "[goal-review]";

function firstText(m: UiMessage): string {
	for (const b of m.content ?? []) {
		const t = asText(b);
		if (t && t.text.trim()) return t.text;
	}
	return "";
}

function reviewVerdictOf(m: UiMessage): "pass" | "fail" | undefined {
	if (m.role !== "assistant") return undefined;
	const text = firstText(m).trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
	try {
		const v = JSON.parse(text) as { verdict?: unknown };
		if (v && typeof v === "object" && (v.verdict === "pass" || v.verdict === "fail")) return v.verdict;
	} catch {}
	const mm = text.match(/^\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}$/);
	return mm ? (mm[1] as "pass" | "fail") : undefined;
}

type ReviewFoldKind = { kind: "prompt" } | { kind: "verdict"; verdict: "pass" | "fail" };

export function reviewFoldKind(m: UiMessage): ReviewFoldKind | undefined {
	if (m.role === "user" && firstText(m).includes(GOAL_REVIEW_MARK)) return { kind: "prompt" };
	const v = reviewVerdictOf(m);
	if (v) return { kind: "verdict", verdict: v };
	return undefined;
}
