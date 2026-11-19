import { randomUUID } from "node:crypto";

const identities = new WeakMap<object, string>();
const parents = new WeakMap<object, object | null>();
/** 反向索引：父对话 → 直接子对话。`bindConversationParent` 是唯一绑定入口，故这里是权威索引。 */
const childrenOf = new WeakMap<object, Set<object>>();
/**
 * `exec-<uuid>` 身份 → 当前持有它的会话。
 * 存在意义：父链解析原先要靠「遍历所有会话的所有对话」去找 exec 身份，热判定上是 O(S×C)；
 * 这张表把查找降到 O(1)（命中后仍校验持有关系，过户/迁移后自动回退到扫描）。
 * 值用 WeakRef 弱持有会话：会话销毁后不得被这张表钉在内存里（否则就是一个比原问题更大的泄漏）。
 */
const homes = new WeakMap<object, object>();
const homesById = new Map<string, WeakRef<object>>();
const HOMES_PRUNE_AT = 4096;

function pruneHomes(): void {
	for (const [id, ref] of homesById) {
		if (!ref.deref()) homesById.delete(id);
	}
}

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
	if (!parent) return;
	const siblings = childrenOf.get(parent);
	if (siblings) siblings.add(child);
	else childrenOf.set(parent, new Set([child]));
}
export function hasConversationParentBinding(child: object): boolean {
	return parents.has(child);
}
export function conversationParent(child: object): object | undefined {
	return parents.get(child) ?? undefined;
}
/** 直接子对话（绑定过父的）。返回的是活集合，调用方只读。 */
export function conversationChildren(parent: object): readonly object[] {
	const set = childrenOf.get(parent);
	return set ? [...set] : [];
}
export function hasConversationChildren(parent: object): boolean {
	const set = childrenOf.get(parent);
	return !!set && set.size > 0;
}
/** 重新登记子对话（过户重组后用：同一对父子保留索引，不重复建绑）。 */
export function indexConversationChild(child: object): void {
	const parent = parents.get(child);
	if (!parent) return;
	const set = childrenOf.get(parent);
	if (set) set.add(child);
	else childrenOf.set(parent, new Set([child]));
}
/** 对话真被移除时从父的反向索引里摸掉，否则索引会把已 dispose 的 runtime 吊在内存里。 */
export function unindexConversationChild(child: object): void {
	const parent = parents.get(child);
	if (!parent) return;
	const set = childrenOf.get(parent);
	if (!set) return;
	set.delete(child);
	if (set.size === 0) childrenOf.delete(parent);
}
export function parentConversationIdentity(child: object): string | undefined {
	const parent = conversationParent(child);
	return parent ? conversationIdentity(parent) : undefined;
}

/** 登记「这份对话当前由哪个会话持有」（会话 = ClientSession，只做弱引用，不解构它）。 */
export function registerConversationHome<T extends object>(conversation: object, home: T): void {
	homes.set(conversation, home);
	homesById.set(conversationIdentity(conversation), new WeakRef(home));
	if (homesById.size > HOMES_PRUNE_AT) pruneHomes();
}

export function forgetConversationHome(conversation: object): void {
	const id = identities.get(conversation);
	if (id) homesById.delete(id);
	homes.delete(conversation);
}

/** 由 `exec-<uuid>` 身份取当前持有会话；调用方仍需校验持有关系。 */
export function conversationHomeByIdentity(id: string): object | undefined {
	const ref = homesById.get(id);
	if (!ref) return undefined;
	const home = ref.deref();
	if (!home) homesById.delete(id);
	return home;
}

export function conversationHomeOf(conversation: object): object | undefined {
	return homes.get(conversation);
}
