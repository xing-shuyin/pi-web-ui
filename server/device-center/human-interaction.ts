import { randomUUID } from "node:crypto";
import { approvalOperationSummary } from "./approval-summary.js";
import type {
	ClientMessage,
	ServerMessage,
	UiState,
	DeviceTaskInteractionBinding,
	DeviceTaskInteraction,
	DeviceTaskInteractionAnswer,
} from "../protocol.js";
export type InteractionBinding = DeviceTaskInteractionBinding;
export type TaskInteraction = DeviceTaskInteraction;
export type TaskInteractionAnswer = DeviceTaskInteractionAnswer;
export const INTERACTION_LIMITS = { count: 8, bytes: 24576, answerBytes: 16384 };
const size = (value: unknown) => {
	try {
		return Buffer.byteLength(JSON.stringify(value));
	} catch {
		return Infinity;
	}
};
function validQuestions(value: unknown): boolean {
	if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
	const ids = new Set<string>();
	const validOptions = (v: unknown) =>
		Array.isArray(v) &&
		v.length <= 32 &&
		v.every(
			(o) =>
				record(o) &&
				typeof o.label === "string" &&
				o.label.length <= 1000 &&
				[o.description, o.preview].every((s) => s === undefined || typeof s === "string") &&
				(o.recommended === undefined || typeof o.recommended === "boolean"),
		);
	return value.every((q) => {
		if (
			!record(q) ||
			typeof q.id !== "string" ||
			!q.id ||
			ids.has(q.id) ||
			typeof q.question !== "string" ||
			[q.detail, q.header].some((s) => s !== undefined && typeof s !== "string") ||
			(q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") ||
			(q.options !== undefined && !validOptions(q.options))
		)
			return false;
		if (
			q.dependsOn &&
			(!record(q.dependsOn) ||
				!ids.has(q.dependsOn.questionId) ||
				(q.dependsOn.value !== undefined &&
					typeof q.dependsOn.value !== "string" &&
					!(Array.isArray(q.dependsOn.value) && q.dependsOn.value.every((s: unknown) => typeof s === "string"))))
		)
			return false;
		if (
			q.optionsMap &&
			(!record(q.optionsMap) ||
				Object.keys(q.optionsMap).length > 32 ||
				!Object.values(q.optionsMap).every(validOptions))
		)
			return false;
		ids.add(q.id);
		return true;
	});
}
const record = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === "object" && !Array.isArray(value);
export function validInteractionAnswer(value: unknown): value is TaskInteractionAnswer {
	if (
		!record(value) ||
		size(value) > INTERACTION_LIMITS.answerBytes ||
		Object.keys(value).some(
			(k) => !["taskId", "attemptId", "interactionId", "answers", "cancelled", "decision"].includes(k),
		)
	)
		return false;
	if ([value.taskId, value.attemptId, value.interactionId].some((v) => typeof v !== "string" || !v || v.length > 128))
		return false;
	if (value.decision !== undefined)
		return ["approve", "deny"].includes(value.decision) && value.answers === undefined && value.cancelled === undefined;
	return (
		(value.cancelled === undefined || typeof value.cancelled === "boolean") &&
		Array.isArray(value.answers) &&
		value.answers.length <= 3 &&
		value.answers.every(
			(a: unknown) =>
				record(a) &&
				Object.keys(a).every((k) => ["id", "selected", "custom"].includes(k)) &&
				typeof a.id === "string" &&
				Array.isArray(a.selected) &&
				a.selected.length <= 32 &&
				a.selected.every((s: unknown) => typeof s === "string") &&
				(a.custom === undefined || typeof a.custom === "string"),
		)
	);
}
export function validInteractionProjection(value: unknown, binding: InteractionBinding): value is TaskInteraction[] {
	return (
		Array.isArray(value) &&
		value.length <= INTERACTION_LIMITS.count &&
		size(value) <= INTERACTION_LIMITS.bytes &&
		new Set(value.map((v) => (record(v) ? v.id : undefined))).size === value.length &&
		value.every(
			(v) =>
				record(v) &&
				Object.entries(binding).every(([k, x]) => v[k] === x) &&
				typeof v.id === "string" &&
				v.id.length <= 128 &&
				Number.isFinite(v.createdAt) &&
				(v.deadline === undefined || Number.isFinite(v.deadline)) &&
				Object.keys(v).every((k) =>
					[
						"taskId",
						"attemptId",
						"roomId",
						"botId",
						"deviceId",
						"id",
						"kind",
						"createdAt",
						"deadline",
						"questions",
						"toolName",
						"paramsPreview",
						"reason",
					].includes(k),
				) &&
				(v.kind === "question"
					? validQuestions(v.questions)
					: v.kind === "approval" && typeof v.toolName === "string" && typeof v.paramsPreview === "string"),
		)
	);
}
/** Holds native IDs locally. Neither Hub nor browser can supply a native WS frame. */
export function createHumanInteractionBridge(
	binding: InteractionBinding,
	options: {
		conversationId: string;
		isCurrent: () => boolean;
		send: (message: ClientMessage) => void;
		publish: (items: TaskInteraction[]) => void;
	},
) {
	const pending = new Map<string, { nativeId: string; item: TaskInteraction }>();
	const consumed = new Set<string>();
	let closed = false;
	const publish = () => options.publish(structuredClone([...pending.values()].map((v) => v.item)));
	const remove = (nativeId: string) => {
		for (const [id, v] of pending) if (v.nativeId === nativeId) pending.delete(id);
	};
	function observe(message: ServerMessage) {
		if (closed || !options.isCurrent()) return;
		if (message.type === "question_retracted" || message.type === "tool_approval_resolved") {
			if (message.owner || message.global) return;
			remove(message.id);
			publish();
			return;
		}
		if (message.type !== "question_pending" && message.type !== "tool_approval_pending") return;
		// Missing conversation/foreign owner/global asks must stay local.
		if (message.conversationId !== options.conversationId || message.global || message.owner) return;
		const kind = message.type === "question_pending" ? "question" : "approval";
		if (consumed.has(`${kind}:${message.id}`)) return;
		// Stop projection after the per-execution consumption budget instead of forgetting tombstones.
		if (consumed.size >= 256) return;
		if ([...pending.values()].some((v) => v.nativeId === message.id && v.item.kind === kind)) return;
		const item: TaskInteraction = {
			...binding,
			id: randomUUID(),
			kind,
			createdAt: Date.now(),
			...(message.type === "question_pending"
				? { questions: structuredClone(message.questions), ...(message.deadline ? { deadline: message.deadline } : {}) }
				: {
						toolName: message.toolName,
						paramsPreview: approvalOperationSummary(message.toolName, message.params),
						reason: "",
					}),
		};
		const next = [...pending.values()].map((v) => v.item).concat(item);
		if (!validInteractionProjection(next, binding)) return;
		pending.set(item.id, { nativeId: message.id, item });
		publish();
	}
	return {
		observe,
		snapshot(state: UiState) {
			if (closed || state.conversationId !== options.conversationId || !options.isCurrent()) return;
			const entries = [state.pendingQuestion, ...(state.pendingApprovals ?? []), state.pendingApproval].filter(Boolean);
			const ids = new Set(entries.map((v) => v!.id));
			for (const [id, v] of pending) if (!ids.has(v.nativeId)) pending.delete(id);
			if (state.pendingQuestion) observe({ type: "question_pending", ...state.pendingQuestion });
			for (const v of [...(state.pendingApprovals ?? []), state.pendingApproval])
				if (v) observe({ type: "tool_approval_pending", ...v });
			publish();
		},
		answer(value: unknown): boolean {
			if (
				closed ||
				!options.isCurrent() ||
				!validInteractionAnswer(value) ||
				value.taskId !== binding.taskId ||
				value.attemptId !== binding.attemptId
			)
				return false;
			const v = pending.get(value.interactionId);
			if (!v || (v.item.deadline !== undefined && v.item.deadline <= Date.now())) return false;
			if (v.item.kind === "question" && !value.cancelled) {
				const answers = value.answers ?? [];
				const visible = v.item.questions!.filter(
					(q) =>
						!q.dependsOn ||
						answers.some(
							(a) =>
								a.id === q.dependsOn!.questionId &&
								(a.selected.length || a.custom?.trim()) &&
								(q.dependsOn!.value === undefined ||
									[q.dependsOn!.value].flat().some((label) => a.selected.includes(label))),
						),
				);
				if (
					answers.length !== visible.length ||
					visible.some((q) => {
						const a = answers.find((a) => a.id === q.id);
						if (!a || (!a.selected.length && !a.custom?.trim()) || (!q.multiSelect && a.selected.length > 1))
							return true;
						const source =
							q.dependsOn && q.optionsMap
								? (q.optionsMap[answers.find((a) => a.id === q.dependsOn!.questionId)?.selected[0] ?? ""] ?? q.options)
								: q.options;
						return a.selected.some((label) => !source?.some((o) => o.label === label));
					})
				)
					return false;
			}
			let frame: ClientMessage;
			if (v.item.kind === "approval") {
				if (!value.decision) return false;
				frame = { type: "tool_approval_response", id: v.nativeId, decision: value.decision, scope: "once" };
			} else {
				if (
					value.decision ||
					!value.answers ||
					new Set(value.answers.map((a) => a.id)).size !== value.answers.length ||
					value.answers.some((a) => !v.item.questions?.some((q) => q.id === a.id))
				)
					return false;
				frame = {
					type: "question_answer",
					id: v.nativeId,
					answers: structuredClone(value.answers),
					...(value.cancelled ? { cancelled: true } : {}),
				};
			}
			consumed.add(`${v.item.kind}:${v.nativeId}`);
			pending.delete(value.interactionId); // Consume before calling send: duplicate/reentrant answers fail closed.
			options.send(frame);
			publish();
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			pending.clear();
			publish();
		},
	};
}
