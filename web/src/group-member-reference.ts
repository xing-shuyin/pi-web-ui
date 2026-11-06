import { groupDeviceToken, type GroupDevice } from "./device-group-messages";

export type GroupMemberReference = { start: number; end: number; member: GroupDevice; conversationId?: string };

export function groupReferenceDestination(refs: GroupMemberReference[]): string | undefined {
	const continued = refs.filter((ref) => ref.conversationId);
	if (!continued.length) return undefined;
	const destination = continued[0].conversationId;
	if (refs.some((ref) => ref.conversationId !== destination))
		throw new Error(
			"同一条消息只能继续一个对话，请移除其他 @ 目标。 / Continue one conversation per message. Remove other @ targets.",
		);
	return destination;
}

export function updateGroupMemberReferences(
	before: string,
	after: string,
	refs: GroupMemberReference[],
): GroupMemberReference[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let oldEnd = before.length;
	let newEnd = after.length;
	while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	return refs.flatMap((ref) => {
		if (ref.end <= start) return [ref];
		if (ref.start >= oldEnd) {
			const shift = newEnd - oldEnd;
			return [{ ...ref, start: ref.start + shift, end: ref.end + shift }];
		}
		return [];
	});
}

export function serializeGroupMemberReferences(
	text: string,
	refs: GroupMemberReference[],
): { text: string; targets: string[] } {
	let result = text;
	for (const ref of [...refs].sort((a, b) => b.start - a.start))
		result = result.slice(0, ref.start) + groupDeviceToken(ref.member) + result.slice(ref.end);
	return { text: result, targets: [...new Set(refs.map((ref) => ref.member.id))] };
}

export function groupMemberDeletion(
	text: string,
	start: number,
	end: number,
	key: string,
	refs: GroupMemberReference[],
): { start: number; end: number } | null {
	const hits = refs.filter((ref) =>
		start === end
			? key === "Backspace"
				? start > ref.start && start <= ref.end + (text[ref.end] === " " ? 1 : 0)
				: start >= ref.start && start < ref.end
			: start < ref.end && end > ref.start,
	);
	if (!hits.length) return null;
	return { start: Math.min(start, ...hits.map((ref) => ref.start)), end: Math.max(end, ...hits.map((ref) => ref.end)) };
}

type Sink = (member: GroupDevice) => void;
const pending = new Map<string, GroupDevice[]>();
const sinks = new Map<string, Sink>();

export function referenceGroupMember(roomId: string, member: GroupDevice): void {
	const sink = sinks.get(roomId);
	if (sink) sink(member);
	else {
		const queue = pending.get(roomId) ?? [];
		if (!queue.some((item) => item.id === member.id)) queue.push(member);
		pending.set(roomId, queue);
	}
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: { roomId } }));
}

export function registerGroupMemberSink(roomId: string, sink: Sink): () => void {
	sinks.set(roomId, sink);
	const queue = pending.get(roomId) ?? [];
	pending.delete(roomId);
	for (const member of queue) sink(member);
	return () => {
		if (sinks.get(roomId) === sink) sinks.delete(roomId);
	};
}

export function insertGroupMember(text: string, cursor: number, member: GroupDevice): { text: string; cursor: number } {
	const token = `@${member.name}`;
	const prefix = text.slice(0, cursor);
	const insertion = `${prefix && !/\s$/.test(prefix) ? " " : ""}${token} `;
	return { text: prefix + insertion + text.slice(cursor), cursor: cursor + insertion.length };
}
