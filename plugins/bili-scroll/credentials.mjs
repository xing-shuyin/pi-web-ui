import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class BiliCredentialManager {
	constructor(storageDir) {
		this.dir = storageDir;
		this.filePath = join(storageDir, "bili_credential.json");
		this.legacyFilePath = join(storageDir, "credentials.json");
		this.cachedUser = null;
		this.lastVerified = 0;
	}

	hasCredential() {
		return Boolean(this.load()?.sessdata);
	}

	load() {
		let targetPath = this.filePath;
		if (!existsSync(targetPath) && existsSync(this.legacyFilePath)) {
			targetPath = this.legacyFilePath;
		}
		if (!existsSync(targetPath)) return null;
		try {
			const raw = readFileSync(targetPath, "utf8");
			const json = JSON.parse(raw);
			if (typeof json === "object" && json !== null) {
				return {
					sessdata: String(json.sessdata || ""),
					bili_jct: String(json.bili_jct || ""),
					buvid3: String(json.buvid3 || ""),
					dedeuserid: String(json.dedeuserid || ""),
					refresh_token: String(json.refresh_token || ""),
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	save(cred) {
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
		const data = {
			sessdata: String(cred.sessdata || "").trim(),
			bili_jct: String(cred.bili_jct || "").trim(),
			buvid3: String(cred.buvid3 || "").trim(),
			dedeuserid: String(cred.dedeuserid || "").trim(),
			refresh_token: String(cred.refresh_token || "").trim(),
			updatedAt: new Date().toISOString(),
		};
		for (const p of [this.filePath, this.legacyFilePath]) {
			try {
				const tmp = `${p}.tmp.${Date.now()}`;
				writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
				renameSync(tmp, p);
			} catch {}
		}
		this.cachedUser = null;
		this.lastVerified = 0;
		return true;
	}

	clear() {
		for (const p of [this.filePath, this.legacyFilePath]) {
			try {
				if (existsSync(p)) unlinkSync(p);
			} catch {}
		}
		this.cachedUser = null;
		this.lastVerified = 0;
	}

	getCookieString() {
		const cred = this.load();
		if (!cred || !cred.sessdata) {
			return cred?.buvid3 ? `buvid3=${cred.buvid3}` : "";
		}
		const parts = [`SESSDATA=${cred.sessdata}`, `bili_jct=${cred.bili_jct}`];
		if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`);
		if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`);
		return parts.join("; ");
	}

	getHeaders(extra = {}) {
		const cookie = this.getCookieString();
		const headers = {
			"User-Agent": DEFAULT_UA,
			Referer: "https://www.bilibili.com",
			...extra,
		};
		if (cookie) {
			headers["Cookie"] = cookie;
		}
		return headers;
	}

	async verify(force = false) {
		const now = Date.now();
		if (!force && this.cachedUser && now - this.lastVerified < 60000) {
			return this.cachedUser;
		}

		const cred = this.load();
		if (!cred || !cred.sessdata) {
			this.cachedUser = { loggedIn: false };
			this.lastVerified = now;
			return this.cachedUser;
		}

		try {
			const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
				headers: this.getHeaders(),
			});
			const json = await res.json();
			if (json.code === 0 && json.data?.isLogin) {
				const d = json.data;
				this.cachedUser = {
					loggedIn: true,
					mid: d.mid,
					uname: d.uname,
					face: d.face,
					level: d.level_info?.current_level,
					money: d.money,
					vipStatus: d.vipStatus,
					vipType: d.vipType,
				};
				this.lastVerified = now;
				return this.cachedUser;
			}
			this.cachedUser = {
				loggedIn: false,
				code: json.code,
				message: json.message || "登录凭证失效",
			};
			this.lastVerified = now;
			return this.cachedUser;
		} catch (err) {
			return {
				loggedIn: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}
