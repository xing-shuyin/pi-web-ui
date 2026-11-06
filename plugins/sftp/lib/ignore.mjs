const INTERNAL_DIRS = new Set([".sftp-trash"]);
const INTERNAL_FILE_PREFIX = ".sftp-tmp";

export function globToRegExp(pattern) {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (i >= pattern.length - 1) re += ".*";
				else if (pattern[i + 1] === "/") {
					i++;
					re += "(?:[^/]*/)*";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

function ruleToRegExps(raw) {
	const pat = String(raw ?? "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	if (!pat) return [];
	if (pat === "**") return [/.*/];
	const list = [globToRegExp(pat)];
	if (!pat.includes("/")) {
		list.push(globToRegExp(`**/${pat}`));
		list.push(globToRegExp(`${pat}/**`));
		list.push(globToRegExp(`**/${pat}/**`));
	}
	if (pat.endsWith("/**")) list.push(globToRegExp(pat.slice(0, -3)));
	return list;
}

/**
 * 编译用户规则集 → `(rel) => boolean`。
 * @param {string[]} patterns
 */
export function compileIgnore(patterns) {
	const rules = [];
	for (const raw of patterns ?? []) {
		const s = String(raw ?? "").trim();
		if (!s) continue;
		const neg = s.startsWith("!");
		const res = ruleToRegExps(neg ? s.slice(1) : s);
		if (res.length) rules.push({ neg, res });
	}
	return (rel) => {
		const p = String(rel ?? "").replace(/^\/+/, "");
		if (!p) return false;
		let ignored = false;
		for (const r of rules) {
			if (r.res.some((re) => re.test(p))) ignored = !r.neg;
		}
		return ignored;
	};
}

export function isInternalPath(rel) {
	return String(rel ?? "")
		.split("/")
		.some((seg) => INTERNAL_DIRS.has(seg) || seg.startsWith(INTERNAL_FILE_PREFIX));
}

/**
 * 从 ignore 规则里挑出「可以直接交给 `find -prune` 的纯目录名」。
 *
 * 只认**没被取反、不含 `/` 也没通配符**的规则（`node_modules`、`.git`、`dist`）—— 这些名字在
 * 任意层级含义一致，`-prune` 剪掉子树与逐条 ignore 判定完全等价，白白省下遍历整棵 node_modules。
 * 其余（`*.log`、`src/tmp`、`!keep`）一律还是交给 JS 逐条判定：快不是目的，不错才是。
 *
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function pruneDirNames(patterns) {
	const out = new Set();
	for (const raw of patterns ?? []) {
		const s = String(raw ?? "").trim();
		if (!s || s.startsWith("!")) continue;
		const pat = s.replace(/^\/+|\/+$/g, "");
		if (!pat || pat === "**") continue;
		if (pat.includes("/") || /[\\*?[\]]/.test(pat)) continue;
		out.add(pat);
	}
	return [...out];
}

/**
 * 组合判定器：先看内部护栏（不可被负向规则放回），再看用户规则。
 * @param {string[]} patterns
 * @returns {(rel: string) => boolean}
 */
export function makeMatcher(patterns) {
	const user = compileIgnore(patterns);
	return (rel) => isInternalPath(rel) || user(rel);
}
