import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserMode } from "../contracts.js";
import { readPageScripts, type PageScript } from "../runtime/scripts.js";
import { normalizeTotpEntries, sortTotpEntries, type TotpEntry } from "../runtime/totp.js";
import { isWebUrl } from "../runtime/urls.js";

export interface Bookmark {
	name: string;
	type: "folder" | "link";
	url?: string;
	children?: Bookmark[];
	bg?: string;
	char?: string;
}
export interface HistoryEntry {
	url: string;
	title: string;
	visitedAt: number;
}
export interface PasswordEntry {
	id: string;
	name: string;
	url: string;
	username: string;
	password: string;
	createdAt: string;
}
export interface BrowserSettings {
	searchEngine: string;
	theme: string;
	newTabOpenMode: string;
	smartDock: boolean;
	customScrollbar: boolean;
	officeEnabled: boolean;
	shortcuts: Record<string, string>;
	/** 启动时使用的界面模式（agent / browser / split）；运行期切换不写回这里 */
	defaultMode: BrowserMode;
	splitRatio: number;
	agentUrl: string;
	aiControl: boolean;
	allowShot: boolean;
	allowEval: boolean;
	/** Agent 页面脚本注入总开关（脚本本身不做能力/体积/条数限制） */
	allowScripts: boolean;
	sitePermissions: Record<string, boolean>;
}
export interface SavedTabs {
	urls: string[];
	activeIndex: number;
}
export interface CredentialEncryption {
	isEncryptionAvailable(): boolean;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
	getSelectedStorageBackend?(): string;
}
const DEFAULT_SETTINGS: BrowserSettings = {
	searchEngine: "bing",
	theme: "dark",
	newTabOpenMode: "current",
	smartDock: true,
	customScrollbar: true,
	officeEnabled: true,
	shortcuts: {},
	defaultMode: "agent",
	splitRatio: 0.5,
	agentUrl: "",
	aiControl: true,
	allowShot: true,
	allowEval: false,
	allowScripts: true,
	sitePermissions: {},
};
const emptyBookmarks = (): Bookmark => ({ name: "全部收藏", type: "folder", children: [] });
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

function bookmarks(value: unknown, depth = 0): Bookmark {
	if (!object(value) || typeof value.name !== "string" || depth > 30) throw new Error("Invalid bookmark tree");
	if (value.type === "folder") {
		if (!Array.isArray(value.children)) throw new Error("Invalid bookmark folder");
		return { name: value.name, type: "folder", children: value.children.map((item) => bookmarks(item, depth + 1)) };
	}
	if (value.type !== "link" || typeof value.url !== "string" || !isWebUrl(value.url))
		throw new Error("Invalid bookmark URL");
	return {
		name: value.name,
		type: "link",
		url: value.url,
		...(typeof value.bg === "string" ? { bg: value.bg } : {}),
		...(typeof value.char === "string" ? { char: value.char } : {}),
	};
}
function settings(value: unknown, base = DEFAULT_SETTINGS): BrowserSettings {
	if (!object(value)) throw new Error("Invalid browser settings");
	const next = { ...base, shortcuts: { ...base.shortcuts }, sitePermissions: { ...base.sitePermissions } };
	for (const key of ["searchEngine", "theme", "newTabOpenMode"] as const)
		if (typeof value[key] === "string") next[key] = value[key];
	for (const key of [
		"smartDock",
		"customScrollbar",
		"officeEnabled",
		"aiControl",
		"allowShot",
		"allowEval",
		"allowScripts",
	] as const)
		if (typeof value[key] === "boolean") next[key] = value[key];
	if (["browser", "agent", "split"].includes(String(value.defaultMode)))
		next.defaultMode = value.defaultMode as BrowserMode;
	// 旧版本把「上次使用的模式」存进 mode；迁移成启动默认模式，老用户升级后启动行为不变
	else if (["browser", "agent", "split"].includes(String(value.mode))) next.defaultMode = value.mode as BrowserMode;
	if (typeof value.splitRatio === "number" && Number.isFinite(value.splitRatio))
		next.splitRatio = Math.max(0.15, Math.min(0.85, value.splitRatio));
	if (typeof value.agentUrl === "string" && (!value.agentUrl || isWebUrl(value.agentUrl)))
		next.agentUrl = value.agentUrl;
	if (object(value.shortcuts))
		next.shortcuts = Object.fromEntries(
			Object.entries(value.shortcuts).filter(([, item]) => typeof item === "string"),
		) as Record<string, string>;
	if (object(value.sitePermissions))
		next.sitePermissions = Object.fromEntries(
			Object.entries(value.sitePermissions).filter(
				([key, item]) =>
					typeof item === "boolean" && key.length <= 2048 && !["__proto__", "constructor", "prototype"].includes(key),
			),
		) as Record<string, boolean>;
	return next;
}
function history(value: unknown): HistoryEntry[] {
	if (!Array.isArray(value)) throw new Error("Invalid browser history");
	return value
		.filter(object)
		.filter((item) => typeof item.url === "string" && isWebUrl(item.url))
		.map((item) => {
			const timestamp = item.visitedAt ?? item.timestamp ?? item.time;
			const visitedAt =
				typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
			return { url: item.url as string, title: typeof item.title === "string" ? item.title : "", visitedAt };
		})
		.filter((item) => Number.isFinite(item.visitedAt))
		.slice(0, 5000);
}

