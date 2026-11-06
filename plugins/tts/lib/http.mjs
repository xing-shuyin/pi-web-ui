import { ENDPOINTS, HTTP_BASE, VOICES, getVoice } from "./constants.mjs";
import { DeepSeekTtsError, authError, codeHint, codeName, protocolError, usageError } from "./errors.mjs";

export const TOKEN_ENV = "DS_TOKEN";

export function jsonHeaders(token, extra = {}) {
	const h = {
		"content-type": "application/json",
		accept: "*/*",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
		origin: "https://chat.deepseek.com",
		referer: "https://chat.deepseek.com/",
		"sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		"user-agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
		...extra,
	};
	if (token) h.authorization = `Bearer ${token}`;
	return h;
}

export function resolveToken(explicit, env = process.env) {
	const t = explicit ?? env?.[TOKEN_ENV] ?? null;
	if (t === null || t === undefined) return null;
	const s = String(t).trim();
	return s.length ? s : null;
}

function looksLikeToken(token) {
	return typeof token === "string" && token.length === 64;
}

export const MISSING_TOKEN_MESSAGE =
	"缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。" +
	"取 userToken 的办法见 README 的「上手」一节 —— 本包不会去读你的浏览器数据。";

export function assertToken(token) {
	if (!token) throw authError(MISSING_TOKEN_MESSAGE);
	return token;
}

function unwrap(json, { what }) {
	if (json === null || typeof json !== "object") {
		throw protocolError(`${what}: 服务端返回的不是 JSON 对象`, undefined, { raw: json });
	}
	if (json.code !== 0) {
		const isAuth = json.code === 40003;
		const msg = `${what} 失败：code=${json.code} ${json.msg ?? ""}`.trim();
		if (isAuth) {
			throw new DeepSeekTtsError(
				`${msg} —— token 无效或已过期（40003 INVALID_TOKEN）。重新从浏览器里取一个 userToken。`,
				{ kind: "auth", code: json.code, details: json },
			);
		}
		throw new DeepSeekTtsError(msg, { kind: "protocol", code: json.code, details: json });
	}
	return json.data ?? {};
}

async function postJson(url, body, { token, signal, fetchImpl }) {
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: jsonHeaders(token),
			body: JSON.stringify(body),
			signal,
		});
	} catch (cause) {
		if (cause?.name === "AbortError") throw cause;
		throw new DeepSeekTtsError(`请求 ${url} 失败：${cause?.message ?? cause}`, {
			kind: "network",
			cause,
		});
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw protocolError(`POST ${url} 返回的不是 JSON（HTTP ${res.status}）`, undefined, {
			status: res.status,
			body: text.slice(0, 500),
		});
	}
	return { res, json };
}

async function getJson(url, { token, signal, fetchImpl }) {
	let res;
	try {
		res = await fetchImpl(url, { method: "GET", headers: jsonHeaders(token), signal });
	} catch (cause) {
		if (cause?.name === "AbortError") throw cause;
		throw new DeepSeekTtsError(`请求 ${url} 失败：${cause?.message ?? cause}`, {
			kind: "network",
			cause,
		});
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw protocolError(`GET ${url} 返回的不是 JSON（HTTP ${res.status}）`, undefined, {
			status: res.status,
			body: text.slice(0, 500),
		});
	}
	return { res, json };
}

export async function issueTicket({ token, signal, fetchImpl = globalThis.fetch, baseUrl = HTTP_BASE } = {}) {
	const t = assertToken(token);
	const url = `${baseUrl}${ENDPOINTS.ticket}`;
	const { json } = await postJson(url, { scope: "tts" }, { token: t, signal, fetchImpl });
	const data = unwrap(json, { what: "取票" });

	const bizCode = data.biz_code;
	if (bizCode !== 0) {
		throw new DeepSeekTtsError(`取票被拒：biz_code=${bizCode}(${codeName(bizCode)}) ${data.biz_msg ?? ""}`.trim(), {
			kind: "protocol",
			code: bizCode,
			details: json,
		});
	}
	const ticket = data?.biz_data?.ticket;
	if (!ticket || typeof ticket !== "string") {
		throw protocolError("取票返回里没有 biz_data.ticket", undefined, { raw: json });
	}
	return {
		ticket,
		expiresInSecs: data.biz_data.expires_in_secs ?? null,
		bizCode,
		raw: json,
	};
}

