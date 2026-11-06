import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { normalizePathKey } from "../client-state.js";
import type { UniversalConversation } from "./universal-types.js";

export class UniversalSessionStore {
	private readonly baseDir: string;

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

	saveConversation(cwd: string, conv: UniversalConversation): void {
		const p = this.convPath(cwd, conv.id);
		writeJsonAtomicSync(p, { ...conv, engine: this.engine });
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
				if (!conv.engine) {
					const marker = `${this.convPath(cwd, conv.id)}.legacy-imported`;
					if (existsSync(marker)) continue;
					const imported = { ...conv, driverSessionId: undefined };
					if (!existsSync(this.convPath(cwd, conv.id))) this.saveConversation(cwd, imported);
					writeJsonAtomicSync(marker, { imported: true });
					continue;
				}
				if (!existsSync(this.convPath(cwd, conv.id))) this.saveConversation(cwd, conv);
				unlinkSync(path);
			} catch {}
		}
	}

	deleteConversation(cwd: string, convId: string): void {
		this.importLegacy(cwd);
		const p = this.convPath(cwd, convId);
		if (existsSync(p)) {
			try {
				unlinkSync(p);
			} catch {}
		}
	}

	renameConversation(cwd: string, convId: string, title: string): void {
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.title = title;
			conv.updatedAt = Date.now();
			this.saveConversation(cwd, conv);
		}
	}

	pinConversation(cwd: string, convId: string, pinned: boolean): void {
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.pinned = pinned;
			conv.updatedAt = Date.now();
			this.saveConversation(cwd, conv);
		}
	}
}