export class BrowserStorage {
	constructor(
		readonly dataDir: string,
		private readonly encryption: CredentialEncryption,
	) {
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	}
	private filename(name: string): string {
		return path.join(this.dataDir, `${name}.json`);
	}
	private read(name: string): unknown {
		try {
			return JSON.parse(fs.readFileSync(this.filename(name), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	private write(name: string, value: unknown): void {
		const temp = `${this.filename(name)}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			fs.renameSync(temp, this.filename(name));
		} finally {
			fs.rmSync(temp, { force: true });
		}
	}
	listBookmarks(): Bookmark {
		const value = this.read("bookmarks");
		return value === undefined ? emptyBookmarks() : bookmarks(value);
	}
	saveBookmarks(value: unknown): boolean {
		this.write("bookmarks", bookmarks(value));
		return true;
	}
	listScripts(): PageScript[] {
		const value = this.read("scripts");
		return value === undefined ? [] : readPageScripts(value);
	}
	saveScripts(value: unknown): PageScript[] {
		const scripts = readPageScripts(value);
		this.write("scripts", scripts);
		return scripts;
	}
	listHistory(): HistoryEntry[] {
		const value = this.read("history");
		return value === undefined ? [] : history(value);
	}
	addHistory(url: string, title: string): void {
		if (!isWebUrl(url)) return;
		const list = this.listHistory();
		if (list[0]?.url === url) list.shift();
		list.unshift({ url, title, visitedAt: Date.now() });
		this.write("history", list.slice(0, 5000));
	}
	getSettings(): BrowserSettings {
		return settings(this.read("settings") ?? {});
	}
	saveSettings(value: unknown): boolean {
		this.write("settings", settings(value, this.getSettings()));
		return true;
	}
	loadTabs(): SavedTabs | undefined {
		const value = this.read("tabs");
		if (!object(value) || !Array.isArray(value.urls)) return undefined;
		return {
			urls: value.urls.filter((url): url is string => typeof url === "string").slice(0, 100),
			activeIndex: Number.isInteger(value.activeIndex) ? (value.activeIndex as number) : 0,
		};
	}
	saveTabs(value: SavedTabs): void {
		this.write("tabs", value);
	}
	isEncryptionAvailable(): boolean {
		return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== "basic_text";
	}
	private requireEncryption(): void {
		if (!this.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
	}
	private decodePasswords(value: unknown): PasswordEntry[] {
		if (!Array.isArray(value)) throw new Error("Invalid password data");
		this.requireEncryption();
		return value.map((item) => {
			if (!object(item) || typeof item.password !== "string" || typeof item.url !== "string" || !isWebUrl(item.url))
				throw new Error("Invalid password entry");
			return {
				id: typeof item.id === "string" ? item.id : randomUUID(),
				name: typeof item.name === "string" ? item.name : "",
				url: item.url,
				username: typeof item.username === "string" ? item.username : "",
				createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
				password: item.password.startsWith("enc:")
					? this.encryption.decryptString(Buffer.from(item.password.slice(4), "base64"))
					: item.password,
			};
		});
	}
	listPasswords(): PasswordEntry[] {
		const value = this.read("passwords");
		if (value === undefined) return [];
		const decoded = this.decodePasswords(value);
		if ((value as PasswordEntry[]).some((item) => !item.password.startsWith("enc:"))) this.savePasswords(decoded);
		return decoded;
	}
	savePasswords(value: unknown): boolean {
		this.requireEncryption();
		if (!Array.isArray(value)) throw new Error("Invalid password data");
		const encoded = value.map((item) => {
			if (!object(item) || typeof item.password !== "string" || typeof item.url !== "string" || !isWebUrl(item.url))
				throw new Error("Invalid password entry");
			return {
				id: typeof item.id === "string" ? item.id : randomUUID(),
				name: typeof item.name === "string" ? item.name : "",
				url: item.url,
				username: typeof item.username === "string" ? item.username : "",
				createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
				password: `enc:${this.encryption.encryptString(item.password).toString("base64")}`,
			};
		});
		this.write("passwords", encoded);
		return true;
	}
	/** TOTP 保管库：与密码同一条加密口径（safeStorage，`enc:` 前缀），不可用则拒绝保存。 */
	private decodeTotp(value: unknown): TotpEntry[] {
		if (!Array.isArray(value)) throw new Error("Invalid TOTP data");
		this.requireEncryption();
		return normalizeTotpEntries(
			value.map((item) => {
				if (!object(item) || typeof item.secret !== "string") throw new Error("Invalid TOTP entry");
				return {
					...item,
					secret: item.secret.startsWith("enc:")
						? this.encryption.decryptString(Buffer.from(item.secret.slice(4), "base64"))
						: item.secret,
				};
			}),
		);
	}
	listTotp(): TotpEntry[] {
		const value = this.read("totp");
		if (value === undefined) return [];
		const decoded = this.decodeTotp(value);
		if (
			(value as { secret?: unknown }[]).some(
				(item) => typeof item?.secret === "string" && !item.secret.startsWith("enc:"),
			)
		)
			this.saveTotp(decoded);
		return decoded;
	}
	saveTotp(value: unknown): TotpEntry[] {
		this.requireEncryption();
		const entries = sortTotpEntries(normalizeTotpEntries(value));
		this.write(
			"totp",
			entries.map((entry) => ({
				...entry,
				secret: `enc:${this.encryption.encryptString(entry.secret).toString("base64")}`,
			})),
		);
		return entries;
	}
	importLegacyData(sourceDir: string): { imported: string[]; skipped: string[]; errors: string[] } {
		const result = { imported: [] as string[], skipped: [] as string[], errors: [] as string[] };
		for (const name of ["bookmarks", "settings", "history", "passwords"]) {
			const source = path.join(sourceDir, `${name}.json`);
			if (fs.existsSync(this.filename(name)) || !fs.existsSync(source)) {
				result.skipped.push(name);
				continue;
			}
			try {
				const value: unknown = JSON.parse(fs.readFileSync(source, "utf8"));
				if (name === "bookmarks") this.saveBookmarks(value);
				else if (name === "settings") this.saveSettings(value);
				else if (name === "history") this.write(name, history(value));
				else this.savePasswords(this.decodePasswords(value));
				result.imported.push(name);
			} catch {
				result.errors.push(name);
			}
		}
		return result;
	}
}
