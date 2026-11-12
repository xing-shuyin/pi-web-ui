import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

function loadCred(stateDir) {
	let f = join(stateDir, "bili_credential.json");
	if (!existsSync(f) && existsSync(join(stateDir, "credentials.json"))) {
		f = join(stateDir, "credentials.json");
	}
	if (!existsSync(f)) return null;
	try {
		const c = JSON.parse(readFileSync(f, "utf8"));
		return c?.sessdata ? c : null;
	} catch {
		return null;
	}
}

function readCache(stateDir) {
	try {
		return JSON.parse(readFileSync(join(stateDir, "uid-cache.json"), "utf8")) || {};
	} catch {
		return {};
	}
}

function writeCache(stateDir, obj) {
	try {
		writeFileSync(join(stateDir, "uid-cache.json"), JSON.stringify(obj, null, 2), "utf8");
	} catch {}
}

/** @returns {Promise<number>} 0 = 没查到 */
export async function resolveUid(stateDir, name, log = () => {}) {
	const q = String(name || "")
		.trim()
		.replace(/^@/, "");
	if (!q) return 0;
	const cache = readCache(stateDir);
	if (Number(cache[q]) > 0) return Number(cache[q]);
	const cred = loadCred(stateDir);
	if (!cred) {
		log("查 UID 失败：还没扫码登录 B站");
		return 0;
	}
	const url =
		"https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&page=1&keyword=" +
		encodeURIComponent(q);
	try {
		const r = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Referer: "https://search.bilibili.com/",
				Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 || ""}`,
			},
		});
		const j = await r.json().catch(() => null);
		const list = j?.data?.result || [];
		if (!list.length) {
			log(`查 UID：搜「${q}」没有结果`);
			return 0;
		}
		const exact = list.find((u) => String(u.uname) === q);
		const pick = exact || list[0];
		const mid = Number(pick.mid) || 0;
		if (mid > 0) {
			cache[q] = mid;
			writeCache(stateDir, cache);
			log(`查 UID：「${q}」→ ${mid}（${pick.uname}${exact ? "，精确匹配" : "，第一个结果"}）`);
		}
		return mid;
	} catch (e) {
		log("查 UID 失败：" + String(e?.message ?? e));
		return 0;
	}
}
