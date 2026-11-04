/**
 * 音频流 Range 代理与文件下载 —— 解决第三方音源防盗链、跨域、Seek (HTTP 206) 及长音频流稳定传输
 */
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";

const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;

/** 解析 HTTP Range 头 (例如: "bytes=1048576-" 或 "bytes=0-1023") */
export function parseRangeHeader(rangeHeader, totalLength) {
	if (!rangeHeader || typeof rangeHeader !== "string") return null;
	const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
	if (!match) return null;

	let start = match[1] !== "" && match[1] !== undefined ? parseInt(match[1], 10) : undefined;
	let end = match[2] !== "" && match[2] !== undefined ? parseInt(match[2], 10) : undefined;

	if (start === undefined && end === undefined) return null;

	if (totalLength !== undefined && totalLength > 0) {
		if (start === undefined) {
			// bytes=-500 代表最后 500 个字节
			start = Math.max(0, totalLength - end);
			end = totalLength - 1;
		} else if (end === undefined || end >= totalLength) {
			end = totalLength - 1;
		}
		if (start > end || start >= totalLength) {
			return { unsatisfied: true, totalLength };
		}
	}

	return { start, end };
}

/**
 * 创建用于服务端切片的 Transform 流
 * 当上游不支持 Range (返回 200)，但客户端请求了特定字节区间时，用于流式跳过前置字节并截断到目标区间
 */
export function createRangeSliceStream(start = 0, end = Infinity) {
	let bytesRead = 0;
	let finished = false;

	return new Transform({
		transform(chunk, encoding, callback) {
			if (finished) return callback();

			const chunkStart = bytesRead;
			const chunkEnd = bytesRead + chunk.length - 1;
			bytesRead += chunk.length;

			// 当前 chunk 还在 start 之前
			if (chunkEnd < start) {
				return callback();
			}

			// 当前 chunk 已经超出 end
			if (chunkStart > end) {
				finished = true;
				this.push(null);
				return callback();
			}

			const sliceStart = Math.max(0, start - chunkStart);
			const sliceEnd = Math.min(chunk.length, end - chunkStart + 1);
			const sliced = chunk.subarray(sliceStart, sliceEnd);

			if (chunkEnd >= end) {
				finished = true;
				this.push(sliced);
				this.push(null);
				return callback();
			}

			callback(null, sliced);
		},
	});
}

