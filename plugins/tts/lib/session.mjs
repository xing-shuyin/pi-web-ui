import { ENDPOINTS, HTTP_BASE } from "./constants.mjs";
import { DeepSeekTtsError, protocolError, transportError, usageError } from "./errors.mjs";
import { assertToken, jsonHeaders } from "./http.mjs";
import { POW_TARGET_COMPLETION, obtainPowHeader } from "./pow.mjs";
import { redactUrl, synthesize } from "./tts.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 700;

const REPEAT_TEMPLATES = [
	(t) => `请原样复述下面这段话，不要任何改动、翻译或前后缀：\n\n${t}`,
	(t) => `请直接复述以下内容，不添加任何评论或说明：\n\n${t}`,
	(t) => `请把下面这段文字原样输出一遍，不要加任何前后缀：\n\n${t}`,
	(t) => `请完整复述以下文本内容，保持原文不变：\n\n${t}`,
	(t) => `请将下列内容原文字符完整复述输出：\n\n${t}`,
];

export function buildRepeatPrompt(text) {
	const fn = REPEAT_TEMPLATES[Math.floor(Math.random() * REPEAT_TEMPLATES.length)] || REPEAT_TEMPLATES[0];
	return fn(text);
}

export async function createSession({
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
	const t = assertToken(token);
	const url = `${baseUrl}${ENDPOINTS.sessionCreate}`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: jsonHeaders(t),
			body: JSON.stringify({}),
			signal: composite,
		});
	} catch (cause) {
		if (cause?.name === "AbortError") {
			if (signal?.aborted) throw cause;
			throw transportError(`建会话超时（${timeoutMs}ms）`);
		}
		throw transportError(`建会话失败：${cause?.message ?? cause}`, { cause });
	} finally {
		clearTimeout(timer);
	}

	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw protocolError(`建会话返回的不是 JSON（HTTP ${res.status}）`, undefined, {
			status: res.status,
			body: text.slice(0, 400),
		});
	}
	const data = json?.data ?? {};
	const biz = data?.biz_data ?? {};
	if (json.code !== 0 || data.biz_code !== 0) {
		throw new DeepSeekTtsError(
			`建会话被拒：code=${json.code} biz_code=${data.biz_code} ${data.biz_msg ?? json.msg ?? ""}`.trim(),
			{ kind: "protocol", code: data.biz_code ?? json.code, details: json },
		);
	}
	const id = biz?.id ?? biz?.chat_session?.id;
	if (!id) {
		throw protocolError("建会话返回里没找到会话 id（试过 biz_data.id 和 biz_data.chat_session.id）", undefined, {
			raw: json,
		});
	}
	return { id, title: biz?.title ?? biz?.chat_session?.title ?? null, raw: json };
}

export async function deleteSession({
	sessionIds,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
	const t = assertToken(token);
	const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
	if (!ids.length || ids.some((i) => !i)) throw usageError("deleteSession 需要至少一个 sessionId");
	const url = `${baseUrl}${ENDPOINTS.sessionDelete}`;
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: jsonHeaders(t),
			body: JSON.stringify({ chat_session_ids: ids }),
			signal,
		});
		const json = JSON.parse(await res.text());
		const bizCode = json?.data?.biz_code;
		return { ok: bizCode === 0, bizCode, raw: json };
	} catch (cause) {
		return { ok: false, bizCode: undefined, error: cause?.message ?? String(cause) };
	}
}

