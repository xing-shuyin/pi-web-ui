import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

export class BiliFavOps {
	constructor(stateDir) {
		this.stateDir = stateDir;
	}

	loadCred() {
		let f = join(this.stateDir, "bili_credential.json");
		if (!existsSync(f) && existsSync(join(this.stateDir, "credentials.json"))) {
			f = join(this.stateDir, "credentials.json");
		}
		if (!existsSync(f)) return null;
		try {
			const c = JSON.parse(readFileSync(f, "utf8"));
			return c?.sessdata ? c : null;
		} catch {
			return null;
		}
	}

	headers(cred) {
		return {
			"User-Agent": UA,
			Referer: "https://www.bilibili.com/",
			Origin: "https://www.bilibili.com",
			Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 || ""}`,
		};
	}

	async getFolders() {
		const cred = this.loadCred();
		if (!cred) return { ok: false, error: "未登录，缺少登录凭证" };
		const uid = Number(cred.dedeuserid) || 0;
		if (!uid) return { ok: false, error: "凭证中未包含有效的 DedeUserID" };

		try {
			const url = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${uid}`;
			const res = await fetch(url, { headers: this.headers(cred) });
			const json = await res.json();
			if (json.code !== 0) {
				return { ok: false, error: json.message || `获取收藏夹失败 (code ${json.code})` };
			}
			const list = json.data?.list || [];
			return {
				ok: true,
				folders: list.map((it) => ({
					id: it.id,
					title: it.title,
					count: it.media_count || 0,
				})),
			};
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async getAid(bvid) {
		const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
		const res = await fetch(url, {
			headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
		});
		const json = await res.json();
		if (json.code === 0 && json.data?.aid) return Number(json.data.aid);
		return 0;
	}

	async addVideo(bvid, fid) {
		const cred = this.loadCred();
		if (!cred) return { ok: false, error: "未登录，缺少登录凭证" };
		if (!cred.bili_jct) return { ok: false, error: "凭证缺少 bili_jct (CSRF Token)" };

		const aid = await this.getAid(bvid);
		if (!aid) return { ok: false, error: `无法获取视频 ${bvid} 的 aid` };

		try {
			const body = new URLSearchParams();
			body.append("rid", String(aid));
			body.append("type", "2");
			body.append("add_media_ids", String(fid));
			body.append("csrf", cred.bili_jct);

			const res = await fetch("https://api.bilibili.com/x/v3/fav/resource/deal", {
				method: "POST",
				headers: {
					...this.headers(cred),
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			});
			const json = await res.json();
			if (json.code === 0) {
				return { ok: true, already: false };
			}
			const msg = json.message || "";
			if (msg.includes("已经") || msg.toLowerCase().includes("already") || json.code === 11201) {
				return { ok: true, already: true };
			}
			return { ok: false, error: msg || `收藏失败 (code ${json.code})` };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}
