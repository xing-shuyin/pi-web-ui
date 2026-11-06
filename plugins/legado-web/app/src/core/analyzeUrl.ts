import { applyTemplate, type Scope } from "./js";
import type { FetchOptions } from "../types";

export interface ParsedUrl {
	url: string;
	options: FetchOptions;
}

export function parseLooseJson(text: string): Record<string, unknown> | null {
	const t = text.trim();
	try {
		const strict = JSON.parse(t) as unknown;
		return strict && typeof strict === "object" ? (strict as Record<string, unknown>) : null;
	} catch {}
	const out: string[] = [];
	let i = 0;
	let quote = "";
	const lastSignificant = () => {
		for (let k = out.length - 1; k >= 0; k--) {
			const c = out[k]!;
			if (!/\s/.test(c)) return c;
		}
		return "";
	};
	while (i < t.length) {
		const c = t[i]!;
		if (quote) {
			if (c === "\\") {
				const nx = t[i + 1] ?? "";
				if (quote === "'" && nx === "'") {
					out.push("'");
					i += 2;
					continue;
				}
				out.push(c, nx);
				i += 2;
				continue;
			}
			if (c === quote) {
				out.push('"');
				quote = "";
				i++;
				continue;
			}
			if (quote === "'" && c === '"') out.push('\\"');
			else out.push(c);
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			out.push('"');
			i++;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < t.length && /\s/.test(t[j]!)) j++;
			const nx = t[j];
			if (nx === "}" || nx === "]") {
				i = j;
				continue;
			}
			out.push(c);
			i++;
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			const prev = lastSignificant();
			if (prev === "{" || prev === ",") {
				let j = i;
				while (j < t.length && /[\w$.-]/.test(t[j]!)) j++;
				const name = t.slice(i, j);
				let k = j;
				while (k < t.length && /\s/.test(t[k]!)) k++;
				if (t[k] === ":") {
					out.push(`"${name}"`);
					i = j;
					continue;
				}
			}
		}
		out.push(c);
		i++;
	}
	try {
		const v = JSON.parse(out.join("")) as unknown;
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function parseCustomUrl(
	raw: string,
	base: string,
	key = "",
	page = 1,
	scope?: Scope,
	source?: unknown,
): ParsedUrl {
	let urlPart = raw.trim();
	let extra: Record<string, unknown> = {};

	const m = urlPart.match(/,\s*(\{[\s\S]*\})\s*$/);
	if (m?.[1]) {
		const parsed = parseLooseJson(m[1]);
		if (parsed) {
			extra = parsed;
			urlPart = urlPart.slice(0, m.index).trim();
		}
	}

	const ctx = { key, page, baseUrl: base, result: "", source };
	const url = applyTemplate(urlPart, ctx, scope);

	const headers: Record<string, string> = {
		...(((extra["headers"] ?? extra["header"] ?? {}) as Record<string, string>) ?? {}),
	};
	const method = String(extra["method"] ?? "GET").toUpperCase();
	const charset = String(extra["charset"] ?? extra["encoding"] ?? "") || undefined;
	let body = extra["body"] != null ? String(extra["body"]) : undefined;
	if (body) body = applyTemplate(body, ctx, scope);

	if (method !== "GET" && body != null && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
		headers["Content-Type"] = "application/x-www-form-urlencoded";
	}

	let abs = url;
	if (abs && !/^https?:\/\//i.test(abs)) {
		try {
			abs = new URL(abs, base).toString();
		} catch {}
	}
	return { url: abs, options: { method, headers, body, charset } };
}
