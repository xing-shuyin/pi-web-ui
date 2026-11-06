import { randomHex } from "./gen-util.mjs";

const NAME_RE = /^[A-Za-z0-9_.\-[\]]+$/;

export function buildMultipart(parts, boundary = `----piwebui-${randomHex(12)}`) {
	const chunks = [];
	const crlf = "\r\n";
	for (const p of parts) {
		const name = String(p?.name ?? "");
		if (!NAME_RE.test(name)) throw new Error(`multipart: 非法字段名 ${JSON.stringify(name)}`);
		const header = [];
		if (p && (p.filename || Buffer.isBuffer(p.data) || p.data instanceof Uint8Array)) {
			const filename = String(p.filename ?? "file");
			const type = String(p.contentType ?? "application/octet-stream");
			header.push(`--${boundary}${crlf}`);
			header.push(
				`Content-Disposition: form-data; name="${name}"; filename="${filename.replace(/["\r\n]/g, "_")}"${crlf}`,
			);
			header.push(`Content-Type: ${type}${crlf}${crlf}`);
			chunks.push(Buffer.from(header.join(""), "utf8"));
			chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data ?? []));
			chunks.push(Buffer.from(crlf, "utf8"));
		} else {
			header.push(`--${boundary}${crlf}`);
			header.push(`Content-Disposition: form-data; name="${name}"${crlf}${crlf}`);
			chunks.push(Buffer.from(header.join(""), "utf8"));
			chunks.push(Buffer.from(String(p?.value ?? ""), "utf8"));
			chunks.push(Buffer.from(crlf, "utf8"));
		}
	}
	chunks.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));
	return {
		body: Buffer.concat(chunks),
		contentType: `multipart/form-data; boundary=${boundary}`,
		boundary,
	};
}

export function formFields(obj, allowed) {
	const out = [];
	for (const [k, v] of Object.entries(obj ?? {})) {
		if (allowed && !allowed.includes(k)) continue;
		if (v === undefined || v === null || v === "") continue;
		out.push({ name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
	}
	return out;
}
