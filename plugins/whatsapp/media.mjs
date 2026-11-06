import { randomUUID } from "node:crypto";

export const MEDIA_LIMIT = 20 * 1024 * 1024;
export const INBOUND_MEDIA_LIMIT = 10 * 1024 * 1024;
const GRAPH = "https://graph.facebook.com/v20.0";
export const MEDIA_TYPES = ["image", "audio", "document", "video"];

async function boundedBody(response) {
	if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
	if (Number(response.headers?.get("content-length")) > INBOUND_MEDIA_LIMIT)
		throw new Error("Inbound media exceeds 10 MiB limit");
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > INBOUND_MEDIA_LIMIT) throw new Error("Inbound media exceeds 10 MiB limit");
			chunks.push(Buffer.from(chunk));
		}
	} catch (err) {
		throw new Error(`Media download failed: ${err.message}`);
	}
	if (!size) throw new Error("Empty media download");
	return Buffer.concat(chunks);
}

export async function receiveMedia(host, cfg, message) {
	const kind = message.type;
	const media = message[kind];
	if (!MEDIA_TYPES.includes(kind) || !media?.id) throw new Error("Unsupported or missing media ID");

	const response = await fetch(`${GRAPH}/${encodeURIComponent(media.id)}`, {
		headers: { Authorization: `Bearer ${cfg.accessToken}` },
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`Media lookup failed: HTTP ${response.status}`);
	const info = await response.json();
	if (Number(info.file_size) > INBOUND_MEDIA_LIMIT) throw new Error("Inbound media exceeds 10 MiB limit");
	const url = new URL(info.url);
	if (
		url.protocol !== "https:" ||
		!(url.hostname === "fbsbx.com" || url.hostname.endsWith(".fbsbx.com") || url.hostname.endsWith(".facebook.com"))
	) {
		throw new Error("Untrusted media download host");
	}
	const downloaded = await fetch(url, {
		headers: { Authorization: `Bearer ${cfg.accessToken}` },
		redirect: "error",
		signal: AbortSignal.timeout(30000),
	});
	const bytes = await boundedBody(downloaded);
	const name = String(media.filename || `${kind}.bin`)
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.slice(-100);
	const path = `.whatsapp-media/${randomUUID()}-${name}`;
	return {
		path,
		bytes,
		name,
		mimeType: info.mime_type || media.mime_type || "application/octet-stream",
		kind,
		size: bytes.length,
	};
}

export async function sendMedia(
	host,
	cfg,
	to,
	{ type, path, mediaId = undefined, caption = undefined, filename = undefined, mimeType },
) {
	if (!MEDIA_TYPES.includes(type)) throw new Error("Media type must be image, audio, document or video");
	if (!cfg.accessToken || !cfg.phoneNumberId) throw new Error("WhatsApp credentials are not configured");
	let id = mediaId;
	if (!id) {
		if (!path || !host.fs?.read) throw new Error("Provide a workspace path or WhatsApp mediaId");
		const stat = await host.fs.stat(path);
		if (stat.type !== "file" || stat.size > MEDIA_LIMIT) throw new Error("Media must be a file up to 20 MiB");
		const bytes = await host.fs.read(path);
		if (!bytes.length || bytes.length > MEDIA_LIMIT) throw new Error("Media must be nonempty and up to 20 MiB");
		const form = new FormData();
		form.set("messaging_product", "whatsapp");
		form.set(
			"file",
			new Blob([bytes], { type: mimeType || "application/octet-stream" }),
			filename || path.split(/[\\/]/).pop(),
		);
		const uploaded = await fetch(`${GRAPH}/${encodeURIComponent(cfg.phoneNumberId)}/media`, {
			method: "POST",
			headers: { Authorization: `Bearer ${cfg.accessToken}` },
			body: form,
			signal: AbortSignal.timeout(30000),
		});
		const result = await uploaded.json();
		if (!uploaded.ok || !result.id)
			throw new Error(result.error?.message || `Media upload failed: HTTP ${uploaded.status}`);
		id = result.id;
	}
	const content = { id };
	if (caption && type !== "audio") content.caption = String(caption).slice(0, 1024);
	if (filename && type === "document") content.filename = filename;
	const response = await fetch(`${GRAPH}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: String(to).replace(/[^\d]/g, ""),
			type,
			[type]: content,
		}),
		signal: AbortSignal.timeout(30000),
	});
	const result = await response.json();
	if (!response.ok || result.error)
		throw new Error(result.error?.message || `Media send failed: HTTP ${response.status}`);
	return result;
}
