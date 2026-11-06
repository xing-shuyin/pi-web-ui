import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_INBOUND_FILE_BYTES = 10 * 1024 * 1024;

export async function dingJson(url, init = {}) {
	const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`DingTalk HTTP ${response.status}`);
	const body = await response.json();
	if ((body.errcode !== undefined && Number(body.errcode) !== 0) || body.code) {
		throw new Error(`DingTalk ${body.errcode ?? body.code}: ${body.errmsg || body.message || "请求失败"}`);
	}
	return body;
}

export async function accessToken(cfg) {
	if (!cfg.appKey || !cfg.appSecret) throw new Error("媒体需要配置 AppKey / AppSecret");
	const body = await dingJson("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
	});
	if (!body.accessToken) throw new Error("钉钉认证未返回 accessToken");
	return body.accessToken;
}

async function readLimited(response) {
	if (!response.ok) throw new Error(`媒体下载 HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > MAX_INBOUND_FILE_BYTES)
		throw new Error("入站单个媒体超过 10MiB 限制");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("媒体响应没有内容");
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_INBOUND_FILE_BYTES) throw new Error("入站单个媒体超过 10MiB 限制");
			chunks.push(Buffer.from(value));
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (!size) throw new Error("媒体内容为空");
	return Buffer.concat(chunks);
}

function imageMime(bytes) {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
	if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
	throw new Error("图片无法解码：仅支持 PNG / JPEG / GIF / WebP，请重新发送原图");
}

export async function receiveMedia(event, cfg) {
	const kind = String(event.msgtype || event.msgType || "text").toLowerCase();
	if (kind === "text" || kind === "markdown") return { attachments: [], notice: "" };
	if (!["picture", "image", "audio", "voice", "file", "video", "richtext"].includes(kind)) {
		throw new Error(`暂不支持消息类型 ${kind}，请发送文字或图片、语音、文件、视频`);
	}
	let content = event.content || event[kind] || {};
	if (typeof content === "string") {
		try {
			content = JSON.parse(content);
		} catch {
			throw new Error("媒体消息无法解码，请重新发送");
		}
	}
	const parts = kind === "richtext" ? content.richText || [] : [content];
	if (parts.length > 16) throw new Error("单条消息最多接收 16 个媒体片段");
	const attachments = [];
	const textParts = [];
	let total = 0;
	let token;
	for (const part of parts) {
		if (part.text) textParts.push(String(part.text));
		const code = part.downloadCode || part.pictureDownloadCode;
		if (!code) {
			if (kind !== "richtext" || !part.text) throw new Error("媒体缺少 downloadCode，无法读取；请重新发送原文件");
			continue;
		}
		token ||= await accessToken(cfg);
		const result = await dingJson("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
			method: "POST",
			headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify({ downloadCode: code, robotCode: cfg.robotCode || cfg.appKey }),
		});
		const url = new URL(result.downloadUrl);
		if (url.protocol !== "https:") throw new Error("拒绝非 HTTPS 媒体下载地址");
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		const bytes = await readLimited(response);
		total += bytes.length;
		if (total > MAX_MEDIA_BYTES) throw new Error("单条消息媒体累计超过 20MB");
		const isImage = ["picture", "image", "richtext"].includes(kind);
		if (isImage && attachments.filter((item) => item.imageData).length >= 8)
			throw new Error("单条消息最多接收 8 张图片");
		const name = basename(
			String(part.fileName || part.name || `${kind}-${attachments.length}${isImage ? ".png" : ""}`),
		);
		attachments.push(
			isImage
				? { path: "", name, imageData: bytes.toString("base64"), mimeType: imageMime(bytes) }
				: { path: "", name, fileData: bytes.toString("base64"), mimeType: "application/octet-stream" },
		);
	}
	if (!attachments.length && !textParts.length) throw new Error("媒体消息为空，无法解码");
	const notice = ["audio", "voice", "video"].includes(kind)
		? "已接收媒体原文件；当前通道不提供自动语音转写或视频解码，模型需使用可用工具读取，无法解码时应明确告知。"
		: "";
	return { attachments, notice, text: textParts.join("\n") };
}

async function uploadMedia(path, type, token) {
	const info = await stat(path);
	if (!info.isFile() || info.size > MAX_MEDIA_BYTES || !info.size) throw new Error("媒体必须是非空文件且不超过 20MB");
	const bytes = await readFile(path);
	if (bytes.length > MAX_MEDIA_BYTES) throw new Error("媒体超过 20MB");
	if (type === "image") imageMime(bytes);
	const form = new FormData();
	form.append("media", new Blob([bytes]), basename(path));
	const body = await dingJson(
		`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
		{ method: "POST", body: form },
	);
	if (!body.media_id) throw new Error("钉钉上传未返回 media_id");
	return body.media_id;
}

export async function sendMedia(cfg, args) {
	const type = String(args.mediaType || "");
	if (!["image", "audio", "file", "video"].includes(type)) throw new Error("mediaType 必须为 image/audio/file/video");
	if (!cfg.robotCode) throw new Error("媒体发送需要 robotCode 与企业机器人权限；自定义 Webhook 不支持原生媒体");
	if ((!args.openConversationId && !args.userId) || (args.openConversationId && args.userId))
		throw new Error("指定且仅指定 openConversationId（群）或 userId（单聊）");
	if (["audio", "video"].includes(type) && !(Number(args.duration) > 0))
		throw new Error("语音/视频需要 duration（秒）");
	if (type === "audio" && extname(String(args.path)).toLowerCase() !== ".amr")
		throw new Error("钉钉原生语音要求 AMR 文件；请转换格式或用 file 发送");
	if (type === "video" && (!args.coverPath || extname(String(args.path)).toLowerCase() !== ".mp4"))
		throw new Error("视频需要 MP4 文件和 coverPath 封面图片");
	const token = await accessToken(cfg);
	const mediaId = await uploadMedia(String(args.path || ""), type === "audio" ? "voice" : type, token);
	const params =
		type === "image"
			? { photoURL: mediaId }
			: type === "audio"
				? { mediaId, duration: String(args.duration) }
				: type === "file"
					? { mediaId, fileName: basename(args.path), fileType: extname(args.path).slice(1) }
					: {
							videoMediaId: mediaId,
							videoType: "mp4",
							duration: String(args.duration),
							picMediaId: await uploadMedia(args.coverPath, "image", token),
						};
	return sendRobotMessage(
		cfg,
		args,
		{ image: "sampleImageMsg", audio: "sampleAudio", file: "sampleFile", video: "sampleVideo" }[type],
		params,
		token,
	);
}

export async function sendRobotMessage(cfg, args, msgKey, params, token) {
	if (!cfg.robotCode || (!args.openConversationId && !args.userId) || (args.openConversationId && args.userId))
		throw new Error("企业机器人发送需要 robotCode 和唯一的精确接收目标");
	token ||= await accessToken(cfg);
	const body = {
		robotCode: cfg.robotCode,
		msgKey,
		msgParam: JSON.stringify(params),
		...(args.openConversationId ? { openConversationId: args.openConversationId } : { userIds: [args.userId] }),
	};
	const result = await dingJson(
		`https://api.dingtalk.com/v1.0/robot/${args.openConversationId ? "groupMessages/send" : "oToMessages/batchSend"}`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify(body),
		},
	);
	if (result.invalidStaffIdList?.length || result.flowControlledStaffIdList?.length)
		throw new Error("钉钉拒绝部分接收人或触发限流");
	return result;
}