export function proxyAudioStream(
	req,
	res,
	targetUrl,
	referer = "",
	downloadFilename = "",
	redirectCount = 0,
	connectTimeoutMs = 15000,
) {
	if (redirectCount > MAX_REDIRECTS) {
		if (!res.headersSent) res.writeHead(508, { "Content-Type": "text/plain" }).end("Too many audio redirects");
		return;
	}

	let parsedUrl;
	try {
		parsedUrl = new URL(targetUrl);
	} catch {
		if (!res.headersSent) res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid audio URL");
		return;
	}

	const client = parsedUrl.protocol === "https:" ? https : http;
	const headers = {
		"User-Agent": DEFAULT_UA,
		Accept: "*/*",
		"Accept-Encoding": "identity",
	};

	if (referer) {
		headers["Referer"] = referer;
	} else if (parsedUrl.hostname.includes("kuwo.cn")) {
		headers["Referer"] = "http://www.kuwo.cn/";
	} else if (parsedUrl.hostname.includes("kugou.com")) {
		headers["Referer"] = "http://www.kugou.com/";
	} else if (parsedUrl.hostname.includes("163.com") || parsedUrl.hostname.includes("126.net")) {
		headers["Referer"] = "https://music.163.com/";
	}

	const clientRangeHeader = req.headers.range;
	if (clientRangeHeader && !downloadFilename) {
		headers["Range"] = clientRangeHeader;
	}

	let responseReceived = false;
	const proxyReq = client.request(
		targetUrl,
		{
			method: "GET",
			headers,
			timeout: connectTimeoutMs,
		},
		(proxyRes) => {
			responseReceived = true;
			// 响应头到达后彻底解除 socket 超时：防止长音频播放暂停/流控时连接被误杀
			proxyReq.setTimeout(0);
			if (proxyReq.socket) {
				proxyReq.socket.setTimeout(0);
			}

			// 处理 301 / 302 / 307 重定向
			if (
				(proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 307) &&
				proxyRes.headers.location
			) {
				return proxyAudioStream(req, res, proxyRes.headers.location, referer, downloadFilename, redirectCount + 1);
			}

			const upstreamTotal = proxyRes.headers["content-length"]
				? parseInt(proxyRes.headers["content-length"], 10)
				: undefined;

			const isUpstreamPartial = proxyRes.statusCode === 206;
			const isClientRange = !!clientRangeHeader && !downloadFilename;

			// 检查是否需要服务端透明切片：客户端请求了 Range，但上游返回了 200 OK（上游不支持 Range）
			let sliceRange = null;
			if (isClientRange && !isUpstreamPartial && proxyRes.statusCode === 200) {
				const parsed = parseRangeHeader(clientRangeHeader, upstreamTotal);
				if (parsed?.unsatisfied) {
					res
						.writeHead(416, {
							"Content-Type": "text/plain",
							"Content-Range": `bytes */${upstreamTotal || "*"}`,
						})
						.end("Requested Range Not Satisfiable");
					proxyReq.destroy();
					return;
				}
				if (parsed && parsed.start !== undefined) {
					sliceRange = parsed;
				}
			}

			const resHeaders = {
				"Content-Type": proxyRes.headers["content-type"] || "audio/mpeg",
				"Accept-Ranges": "bytes",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "Range",
				"Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
			};

			if (downloadFilename) {
				const encodedName = encodeURIComponent(downloadFilename);
				resHeaders["Content-Disposition"] = `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`;
			}

			if (sliceRange) {
				// 服务端模拟 206 Partial Content
				const start = sliceRange.start;
				const end =
					sliceRange.end !== undefined ? sliceRange.end : upstreamTotal !== undefined ? upstreamTotal - 1 : Infinity;
				const totalStr = upstreamTotal !== undefined ? String(upstreamTotal) : "*";
				resHeaders["Content-Range"] = `bytes ${start}-${end}/${totalStr}`;
				if (upstreamTotal !== undefined && Number.isFinite(end)) {
					resHeaders["Content-Length"] = String(end - start + 1);
				}
				res.writeHead(206, resHeaders);

				const sliceStream = createRangeSliceStream(start, end);
				proxyRes.pipe(sliceStream).pipe(res);
			} else {
				// 正常透传
				if (proxyRes.headers["content-length"]) {
					resHeaders["Content-Length"] = proxyRes.headers["content-length"];
				}
				if (proxyRes.headers["content-range"]) {
					resHeaders["Content-Range"] = proxyRes.headers["content-range"];
				}

				res.writeHead(proxyRes.statusCode || 200, resHeaders);
				proxyRes.pipe(res);
			}

			proxyRes.on("error", () => {
				if (!res.writableEnded) res.end();
			});
		},
	);

	proxyReq.on("timeout", () => {
		if (!responseReceived) {
			proxyReq.destroy();
			if (!res.headersSent) res.writeHead(504, { "Content-Type": "text/plain" }).end("Audio stream gateway timeout");
		}
	});

	proxyReq.on("error", (err) => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "text/plain" }).end(`Audio proxy error: ${err.message}`);
		} else if (!res.writableEnded) {
			res.end();
		}
	});

	const cleanup = () => {
		if (!res.writableEnded && !res.writableFinished) {
			proxyReq.destroy();
		}
	};

	req.on("aborted", cleanup);
	res.on("close", cleanup);
	res.on("error", cleanup);

	proxyReq.end();
}
