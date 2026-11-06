import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseSeen(text) {
	const rows = [];
	for (const line of String(text).split(/\r?\n/)) {
		const bv = /BV[0-9A-Za-z]{10}/.exec(line);
		if (!bv) continue;
		const nums = [...line.matchAll(/\b(\d{9,})\b/g)].map((m) => Number(m[1]));
		if (!nums.length) continue;
		const rpid = nums[0];
		const root = nums.length > 1 ? nums[1] : 0;
		rows.push({ bv: bv[0], rpid, root, line: line.trim().slice(0, 160) });
	}
	return rows;
}

export function loadCredential(stateDir) {
	let f = join(stateDir, "bili_credential.json");
	if (!existsSync(f) && existsSync(join(stateDir, "credentials.json"))) {
		f = join(stateDir, "credentials.json");
	}
	if (!existsSync(f)) return null;
	try {
		const c = JSON.parse(readFileSync(f, "utf8"));
		if (!c?.sessdata) return null;
		return c;
	} catch {
		return null;
	}
}

function headersFor(cred) {
	return {
		"User-Agent": UA,
		Referer: "https://www.bilibili.com/",
		Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 || ""}`,
	};
}

async function jget(url, headers) {
	try {
		const r = await fetch(url, { headers });
		const t = await r.text();
		try {
			return JSON.parse(t);
		} catch {
			return { code: -999, message: "not json" };
		}
	} catch (e) {
		return { code: -998, message: String(e?.message ?? e) };
	}
}

export async function verifyOne(record, { cred, aidCache = new Map(), headers }) {
	const out = { rpid: record.rpid, bv: record.bv, visible: null, how: "", note: "" };
	if (!aidCache.has(record.bv)) {
		const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${record.bv}`, headers);
		aidCache.set(record.bv, v?.code === 0 ? { aid: v.data.aid, mid: v.data.owner?.mid, title: v.data.title } : null);
		await sleep(300);
	}
	const meta = aidCache.get(record.bv);
	if (!meta) {
		out.how = "取视频信息失败";
		out.note = "这条跳过（视频可能已删/不可见）";
		return out;
	}
	const aid = meta.aid;

	if (!record.root) {
		const d = await jget(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=0&ps=20`, headers);
		const list = d?.data?.replies || [];
		const hit = list.find((r) => r.rpid === record.rpid);
		if (hit && hit.rpid === record.rpid) {
			out.visible = true;
			out.likes = hit.like;
			out.how = "顶层·最新一页";
			out.note = hit.invisible ? "（但接口标了 invisible）" : "";
			return out;
		}
		out.how = "顶层·最新一页";
		out.note = "最新一页里没找到 —— 可能还在审核，也可能只是翻页看不到（不等于没发出去）";
		return out;
	}

	const d = await jget(
		`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${record.root}&ps=20&pn=1`,
		headers,
	);
	const subs = d?.data?.replies || [];
	const hit = subs.find((r) => r.rpid === record.rpid);
	if (hit && hit.rpid === record.rpid) {
		out.visible = true;
		out.likes = hit.like;
		out.how = "楼中楼";
		out.note = hit.invisible ? "（但接口标了 invisible）" : "";
		return out;
	}
	out.how = "楼中楼第一页";
	out.note = "楼层里没找到 —— 可能在审核或已被折叠";
	return out;
}

export async function verifyRecent(stateDir, { max = 5, log = () => {} } = {}) {
	const cred = loadCredential(stateDir);
	if (!cred) return { ok: false, error: "未登录，无法核对评论可见性" };
	const seenFile = join(stateDir, "seen.md");
	if (!existsSync(seenFile)) return { ok: true, checked: [], text: "没有判重表，跳过" };

	const text = readFileSync(seenFile, "utf8");
	const rows = parseSeen(text);
	if (!rows.length) return { ok: true, checked: [], text: "判重表里没有记录到评论 rpid" };

	const dedup = [];
	const seenRpid = new Set();
	for (const r of rows.slice().reverse()) {
		if (seenRpid.has(r.rpid)) continue;
		seenRpid.add(r.rpid);
		dedup.push(r);
		if (dedup.length >= max) break;
	}

	const headers = headersFor(cred);
	const aidCache = new Map();
	const checked = [];
	for (const r of dedup) {
		log(`复核评论：正在查 ${r.bv} 的 rpid=${r.rpid}`);
		const res = await verifyOne(r, { cred, aidCache, headers });
		checked.push(res);
		await sleep(500);
	}

	const lines = [
		"### 评论可见性复核（最近记录）",
		"",
		"| 视频 | rpid | 状态 | 赞数 | 查验方式 | 备注 |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const c of checked) {
		const st = c.visible === true ? "公开可见 ✅" : "没查到 ❓";
		const lk = c.likes !== undefined ? String(c.likes) : "-";
		lines.push(
			`| [${c.bv}](https://www.bilibili.com/video/${c.bv}) | ${c.rpid} | ${st} | ${lk} | ${c.how} | ${c.note} |`,
		);
	}
	lines.push(
		"",
		"> 说明：核验依赖 B 站公开接口，刚发出的评论可能因审核延迟或排序算法在首屏看不到（**没查到 ≠ 没发出**）。",
	);

	return { ok: true, checked, text: lines.join("\n") };
}

export function appendVerifyToReport(stateDir, verifyText) {
	const today = new Date().toISOString().slice(0, 10);
	const reportFile = join(stateDir, "out", `${today}.md`);
	if (!existsSync(reportFile)) return null;
	try {
		const cur = readFileSync(reportFile, "utf8");
		if (cur.includes("### 评论可见性复核")) {
			const cut = cur.split("### 评论可见性复核")[0].trimEnd();
			writeFileSync(reportFile, cut + "\n\n" + verifyText + "\n", "utf8");
		} else {
			writeFileSync(reportFile, cur.trimEnd() + "\n\n" + verifyText + "\n", "utf8");
		}
		return reportFile;
	} catch {
		return null;
	}
}
