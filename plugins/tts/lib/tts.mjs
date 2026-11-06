import { PCM, PLAYED_SEQ_UNIT_MS, WS_ENDPOINT, FORMATS } from "./constants.mjs";
import { ErrorCode, codeName, protocolError, transportError, usageError } from "./errors.mjs";
import { FrameAssembler, buildTtsUrl, parseAudioFrame } from "./frames.mjs";
import { assertToken, issueTicket, resolveToken, setVoice as setVoiceApi } from "./http.mjs";

const DEFAULT_ORIGIN = "https://chat.deepseek.com";
const DEFAULT_TIMEOUT_MS = 90_000;

export function redactUrl(url) {
	return String(url).replace(/([?&]ticket=)[^&]*/i, "$1<redacted>");
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 收一段朗读音频。
 *
 * @param {object} o
 * @param {string} o.sessionId  会话 id（网页端 URL 里 /a/chat/s/<uuid> 那段）
 * @param {string} o.messageId  要读的那条消息的 id
 * @param {string} [o.token]    userToken；不给就读 DS_TOKEN
 * @param {'pcm'|'opus'} [o.format='pcm']
 * @param {string} [o.voice]    传了就先用它切一次音色（服务端会话级状态）
 * @param {'count'|'index'} [o.ackMode='count']  ack 里 received_seq 的口径，见下方注释
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<object>} 见文件末尾 return 处
 */
