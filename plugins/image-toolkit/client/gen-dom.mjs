export function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	const deferred = [];
	for (const [k, v] of Object.entries(props ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = String(v);
		else if (k === "text") node.textContent = String(v);
		else if (k === "html") node.innerHTML = String(v);
		else if (k === "value") deferred.push(v);
		else if (k === "dataset") Object.assign(node.dataset, v);
		else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
		else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v === true) node.setAttribute(k, "");
		else node.setAttribute(k, String(v));
	}
	for (const kid of children.flat(4)) {
		if (kid === null || kid === undefined || kid === false) continue;
		node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	for (const v of deferred) node.value = String(v);
	return node;
}

export function fill(node, ...children) {
	node.replaceChildren(...children.flat(4).filter(Boolean));
	return node;
}

export function fmtBytes(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v < 0) return "?";
	if (v < 1024) return `${v} B`;
	if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
	return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v < 0) return "-";
	if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
	const m = Math.floor(v / 60_000);
	const s = Math.round((v % 60_000) / 1000);
	return `${m}m${String(s).padStart(2, "0")}s`;
}

export function fmtTime(ts) {
	try {
		const d = new Date(Number(ts) || Date.now());
		const p = (n) => String(n).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())}`;
	} catch {
		return "";
	}
}

export async function copyText(text) {
	const s = String(text ?? "");
	try {
		await navigator.clipboard.writeText(s);
		return true;
	} catch {}
	try {
		const ta = el("textarea", { style: { position: "fixed", opacity: "0" } });
		ta.value = s;
		document.body.append(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

export function parseJsonField(text, label) {
	const s = String(text ?? "").trim();
	if (!s) return {};
	let v;
	try {
		v = JSON.parse(s);
	} catch (err) {
		throw new Error(`${label}: JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`);
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label}: 需要一个 JSON 对象`);
	return v;
}

export function linesToList(text) {
	return String(text ?? "")
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export const baseName = (p) =>
	String(p ?? "")
		.split(/[\\/]/)
		.pop() || "";
