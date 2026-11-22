import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomic, writeJsonAtomicSync } from "../atomic-file.js";
import { normalizePathKey } from "../client-state.js";
import type { UniversalConversation } from "./universal-types.js";

export class UniversalSessionStore {
	private readonly baseDir: string;
	/**
	 * 同一文件的写入串成一条链：排队顺序就是落盘顺序。
	 * 异步落盘不会自发保序，而「后写的旧快照盖掉先写的新快照」等于丢消息；
	 * 排队顺序只能由一处持有，不能交给各调用点各自 `void writeJsonAtomic()`。
	 */
	private readonly writeChains = new Map<string, Promise<void>>();

	constructor(
		dataDir: string,
		private readonly engine = "claude",
	) {
		if (!/^[a-zA-Z0-9_-]+$/.test(engine)) throw new Error("Invalid engine namespace");
		this.baseDir = join(dataDir, "universal-sessions", engine);
		try {
			mkdirSync(this.baseDir, { recursive: true });
		} catch {}
	}

	private cwdDir(cwd: string): string {
		const normKey = normalizePathKey(cwd);
		const hash = createHash("sha256").update(normKey).digest("hex").slice(0, 16);
		const dir = join(this.baseDir, hash);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	private convPath(cwd: string, convId: string): string {
		const safeId = convId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.cwdDir(cwd), `${safeId}.json`);
	}

	listConversations(cwd: string): UniversalConversation[] {
		this.importLegacy(cwd);
		const dir = this.cwdDir(cwd);
		if (!existsSync(dir)) return [];
		const list: UniversalConversation[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const full = join(dir, file);
				const data = JSON.parse(readFileSync(full, "utf-8")) as UniversalConversation;
				if (data && data.engine === this.engine && data.id && Array.isArray(data.messages)) {
					list.push(data);
				}
			} catch {}
		}
		return list.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	loadConversation(cwd: string, convId: string): UniversalConversation | null {
		this.importLegacy(cwd);
		const p = this.convPath(cwd, convId);
		if (!existsSync(p)) return null;
		try {
			const data = JSON.parse(readFileSync(p, "utf-8")) as UniversalConversation;
			return data.engine === this.engine && data.id === convId && Array.isArray(data.messages) ? data : null;
		} catch {
			return null;
		}
	}

	/**
	 * 保存一条会话（真值）：返回的 promise 在文件真正落盘后 resolve，失败会 reject。
	 * 调用方必须 `await`，或在无法 await 的同步回调里用 `queueWrite`。
	 */
	saveConversation(cwd: string, conv: UniversalConversation): Promise<void> {
		return this.enqueueWrite(this.convPath(cwd, conv.id), { ...conv, engine: this.engine });
	}

	/**
	 * 无法 await 的落盘点（同步 sink 回调 / 构造器）：排队写入，失败只记录不抛。
	 * 顺序仍由同一文件的写链保证。
	 */
	queueWrite(cwd: string, conv: UniversalConversation): void {
		void this.saveConversation(cwd, conv).catch((error) => {
			console.error("[universal] 会话落盘失败：", error);
		});
	}

	private enqueueWrite(file: string, data: unknown): Promise<void> {
		const previous = this.writeChains.get(file) ?? Promise.resolve();
		// 前一笔失败不阻断后一笔：一次 EPERM 不能让这份会话从此再也写不进去。
		const next = previous.catch(() => {}).then(() => writeJsonAtomic(file, data));
		const tail = next.catch(() => {});
		this.writeChains.set(file, tail);
		void tail.then(() => {
			if (this.writeChains.get(file) === tail) this.writeChains.delete(file);
		});
		return next;
	}

	/** 等这个文件上还没落盘的写入（删除前必用：旧快照不许把删掉的会话写回来）。 */
	private async flushWrites(file: string): Promise<void> {
		for (let tail = this.writeChains.get(file); tail; tail = this.writeChains.get(file)) await tail;
	}

	/** 等所有排队写入落盘（关停 / 需要「已持久化」这个事实的测试用）。 */
	async flush(): Promise<void> {
		for (let tails = [...this.writeChains.values()]; tails.length > 0; tails = [...this.writeChains.values()])
			await Promise.all(tails);
	}

	private importLegacy(cwd: string): void {
		const hash = createHash("sha256").update(normalizePathKey(cwd)).digest("hex").slice(0, 16);
		const legacyDir = join(this.baseDir, "..", hash);
		if (!existsSync(legacyDir)) return;
		for (const file of readdirSync(legacyDir)) {
			if (!file.endsWith(".json")) continue;
			const path = join(legacyDir, file);
			try {
				const conv = JSON.parse(readFileSync(path, "utf-8")) as UniversalConversation;
				if ((conv.engine && conv.engine !== this.engine) || !conv.id || !Array.isArray(conv.messages)) continue;
				const dest = this.convPath(cwd, conv.id);
				if (!conv.engine) {
					const marker = `${dest}.legacy-imported`;
					if (existsSync(marker)) continue;
					const imported = { ...conv, driverSessionId: undefined };
					if (!existsSync(dest)) this.saveConversationSync(cwd, imported);
					if (existsSync(dest)) writeJsonAtomicSync(marker, { imported: true });
					continue;
				}
				if (!existsSync(dest)) this.saveConversationSync(cwd, conv);
				// 写成功（失败会抛到外层 catch，源文件保留）才删源：源文件是真值，删早了就没了。
				unlinkSync(path);
			} catch {}
		}
	}

	/**
	 * 遗留会话迁移**不能**异步：迁移是在同步读（包括构造器水合）里完成的，
	 * 「迁移完这一行就丢给队列」会让本次读返回空列表——用户升级后看到会话消失。
	 * 所以这里保留本文件唯一的同步原子写（一次性的老数据搬迁，不是请求热路径）。
	 */
	private saveConversationSync(cwd: string, conv: UniversalConversation): void {
		writeJsonAtomicSync(this.convPath(cwd, conv.id), { ...conv, engine: this.engine });
	}

	async deleteConversation(cwd: string, convId: string): Promise<void> {
		this.importLegacy(cwd);
		const p = this.convPath(cwd, convId);
		await this.flushWrites(p);
		if (existsSync(p)) {
			try {
				unlinkSync(p);
			} catch {}
		}
	}

	async renameConversation(cwd: string, convId: string, title: string): Promise<void> {
		// 先等排队写入落盘，否则「读旧快照 + 改标题」会把带消息的新版本盖回去。
		await this.flushWrites(this.convPath(cwd, convId));
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.title = title;
			conv.updatedAt = Date.now();
			await this.saveConversation(cwd, conv);
		}
	}

	async pinConversation(cwd: string, convId: string, pinned: boolean): Promise<void> {
		await this.flushWrites(this.convPath(cwd, convId));
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.pinned = pinned;
			conv.updatedAt = Date.now();
			await this.saveConversation(cwd, conv);
		}
	}
}