export async function synthesize({
	sessionId,
	messageId,
	token,
	format = "pcm",
	voice,
	ackMode = "count",
	ackIntervalMs = 1000,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	origin = DEFAULT_ORIGIN,
	signal,
	fetchImpl = globalThis.fetch,
	webSocketImpl = globalThis.WebSocket,
	baseUrl,
	endpoint = WS_ENDPOINT,
	onEvent,
	onChunk,
	log = () => {},
} = {}) {
	if (!sessionId) throw usageError("synthesize 缺 sessionId（会话 id）");
	if (!messageId) throw usageError("synthesize 缺 messageId（消息 id）");
	if (!FORMATS.includes(format)) {
		throw usageError(`format 只支持 ${FORMATS.join(" / ")}，收到 "${format}"`);
	}
	if (typeof webSocketImpl !== "function") {
		throw usageError(
			"当前运行时没有 WebSocket。本包要求 Node >= 22（22 起才有全局 WebSocket），实测在 " +
				`${process.version} 上可用。`,
		);
	}

	const t = assertToken(resolveToken(token));

	const warnings = [];

	if (voice) {
		await setVoiceApi({ voiceId: voice, token: t, signal, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
	}

	const ticketInfo = await issueTicket({ token: t, signal, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });

	const url = buildTtsUrl({ endpoint, sessionId, messageId, ticket: ticketInfo.ticket, format });

	const asm = new FrameAssembler();
	const events = [];
	const state = {
		settled: false,
		ready: null,
		finish: null,
		firstFrameAt: null,
		lastError: null,
		closeInfo: null,
		ackCount: 0,
		ackTimer: null,
		ws: null,
	};

	let resolveOut;
	let rejectOut;
	const done = new Promise((res, rej) => {
		resolveOut = res;
		rejectOut = rej;
	});

	const clearAckTimer = () => {
		if (state.ackTimer) {
			clearInterval(state.ackTimer);
			state.ackTimer = null;
		}
	};

	const cleanup = () => {
		clearTimeout(overallTimer);
		clearAckTimer();
		if (signal) signal.removeEventListener("abort", onAbort);
		const ws = state.ws;
		if (ws) {
			try {
				ws.onmessage = null;
				ws.onerror = null;
				ws.onclose = null;
				ws.onopen = null;
				ws.close();
			} catch {}
		}
	};

	const settle = (err, result) => {
		if (state.settled) return;
		state.settled = true;
		cleanup();
		if (err) {
			if (result) err.details = { ...(err.details ?? {}), result };
			rejectOut(err);
		} else {
			resolveOut(result);
		}
	};

	const currentSeqs = () => {
		if (ackMode === "index") {
			const last = asm.maxSeq < 0 ? 0 : asm.maxSeq;
			return { received: last, played: last };
		}
		const received = asm.receivedCount;
		let played;
		if (format === "pcm") {
			const samplesPerUnit = (PCM.sampleRate * PLAYED_SEQ_UNIT_MS) / 1000;
			const samples = Math.floor(asm.receivedBytes / (PCM.bitsPerSample / 8) / PCM.channels);
			played = Math.floor(samples / samplesPerUnit);
		} else {
			played = asm.emittedCount;
		}
		return { received, played };
	};

	const sendJson = (obj) => {
		const ws = state.ws;
		if (!ws || ws.readyState !== 1) return false;
		try {
			ws.send(JSON.stringify(obj));
			return true;
		} catch (cause) {
			state.lastError = state.lastError ?? cause;
			return false;
		}
	};

	const sendAck = () => {
		const { received, played } = currentSeqs();
		if (sendJson({ event: "ack", received_seq: received, played_seq: played })) {
			state.ackCount++;
		}
		return { received, played };
	};

	const overallTimer = setTimeout(() => {
		const where = state.ready
			? state.firstFrameAt
				? "收完 ready 和部分帧后卡住了"
				: "等第一帧音频等超了"
			: "等 ready 等超了";
		settle(
			transportError(
				`合成超时（${timeoutMs}ms，${where}）。已收到 ${asm.receivedCount} 帧 / ${asm.receivedBytes} 字节。`,
			),
			buildResult(),
		);
	}, timeoutMs);

	function onAbort() {
		sendJson({ event: "abort", reason: "user_cancelled" });
		const e = new Error("aborted");
		e.name = "AbortError";
		settle(e, buildResult());
	}

	if (signal) {
		if (signal.aborted) {
			onAbort();
			return done;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	function buildResult({ requestedFormat = format } = {}) {
		const audit = asm.audit();
		const actualFormat = state.ready?.format ?? requestedFormat;
		if (!audit.fullyEmitted) {
			warnings.push(
				`有 ${audit.pendingSeqs.length} 帧没能按顺序交给 onChunk（seq ${audit.pendingSeqs
					.slice(0, 10)
					.join(", ")}）—— 首帧乱序导致的，最终 buffer 不受影响，但流式消费会少拿这几帧`,
			);
		}
		const result = {
			audio: audit.audio,
			bytes: audit.audio.length,
			format: actualFormat,
			requestedFormat,
			voiceId: state.ready?.voice_id ?? voice ?? null,
			audioId: state.ready?.audio_id ?? null,
			traceId: state.ready?.trace_id ?? null,
			frameCount: audit.receivedCount,
			firstSeq: audit.firstSeq,
			lastSeq: audit.lastSeq,
			missingSeqs: audit.missing,
			duplicates: audit.duplicates,
			outOfOrder: audit.outOfOrder,
			contiguous: audit.contiguous,
			fullyEmitted: audit.fullyEmitted,
			acksSent: state.ackCount,
			events,
			finish: state.finish,
			ticket: { expiresInSecs: ticketInfo.expiresInSecs },
			url: redactUrl(url),
			sessionId,
			messageId,
			warnings,
			closeInfo: state.closeInfo,
		};
		if (actualFormat === "pcm") {
			const samples = Math.floor(audit.audio.length / (PCM.bitsPerSample / 8) / PCM.channels);
			result.sampleRate = PCM.sampleRate;
			result.channels = PCM.channels;
			result.bitsPerSample = PCM.bitsPerSample;
			result.samples = samples;
			result.durationSec = samples / PCM.sampleRate;
		}
		return result;
	}

	const handleTextFrame = (data) => {
		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			warnings.push(`收到非 JSON 的文本帧：${String(data).slice(0, 120)}`);
			return;
		}
		events.push(msg);
		if (typeof onEvent === "function") onEvent(msg);

		if (msg.event === "ready") {
			state.ready = msg;
			if (Object.prototype.hasOwnProperty.call(msg, "format") && msg.format !== format) {
				warnings.push(`服务端把 format 从 ${format} 改成了 ${msg.format}，按服务端的来`);
			}
			sendAck();
			return;
		}

		if (msg.event === "finish") {
			state.finish = msg;
			sendJson({ event: "finish" });
			const result = buildResult();
			if (msg.code !== ErrorCode.SUCCESS) {
				settle(
					protocolError(
						`服务端 finish 带错误码：code=${msg.code}(${codeName(msg.code)}) msg=${msg.msg ?? ""}`.trim(),
						msg.code,
						{ raw: msg },
					),
					result,
				);
				return;
			}
			if (!result.audio.length) {
				settle(protocolError("合成结束但一帧音频都没有", msg.code, { raw: msg }), result);
				return;
			}
			if (!result.contiguous) {
				settle(
					transportError(
						`帧不连续：共 ${result.frameCount} 帧，缺 seq [${result.missingSeqs.slice(0, 20).join(", ")}` +
							`${result.missingSeqs.length > 20 ? ", ..." : ""}]${result.missingSeqs.length ? "" : "（有帧一直没等到）"}`,
					),
					result,
				);
				return;
			}
			settle(null, result);
			return;
		}
	};

	const handleBinaryFrame = async (data) => {
		let buf = data;
		if (typeof Blob !== "undefined" && data instanceof Blob) {
			buf = await data.arrayBuffer();
		}
		let parsed;
		try {
			parsed = parseAudioFrame(buf);
		} catch (err) {
			settle(err, buildResult());
			return;
		}

		const pushed = asm.push(parsed.seq, Buffer.from(parsed.payload));

		if (!state.firstFrameAt) {
			state.firstFrameAt = Date.now();
			state.ackTimer = setInterval(sendAck, ackIntervalMs);
			if (typeof state.ackTimer?.unref === "function") state.ackTimer.unref();
		}

		if (!pushed.accepted) {
			log(`重复帧 seq=${parsed.seq}，丢掉`);
			return;
		}
		for (const chunk of pushed.emitted) {
			if (typeof onChunk === "function") onChunk(chunk, { seq: parsed.seq, format: state.ready?.format ?? format });
		}
	};

	let ws;
	const wsHeaders = {
		Origin: origin || "https://chat.deepseek.com",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	};
	try {
		ws = new webSocketImpl(url, { headers: wsHeaders });
	} catch {
		try {
			ws = new webSocketImpl(url);
		} catch (cause) {
			settle(transportError(`建 ws 失败（${redactUrl(url)}）：${cause?.message ?? cause}`, { cause }));
			return done;
		}
	}
	state.ws = ws;

	try {
		ws.binaryType = "arraybuffer";
	} catch {}

	ws.onopen = () => log("ws 已连接");
	ws.onmessage = (ev) => {
		const data = ev?.data;
		if (typeof data === "string") {
			handleTextFrame(data);
		} else if (data !== undefined && data !== null) {
			handleBinaryFrame(data).catch((err) => settle(err, buildResult()));
		}
	};
	ws.onerror = (ev) => {
		state.lastError = ev?.error ?? ev?.message ?? new Error("websocket error");
	};
	ws.onclose = (ev) => {
		state.closeInfo = { code: ev?.code, reason: ev?.reason, wasClean: ev?.wasClean };
		if (state.settled) return;
		if (state.finish) return;
		const got = asm.receivedCount;
		const extra =
			ev?.code === 1006 || got === 0
				? "。1006 + 零帧最常见的原因是这张 ticket 已经用过一次了（票是一次性的），" + "或者服务端没放行这个会话/消息 id"
				: "";
		settle(
			transportError(
				`连接在收到 finish 之前断了：close code=${ev?.code}${ev?.reason ? ` reason=${ev.reason}` : ""}，` +
					`已收到 ${got} 帧 / ${asm.receivedBytes} 字节${extra}` +
					(state.lastError ? `；底层报错：${state.lastError.message ?? state.lastError}` : ""),
				{ closeInfo: state.closeInfo },
			),
			buildResult(),
		);
	};

	return done;
}

export async function synthesizeToWavBuffer(options = {}) {
	const result = await synthesize(options);
	if (result.format !== "pcm") {
		throw protocolError(`想要 wav 但服务端给的是 ${result.format}，WAV 只能从 pcm 封。`, ErrorCode.INVALID_INPUT);
	}
	const { pcmToWav } = await import("./wav.mjs");
	return { ...result, wav: pcmToWav(result.audio) };
}

export { sleep };
