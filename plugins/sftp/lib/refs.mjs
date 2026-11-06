const REF = /^\$\{(env|secret|file):([^{}]*)\}$/;

export function looksLikeRef(v) {
	return typeof v === "string" && v.trim().startsWith("${");
}

/**
 * 解析引用为 `{ scheme, arg }`；不是引用返回 null；像引用但写错则抛错。
 * @param {string} raw
 * @param {string} label 报错里用的字段名（如 `prod.auth.password`）
 */
export function parseRef(raw, label = "value") {
	if (!looksLikeRef(raw)) return null;
	const m = REF.exec(String(raw).trim());
	if (!m) {
		throw new Error(
			`${label} 的引用写法不合法：${String(raw).slice(0, 60)}。` +
				`可用 ${"${env:VAR}"} / ${"${secret:name}"} / ${"${file:~/path}"}，或直接写明文。`,
		);
	}
	const arg = m[2].trim();
	if (!arg) throw new Error(`${label} 的引用缺少名字：${String(raw).slice(0, 60)}`);
	return { scheme: m[1], arg };
}

export function describeRef(raw) {
	if (!raw) return "";
	const m = REF.exec(String(raw).trim());
	if (!m) return looksLikeRef(raw) ? "invalid" : "plain";
	return `${m[1]}:${m[2]}`;
}

/**
 * 解析成真实值。
 * @param {string} raw
 * @param {{ secrets?: { get(name: string): string | undefined }, label?: string }} ctx
 * @returns {Promise<{ value: string, source: "plain"|"env"|"secret"|"file" }>}
 */
export async function resolveRef(raw, ctx = {}) {
	const label = ctx.label ?? "value";
	if (raw === undefined || raw === null || raw === "") return { value: "", source: "plain" };
	if (typeof raw !== "string") return { value: String(raw), source: "plain" };
	const ref = parseRef(raw, label);
	if (!ref) return { value: raw, source: "plain" };

	if (ref.scheme === "env") {
		const v = process.env[ref.arg];
		if (v === undefined) throw new Error(`${label} 引用的环境变量 ${ref.arg} 未设置`);
		return { value: String(v), source: "env" };
	}
	if (ref.scheme === "secret") {
		const v = ctx.secrets?.get?.(ref.arg);
		if (v === undefined) {
			throw new Error(`${label} 引用的机密 ${ref.arg} 不存在——用 sftp_secret 工具写入，或在设置里重新保存`);
		}
		return { value: String(v), source: "secret" };
	}
	const { readFile } = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const p = ref.arg.startsWith("~/")
		? path.join(os.homedir(), ref.arg.slice(2))
		: path.isAbsolute(ref.arg)
			? ref.arg
			: path.resolve(ref.arg);
	try {
		const text = await readFile(p, "utf8");
		return { value: text.replace(/\r?\n+$/, ""), source: "file" };
	} catch (err) {
		throw new Error(`${label} 引用的文件读不到（${p}）：${err?.code ?? err?.message ?? err}`);
	}
}
