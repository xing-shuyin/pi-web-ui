// scripts/lib/npm-version.mjs
// npm 版本自检的纯逻辑（无网络、无 IO），给 scripts/check-npm-version.mjs 与单测共用。
//
// 口径见 scripts/check-npm-version.mjs 头部注释；这里只做「本地版本 vs registry 文档」的判定。

/** 宽松版本比较：只比数值段；带预发布后缀的一律小于同号正式版。 */
export function compareVersions(a, b) {
	const split = (v) =>
		String(v ?? "")
			.split("-")[0]
			.split(".")
			.map((n) => parseInt(n, 10) || 0);
	const pa = split(a);
	const pb = split(b);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	const preA = String(a).includes("-");
	const preB = String(b).includes("-");
	if (preA === preB) return 0;
	return preA ? -1 : 1;
}

/**
 * registry 文档 → 结论。
 * `doc` 是 `https://registry.npmjs.org/<name>` 的响应体（`{ "dist-tags": { latest }, versions: {…} }`）；
 * `null` 表示 registry 上根本没有这个包（或网络拿不到，由调用方区分）。
 * 返回 `{ ok, problems, latest, hasVersion }`。
 */
export function evaluateNpmVersion({ name, version, doc }) {
	const problems = [];
	if (!doc) {
		problems.push(`registry 上找不到包 ${name}`);
		return { ok: false, problems, latest: null, hasVersion: false };
	}
	const latest = doc["dist-tags"]?.latest ?? null;
	const hasVersion = Boolean(doc.versions?.[version]);
	if (!hasVersion) problems.push(`registry 上没有 ${name}@${version}（当前 latest = ${latest ?? "无"}）`);
	if (latest && compareVersions(latest, version) !== 0 && compareVersions(latest, version) > 0) {
		problems.push(`registry 的 latest（${latest}）比待发版本（${version}）新：本地落后，先拉代码`);
	}
	// 版本已发布但 latest 指向别处（发布时带了别的 dist-tag）：用户 npm i -g 拿不到这一版。
	if (hasVersion && latest && compareVersions(latest, version) < 0) {
		problems.push(`registry 有 ${version}，但 latest 还停在 ${latest}：npm i -g 不会装到这一版`);
	}
	return { ok: problems.length === 0, problems, latest, hasVersion };
}
