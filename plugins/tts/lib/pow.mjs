import { HTTP_BASE } from "./constants.mjs";
import { DeepSeekTtsError, protocolError, transportError, usageError } from "./errors.mjs";
import { DEEPSEEK_HASH_NAME, deepseekHashHex } from "./deepseek-hash.mjs";
import { jsonHeaders } from "./http.mjs";

export const POW_HEADER = "X-DS-PoW-Response";
export const POW_TARGET_COMPLETION = "/api/v0/chat/completion";
export const POW_CHALLENGE_PATH = "/api/v0/chat/create_pow_challenge";

const DEFAULT_MAX_ITERATIONS = 5_000_000;

export function powPrefix({ salt, expireAt }) {
	return `${salt}_${expireAt}_`;
}

/**
 * 解 challenge。
 * @returns {{answer:number, iterations:number, elapsedMs:number, prefix:string}}
 */
export function solvePowChallenge(challenge, { maxIterations = DEFAULT_MAX_ITERATIONS, onProgress } = {}) {
	if (!challenge || typeof challenge !== "object") {
		throw usageError("solvePowChallenge 需要一个 challenge 对象");
	}
	const algorithm = challenge.algorithm ?? DEEPSEEK_HASH_NAME;
	if (algorithm !== DEEPSEEK_HASH_NAME) {
		throw protocolError(`不认识的 PoW 算法 "${algorithm}"，本包只实现了 ${DEEPSEEK_HASH_NAME}`, undefined, {
			challenge,
		});
	}
	const { challenge: target, salt, difficulty } = challenge;
	const expireAt = challenge.expireAt ?? challenge.expire_at;
	if (typeof target !== "string" || !target)
		throw protocolError("challenge 里没有 challenge 字段", undefined, { challenge });
	if (salt === undefined || salt === null) throw protocolError("challenge 里没有 salt 字段", undefined, { challenge });
	if (expireAt === undefined || expireAt === null)
		throw protocolError("challenge 里没有 expire_at 字段", undefined, { challenge });
	if (!Number.isSafeInteger(difficulty) || difficulty <= 0) {
		throw protocolError(
			`challenge 的 difficulty 必须是正整数（它是搜索上界），收到 ${JSON.stringify(difficulty)}`,
			undefined,
			{ challenge },
		);
	}

	const prefix = powPrefix({ salt, expireAt });
	const started = Date.now();
	const limit = Math.min(difficulty, maxIterations);

	for (let i = 0; i < limit; i++) {
		if (deepseekHashHex(prefix + i) === target) {
			return { answer: i, iterations: i + 1, elapsedMs: Date.now() - started, prefix };
		}
		if (onProgress && i > 0 && i % 20000 === 0) {
			onProgress({ tried: i, limit, elapsedMs: Date.now() - started });
		}
	}

	throw new DeepSeekTtsError(
		`PoW 没解出来：在 ${limit} 次迭代里没找到答案` +
			`${limit < difficulty ? `（服务端给的上界是 ${difficulty}，被 maxIterations=${maxIterations} 截断了）` : ""}。` +
			`target=${target.slice(0, 16)}… salt=${salt} difficulty=${difficulty}`,
		{ kind: "protocol", details: { prefix, target, difficulty, limit } },
	);
}

export function buildPowHeader(challenge, answer, targetPath, encode = defaultBase64) {
	const payload = {
		algorithm: challenge.algorithm ?? DEEPSEEK_HASH_NAME,
		challenge: challenge.challenge,
		salt: challenge.salt,
		answer,
		signature: challenge.signature,
		target_path: targetPath,
	};
	return [POW_HEADER, encode(JSON.stringify(payload))];
}

export function defaultBase64(str) {
	return Buffer.from(str, "utf8").toString("base64");
}

export async function fetchPowChallenge({
	targetPath = POW_TARGET_COMPLETION,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
} = {}) {
	const url = `${baseUrl}${POW_CHALLENGE_PATH}`;
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: jsonHeaders(token),
			body: JSON.stringify({ target_path: targetPath }),
			signal,
		});
	} catch (cause) {
		if (cause?.name === "AbortError") throw cause;
		throw transportError(`取 PoW challenge 失败：${cause?.message ?? cause}`, { cause });
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw protocolError(`POST ${url} 返回的不是 JSON（HTTP ${res.status}）`, undefined, {
			status: res.status,
			body: text.slice(0, 400),
		});
	}
	const data = json?.data ?? {};
	const bizCode = data.biz_code;
	if (json.code !== 0 || bizCode !== 0) {
		throw new DeepSeekTtsError(
			`取 PoW challenge 被拒：code=${json.code} biz_code=${bizCode} ${data.biz_msg ?? json.msg ?? ""}`.trim(),
			{ kind: "protocol", code: bizCode ?? json.code, details: json },
		);
	}
	const challenge = data?.biz_data?.challenge;
	if (!challenge || typeof challenge !== "object") {
		throw protocolError("create_pow_challenge 返回里没有 biz_data.challenge", undefined, { raw: json });
	}
	return challenge;
}

export async function obtainPowHeader({
	targetPath = POW_TARGET_COMPLETION,
	token,
	signal,
	fetchImpl = globalThis.fetch,
	baseUrl = HTTP_BASE,
	maxIterations,
	onProgress,
	encode,
} = {}) {
	const t0 = Date.now();
	const challenge = await fetchPowChallenge({ targetPath, token, signal, fetchImpl, baseUrl });
	const solved = solvePowChallenge(challenge, { ...(maxIterations ? { maxIterations } : {}), onProgress });
	const header = buildPowHeader(challenge, solved.answer, targetPath, encode);
	return {
		header,
		challenge,
		answer: solved.answer,
		iterations: solved.iterations,
		solveMs: solved.elapsedMs,
		totalMs: Date.now() - t0,
		prefix: solved.prefix,
	};
}