export async function fetchMessages({
	sessionId,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
	const t = assertToken(token);
	if (!sessionId) throw usageError("fetchMessages 需要 sessionId");
	const url = `${baseUrl}${ENDPOINTS.historyMessages}?chat_session_id=${encodeURIComponent(sessionId)}`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
	let res;
	try {
		res = await fetchImpl(url, { method: "GET", headers: jsonHeaders(t), signal: composite });
	} catch (cause) {
		if (cause?.name === "AbortError") {
			if (signal?.aborted) throw cause;
			throw transportError(`拉消息列表超时（${timeoutMs}ms）`);
		}
		throw transportError(`拉消息列表失败：${cause?.message ?? cause}`, { cause });
	} finally {
		clearTimeout(timer);
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw protocolError(`拉消息列表返回的不是 JSON（HTTP ${res.status}）`, undefined, {
			status: res.status,
			body: text.slice(0, 400),
		});
	}
	const data = json?.data ?? {};
	if (json.code !== 0 || data.biz_code !== 0) {
		throw new DeepSeekTtsError(
			`拉消息列表被拒：code=${json.code} biz_code=${data.biz_code} ${data.biz_msg ?? ""}`.trim(),
			{ kind: "protocol", code: data.biz_code ?? json.code, details: json },
		);
	}
	const messages = data?.biz_data?.chat_messages;
	if (!Array.isArray(messages)) {
		throw protocolError("history_messages 返回里没有 biz_data.chat_messages 数组", undefined, { raw: json });
	}
	return { messages, cacheControl: data.biz_data.cache_control ?? null, raw: json };
}

export function messageText(m) {
	if (Array.isArray(m?.fragments) && m.fragments.length > 0) {
		const txt = m.fragments
			.map((f) => f?.content ?? "")
			.join("")
			.trim();
		if (txt) return txt;
	}
	const c = m?.content ?? m?.text;
	if (typeof c === "string") return c;
	if (c === null || c === undefined) return "";
	return JSON.stringify(c);
}

export function pickMessage(messages, { prompt }) {
	const list = messages.filter((m) => m && (m.message_id || m.id));
	const wanted = String(prompt ?? "").trim();
	const replies = list.filter((m) => {
		if (m?.role === "ASSISTANT") return true;
		const txt = messageText(m).trim();
		return txt.length > 0 && txt !== wanted;
	});
	return replies.length ? replies[replies.length - 1] : null;
}

export function messageIdOf(m) {
	return m?.message_id ?? m?.id ?? null;
}

export async function postCompletion({
	sessionId,
	parentMessageId = null,
	prompt,
	powHeader,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	modelType = null,
	thinkingEnabled = false,
	searchEnabled = false,
	extraHeaders = {},
} = {}) {
	const t = assertToken(token);
	if (!sessionId) throw usageError("postCompletion 需要 sessionId");
	if (typeof prompt !== "string" || !prompt) throw usageError("postCompletion 需要非空 prompt");
	if (!powHeader) throw usageError("postCompletion 需要 powHeader（completion 不接受没有 PoW 的请求）");

	const body = {
		chat_session_id: sessionId,
		parent_message_id: parentMessageId,
		model_type: modelType,
		prompt,
		ref_file_ids: [],
		thinking_enabled: thinkingEnabled,
		search_enabled: searchEnabled,
		source: null,
		action: null,
		preempt: false,
	};

	const headers = {
		...jsonHeaders(t),
		accept: "text/event-stream",
		[powHeader[0]]: powHeader[1],
		...extraHeaders,
	};

	const url = `${baseUrl}${ENDPOINTS.completion}`;
	try {
		return await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
	} catch (cause) {
		if (cause?.name === "AbortError") throw cause;
		throw transportError(`发 completion 失败：${cause?.message ?? cause}`, { cause });
	}
}

export async function drainSse(res, { onChunk, maxBytes = 8 * 1024 * 1024 } = {}) {
	const out = { bytes: 0, chunks: 0, text: "", truncated: false, error: null };
	if (!res?.body) return out;
	try {
		const decoder = new TextDecoder();
		for await (const chunk of res.body) {
			out.bytes += chunk.byteLength;
			out.chunks++;
			if (out.text.length < 200_000) out.text += decoder.decode(chunk, { stream: true });
			if (onChunk) onChunk(chunk);
			if (out.bytes > maxBytes) {
				out.truncated = true;
				break;
			}
		}
	} catch (cause) {
		if (cause?.name === "AbortError") return out;
		out.error = cause?.message ?? String(cause);
	}
	return out;
}

export async function putText({
	text,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	pollIntervalMs = POLL_INTERVAL_MS,
	maxIterations,
	extraHeaders = {},
	keepOnError = false,
	onProgress = () => {},
} = {}) {
	const t = assertToken(token);
	if (typeof text !== "string" || !text.trim()) throw usageError("putText 需要非空 text");

	const prompt = buildRepeatPrompt(text);
	const session = await createSession({ token: t, signal, fetchImpl, baseUrl });
	const sessionId = session.id;
	onProgress({ step: "session", sessionId });

	let aborted = false;
	const ac = new AbortController();
	const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

	const cleanupAbort = () => {
		if (!aborted) {
			aborted = true;
			ac.abort();
		}
	};

	try {
		onProgress({ step: "pow" });
		const pow = await obtainPowHeader({
			targetPath: POW_TARGET_COMPLETION,
			token: t,
			signal: composite,
			fetchImpl,
			baseUrl,
			...(maxIterations ? { maxIterations } : {}),
		});
		onProgress({ step: "pow-done", answer: pow.answer, solveMs: pow.solveMs, totalMs: pow.totalMs });

		onProgress({ step: "completion" });
		const res = await postCompletion({
			sessionId,
			prompt,
			powHeader: pow.header,
			token: t,
			signal: composite,
			fetchImpl,
			baseUrl,
			extraHeaders,
		});

		if (!res.ok) {
			const bodyText = await res.text().catch(() => "");
			throw protocolError(`completion 返回 HTTP ${res.status}：${bodyText.slice(0, 300)}`, undefined, {
				status: res.status,
			});
		}

		const drainPromise = drainSse(res, {});

		const deadline = Date.now() + waitTimeoutMs;
		let picked = null;
		let lastSeen = [];
		while (Date.now() < deadline) {
			const { messages } = await fetchMessages({ sessionId, token: t, signal, fetchImpl, baseUrl });
			lastSeen = messages.map((m) => ({
				id: messageIdOf(m),
				role: m?.role,
				len: messageText(m).length,
				parent: m?.parent_id ?? null,
			}));
			picked = pickMessage(messages, { prompt });
			if (picked) {
				const textNow = messageText(picked).trim();
				if (textNow) {
					await new Promise((r) => setTimeout(r, pollIntervalMs));
					const again = await fetchMessages({ sessionId, token: t, signal, fetchImpl, baseUrl });
					const picked2 = pickMessage(again.messages, { prompt });
					if (picked2 && messageText(picked2).trim() === textNow) {
						picked = picked2;
						break;
					}
					picked = picked2 ?? picked;
					continue;
				}
			}
			await new Promise((r) => setTimeout(r, pollIntervalMs));
		}

		if (!picked) {
			cleanupAbort();
			await drainPromise;
			throw transportError(
				`等了 ${waitTimeoutMs}ms 也没在会话 ${sessionId} 里等到模型的回复。` +
					`会话里现在有 ${lastSeen.length} 条：${JSON.stringify(lastSeen)}`,
				{ sessionId, messages: lastSeen },
			);
		}

		const messageId = messageIdOf(picked);
		if (!messageId) {
			throw protocolError("选中的消息没有 message_id（也没 id），字段名可能变了", undefined, {
				message: picked,
			});
		}

		const drained = await drainPromise;
		onProgress({ step: "message", messageId, streamBytes: drained.bytes, streamError: drained.error });

		return {
			sessionId,
			messageId,
			prompt,
			text,
			content: messageText(picked),
			pow: { answer: pow.answer, solveMs: pow.solveMs, iterations: pow.iterations },
		};
	} catch (err) {
		cleanupAbort();
		if (!keepOnError) {
			const del = await deleteSession({ sessionIds: sessionId, token: t, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
			if (del.ok) {
				err.cleanedUp = true;
			} else {
				err.cleanedUp = false;
				err.cleanupError = del.error ?? `biz_code=${del.bizCode}`;
			}
		}
		throw err;
	}
}

export async function say({
	text,
	format = "pcm",
	voice,
	token,
	keepSession = false,
	signal,
	fetchImpl = globalThis.fetch,
	webSocketImpl = globalThis.WebSocket,
	baseUrl,
	wsEndpoint,
	maxIterations,
	waitTimeoutMs,
	ackMode,
	onProgress = () => {},
	log = () => {},
} = {}) {
	const t = assertToken(token);
	const ttsOptions = {
		format,
		token: t,
		fetchImpl,
		webSocketImpl,
		log,
		...(voice ? { voice } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(wsEndpoint ? { endpoint: wsEndpoint } : {}),
		...(ackMode ? { ackMode } : {}),
	};

	let sessionId = null;
	try {
		const placed = await putText({
			text,
			token: t,
			signal,
			fetchImpl,
			...(baseUrl ? { baseUrl } : {}),
			...(waitTimeoutMs ? { waitTimeoutMs } : {}),
			...(maxIterations ? { maxIterations } : {}),
			onProgress,
		});
		sessionId = placed.sessionId;

		const result = await synthesize({
			sessionId: placed.sessionId,
			messageId: placed.messageId,
			...ttsOptions,
		});

		return {
			...result,
			scratch: {
				sessionId: placed.sessionId,
				messageId: placed.messageId,
				prompt: placed.prompt,
				content: placed.content,
				pow: placed.pow,
				kept: keepSession,
			},
		};
	} finally {
		if (sessionId && !keepSession) {
			const del = await deleteSession({ sessionIds: sessionId, token: t, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
			log(
				del.ok
					? `已删掉临时会话 ${sessionId}`
					: `临时会话 ${sessionId} 没删掉（${del.error ?? del.bizCode}），自己留意一下`,
			);
		} else if (sessionId && keepSession) {
			log(`保留了临时会话 ${sessionId}`);
		}
	}
}

export { redactUrl };
