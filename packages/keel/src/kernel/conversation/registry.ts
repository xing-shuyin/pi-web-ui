import type { ConversationId, SessionFile } from "../../contracts/ids.js";
import type { ConversationMeta } from "./types.js";

export class ConversationRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConversationRegistryError";
	}
}

/**
 * 对话身份的唯一持有者：id → 记录、会话文件 → id、当前活动对话。
 * 只做身份与索引，不认识 SDK、不发帧、不碰磁盘。
 */
export class ConversationRegistry<T extends { meta: ConversationMeta }> {
	private readonly byId = new Map<ConversationId, T>();
	private readonly sessionFileIndex = new Map<SessionFile, ConversationId>();
	private active = "";
	private seq = 0;

	add(conv: T): T {
		const id = conv.meta.id;
		if (!id) throw new ConversationRegistryError("conversation id is required");
		if (this.byId.has(id)) throw new ConversationRegistryError(`conversation ${id} already registered`);
		this.byId.set(id, conv);
		if (conv.meta.sessionFile) this.bindSessionFile(id, conv.meta.sessionFile);
		return conv;
	}

	get(id: ConversationId): T | undefined {
		return this.byId.get(id);
	}

	require(id: ConversationId): T {
		const conv = this.byId.get(id);
		if (!conv) throw new ConversationRegistryError(`conversation ${id} is not registered`);
		return conv;
	}

	has(id: ConversationId): boolean {
		return this.byId.has(id);
	}

	remove(id: ConversationId): T | undefined {
		const conv = this.byId.get(id);
		if (!conv) return undefined;
		this.byId.delete(id);
		if (conv.meta.sessionFile && this.sessionFileIndex.get(conv.meta.sessionFile) === id) {
			this.sessionFileIndex.delete(conv.meta.sessionFile);
		}
		if (this.active === id) this.active = "";
		return conv;
	}

	activate(id: ConversationId): T {
		const conv = this.require(id);
		this.active = id;
		return conv;
	}

	/** 显式停用当前活动对话（不指定继任者；由调用方按产品语义选择下一个）。 */
	clearActive(): void {
		this.active = "";
	}

	activeId(): ConversationId | "" {
		return this.active;
	}

	activeConv(): T | undefined {
		return this.active ? this.byId.get(this.active) : undefined;
	}

	/** 同一会话文件只允许一个活动对话；重绑会摘掉旧映射。 */
	bindSessionFile(id: ConversationId, file: SessionFile): void {
		const prev = this.sessionFileIndex.get(file);
		if (prev && prev !== id) {
			this.sessionFileIndex.delete(file);
			const previous = this.byId.get(prev);
			if (previous && previous.meta.sessionFile === file) delete previous.meta.sessionFile;
		}
		this.sessionFileIndex.set(file, id);
		const conv = this.byId.get(id);
		if (conv) conv.meta.sessionFile = file;
	}

	unbindSessionFile(id: ConversationId): void {
		const conv = this.byId.get(id);
		const file = conv?.meta.sessionFile;
		if (conv) delete conv.meta.sessionFile;
		if (file && this.sessionFileIndex.get(file) === id) this.sessionFileIndex.delete(file);
	}

	bySessionFile(file: SessionFile): T | undefined {
		const id = this.sessionFileIndex.get(file);
		return id ? this.byId.get(id) : undefined;
	}

	nextSeq(): number {
		return ++this.seq;
	}

	list(): readonly T[] {
		return [...this.byId.values()];
	}

	size(): number {
		return this.byId.size;
	}
}
