import { randomUUID } from "node:crypto";

const identities = new WeakMap<object, string>();
const parents = new WeakMap<object, object | null>();
export function conversationIdentity(conversation: object): string {
	let id = identities.get(conversation);
	if (!id) {
		id = `exec-${randomUUID()}`;
		identities.set(conversation, id);
	}
	return id;
}
export function bindConversationParent(child: object, parent: object | undefined): void {
	if (parents.has(child)) throw new Error("Conversation parent identity is already bound");
	parents.set(child, parent ?? null);
}
export function hasConversationParentBinding(child: object): boolean {
	return parents.has(child);
}
export function conversationParent(child: object): object | undefined {
	return parents.get(child) ?? undefined;
}
export function parentConversationIdentity(child: object): string | undefined {
	const parent = conversationParent(child);
	return parent ? conversationIdentity(parent) : undefined;
}
