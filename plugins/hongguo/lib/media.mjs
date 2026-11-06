/** Media helpers adapted from https://github.com/frostming/dsh-hongguo. */
const CDN_HOST =
	/(^|\.)(qznovelvod\.com|byteimg\.com|fqnovelpic\.com|douyinvod\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com|pstatp\.com)$/i;

export function cdnUrl(raw, base) {
	let url;
	try {
		url = new URL(raw, base);
	} catch {
		throw Object.assign(new Error("无效的媒体地址"), { status: 400 });
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!CDN_HOST.test(url.hostname) ||
		url.username ||
		url.password ||
		url.port
	) {
		throw Object.assign(new Error("不支持的媒体来源"), { status: 403 });
	}
	return url.href;
}

/** A single RFC 9110 byte range; null means the complete representation. */
export function byteRange(header, size) {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	const invalid = () => {
		throw Object.assign(new Error("无效的播放范围"), { status: 416 });
	};
	if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return invalid();
	const first = Number(match[1] || 0),
		last = Number(match[2] || 0);
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return invalid();
	const start = match[1] ? first : Math.max(0, size - last);
	const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size)
		return invalid();
	return { start, end };
}

/** Relative URLs retain an application's reverse-proxy base path. */
export function rewriteManifest(text, upstream) {
	const proxy = (raw) => `./stream?u=${encodeURIComponent(cdnUrl(raw.replace(/&amp;/g, "&"), upstream))}`;
	if (/<MPD[\s>]/.test(text)) {
		// MP4 DASH from openhongguo uses BaseURL, with SegmentBase byte ranges.
		// SegmentTemplate needs path substitution, which query proxying cannot preserve.
		if (/<SegmentTemplate[\s>]/.test(text)) throw new Error("此 DASH 分片格式暂不支持，请选择其他线路");
		return text
			.replace(
				/(<BaseURL(?:\s[^>]*)?>)([^<]+)(<\/BaseURL>)/g,
				(_, a, raw, b) => a + proxy(raw.trim()).replace(/&/g, "&amp;") + b,
			)
			.replace(
				/(\b(?:media|sourceURL)=["'])([^"']+)(["'])/g,
				(_, a, raw, b) => a + proxy(raw).replace(/&/g, "&amp;") + b,
			);
	}
	return text
		.split(/\r?\n/)
		.map((line) => {
			const raw = line.trim();
			if (!raw) return line;
			if (raw.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxy(uri)}"`);
			return proxy(raw);
		})
		.join("\n");
}

export function safeId(raw) {
	const id = String(raw ?? "");
	if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw Object.assign(new Error("无效的剧集编号"), { status: 400 });
	return id;
}

export function dramaRow(item) {
	return {
		id: String(item.id),
		title: item.title ?? "未命名短剧",
		description: item.description ?? "",
		cover: item.cover_url ?? item.cover ?? "",
		episodes: item.episode_count ?? item.episodes,
		heat: item.digg_count ?? item.comment_count,
	};
}