export function normalizeVoice(v) {
	return {
		id: v?.voice_id,
		nameI18n: v?.name_i18n ?? {},
		descriptionI18n: v?.description_i18n ?? {},
		gender: v?.gender,
		languages: v?.languages ?? [],
		demoUrls: v?.demo_urls ?? {},
		isDefault: Boolean(v?.is_default),
	};
}

export async function listVoices({ token, signal, fetchImpl = globalThis.fetch, baseUrl = HTTP_BASE } = {}) {
	const t = assertToken(token);
	const url = `${baseUrl}${ENDPOINTS.voices}`;
	const { json } = await getJson(url, { token: t, signal, fetchImpl });
	const data = unwrap(json, { what: "拉音色列表" });
	const biz = data.biz_data ?? {};
	if (data.biz_code !== 0) {
		throw new DeepSeekTtsError(`拉音色列表被拒：biz_code=${data.biz_code}(${codeName(data.biz_code)})`, {
			kind: "protocol",
			code: data.biz_code,
			details: json,
		});
	}
	return {
		voices: (biz.voices ?? []).map(normalizeVoice),
		defaultVoiceId: biz.default_voice_id ?? null,
		currentVoiceId: biz.current_voice_id ?? null,
		raw: json,
	};
}

export async function setVoice({ voiceId, token, signal, fetchImpl = globalThis.fetch, baseUrl = HTTP_BASE } = {}) {
	const t = assertToken(token);
	if (!voiceId) throw usageError("setVoice 缺 voiceId");
	const url = `${baseUrl}${ENDPOINTS.voice}`;
	const { json } = await postJson(url, { voice_id: voiceId }, { token: t, signal, fetchImpl });
	const data = unwrap(json, { what: "切音色" });
	const bizCode = data.biz_code;
	if (bizCode !== 0) {
		const hint = bizCode === 1 ? "该音色已下线" : bizCode === 2 ? "参数错" : (codeHint(bizCode) ?? "");
		throw new DeepSeekTtsError(`切音色失败：biz_code=${bizCode} ${hint}`.trim(), {
			kind: "protocol",
			code: bizCode,
			details: json,
		});
	}
	return { code: bizCode, raw: json };
}

export async function resolveDemoUrl({
	voiceId,
	lang = "zh",
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
} = {}) {
	if (!voiceId) throw usageError("resolveDemoUrl 缺 voiceId");

	if (token) {
		const { voices } = await listVoices({ token, signal, fetchImpl, baseUrl });
		const hit = voices.find((v) => v.id === voiceId);
		if (!hit) {
			throw usageError(`账号可见的音色里没有 "${voiceId}"。有：${voices.map((v) => v.id).join(", ") || "(空)"}`);
		}
		const url = hit.demoUrls?.[lang];
		if (!url) {
			const have = Object.keys(hit.demoUrls ?? {});
			throw usageError(`音色 ${voiceId} 没有 ${lang} 的试听。它有：${have.length ? have.join(", ") : "(一个都没有)"}`);
		}
		return { url, source: "api" };
	}

	const local = getVoice(voiceId)?.demoUrls?.[lang];
	if (local) return { url: local, source: "builtin" };

	const known = [];
	for (const v of VOICES) {
		for (const [l, u] of Object.entries(v.demoUrls)) known.push(`${v.id}/${l}  ${u}`);
	}
	throw usageError(
		`没有登录态时我只有这几个实测过的试听地址：\n  ${known.join("\n  ")}\n` +
			`要听 ${voiceId}/${lang}，得带上 --token 或 DS_TOKEN 让程序去问官方音色接口。` +
			"CDN 文件名里带内容哈希（每个音色+语言一份，各不相同），没实测过的拼不出来。",
	);
}

async function fetchBinary(url, { signal, fetchImpl = globalThis.fetch, maxBytes } = {}) {
	let res;
	try {
		res = await fetchImpl(url, { method: "GET", signal });
	} catch (cause) {
		if (cause?.name === "AbortError") throw cause;
		throw new DeepSeekTtsError(`下载 ${url} 失败：${cause?.message ?? cause}`, {
			kind: "network",
			cause,
		});
	}
	if (!res.ok) {
		throw new DeepSeekTtsError(`下载 ${url} 失败：HTTP ${res.status}`, {
			kind: "network",
			details: { status: res.status },
		});
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (maxBytes && buf.length > maxBytes) {
		throw new DeepSeekTtsError(`下载 ${url} 超出 ${maxBytes} 字节上限`, { kind: "network" });
	}
	return {
		data: buf,
		contentType: res.headers.get("content-type") ?? null,
		status: res.status,
		url,
	};
}
