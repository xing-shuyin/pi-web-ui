import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(HERE, "config.json"), "utf8"));

const PORT = Number(config.port);
const history = [];
const MAX_HISTORY = 10;

function systemPrompt(emotion) {
	const list = config.emotions.join("、");
	const choice =
		emotion === "自动"
			? `根据对话内容自己挑一个最贴切的情绪，只能从【${list}】里选。`
			: `本次回复的情绪固定为「${emotion}」。`;
	return [
		config.persona,
		choice,
		`只输出一个 JSON 对象，格式：{"emotion":"开心","text":"我说的话"}。不要输出其它任何内容。`,
		`text 是准备念出来的话，20~${config.maxReplyChars ?? 60} 字，口语、简短、适合朗读；不要 Markdown、不要括号里的动作描写、不要表情符号。`,
	].join("\n");
}

function apiKey() {
	const llm = config.llm ?? {};
	return (
		process.env[llm.apiKeyEnv ?? "PI_VOICE_API_KEY"] ||
		process.env.DEEPSEEK_API_KEY ||
		process.env.OPENAI_API_KEY ||
		process.env.DASHSCOPE_API_KEY ||
		""
	);
}

async function callLlm(message, emotion) {
	const llm = config.llm ?? {};
	if (llm.mock || process.env.PI_VOICE_MOCK === "1") {
		return JSON.stringify({
			emotion: emotion === "自动" ? "开心" : emotion,
			text: "我是一条小肥鱼，今天心情还不错呢！",
		});
	}
	const key = apiKey();
	if (!key) {
		throw new Error(`未配置在线 API 密钥：请设置环境变量 ${llm.apiKeyEnv ?? "PI_VOICE_API_KEY"}`);
	}

	const body = {
		model: llm.model,
		temperature: Number(llm.temperature) || 0.85,
		max_tokens: 200,
		messages: [
			{ role: "system", content: systemPrompt(emotion) },
			...history.map((item) => ({ role: item.role, content: item.content })),
			{ role: "user", content: message },
		],
	};
	if (llm.jsonMode !== false) body.response_format = { type: "json_object" };

	const response = await fetch(`${String(llm.baseUrl).replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(`在线 API ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const data = await response.json();
	const content = data.choices?.[0]?.message?.content ?? "";
	if (!content.trim()) throw new Error("在线模型没有给出回复内容，请重试");
	return content;
}

function parseReply(raw, requestedEmotion) {
	let text = String(raw)
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");

	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				parsed = JSON.parse(match[0]);
			} catch {
				// 落到下面的纯文本兜底
			}
		}
	}

	if (parsed && typeof parsed.text === "string" && parsed.text.trim()) {
		// 用户手动指定的情绪优先，模型自己跑偏时也不覆盖。
		const wanted =
			requestedEmotion !== "自动"
				? requestedEmotion
				: config.emotions.includes(parsed.emotion)
					? parsed.emotion
					: "平静";
		return { text: parsed.text.trim(), emotion: wanted };
	}

	// 模型没按 JSON 输出时，把裸文本念出来，情绪用用户指定值兜底
	return {
		text: text.replace(/^["']|["']$/g, "").slice(0, 500),
		emotion: requestedEmotion === "自动" ? "平静" : requestedEmotion,
	};
}

/**
 * 把一句回复切成适合 GPU 短推理的片段：标点处断句、合并过短片段。
 * CosyVoice2 遇到 2~3 个 token 的片段会让声码器卷积报错，所以每段至少 6 字。
 */
function splitForSpeech(text) {
	const max = Number(config.tts.maxSegmentChars) || 20;
	const clean = text
		.replace(/[（）()【】\[\]《》<>]/g, "")
		.replace(/[！？!?]/g, "。")
		.replace(/\s+/g, " ")
		.trim();
	if (!clean) return [];

	const rough = clean
		.split(/(?<=[。；;，,、])/)
		.map((part) => part.trim())
		.filter(Boolean);
	const packed = [];
	for (const part of rough) {
		const last = packed.at(-1);
		if (last && last.length + part.length <= max) packed[packed.length - 1] = last + part;
		else packed.push(part);
	}
	const merged = [];
	for (const part of packed) {
		if (merged.length && part.length < 6) merged[merged.length - 1] += part;
		else merged.push(part);
	}
	return merged;
}

async function callTts(text, emotion) {
	// CosyVoice2 的文本分段遇到括号/尖括号会切出极短片段，导致声码器卷积报错。
	const spoken = text
		.replace(/[（）()【】\[\]《》<>]/g, "")
		.replace(/[！？!?]/g, "。")
		.replace(/\s+/g, " ")
		.trim();
	const template = config.tts.instructTemplate ?? "{emotion}";
	const instruct = template.replaceAll("{emotion}", emotion);
	const response = await fetch(`http://127.0.0.1:${config.ttsPort}/tts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			text: spoken,
			instruct,
			speed: Number(config.tts.speed) || 1.0,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		throw new Error(`TTS ${response.status}: ${await response.text()}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleChat(req, res) {
	const body = await readBody(req);
	const message = String(body.message ?? "").trim();
	if (!message) return sendJson(res, 400, { error: "说点什么吧" });
	const emotion = config.emotions.includes(body.emotion) ? body.emotion : "自动";

	try {
		const raw = await callLlm(message, emotion);
		const reply = parseReply(raw, emotion);
		history.push({ role: "user", content: message });
		history.push({ role: "assistant", content: reply.text });
		while (history.length > MAX_HISTORY * 2) history.shift();

		const segments = splitForSpeech(reply.text);
		const audios = [];
		let ttsError = null;
		// GPU 上严格串行：一次只合成一个短句，合成完释放缓存再排下一句。
		for (const segment of segments) {
			try {
				audios.push((await callTts(segment, reply.emotion)).toString("base64"));
			} catch (error) {
				ttsError = error.message;
				break;
			}
		}
		return sendJson(res, 200, {
			...reply,
			audio: audios[0] ?? null,
			audios,
			segments,
			ttsError,
		});
	} catch (error) {
		return sendJson(res, 502, { error: error.message });
	}
}

async function handleHealth(_req, res) {
	const probe = async (url) => {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
			return r.ok;
		} catch {
			return false;
		}
	};
	const tts = await probe(`http://127.0.0.1:${config.ttsPort}/health`);
	return sendJson(res, 200, {
		llm: Boolean(apiKey() || config.llm?.mock || process.env.PI_VOICE_MOCK === "1"),
		tts,
		model: config.llm?.model ?? "",
	});
}

// 一次只跑一轮：TTS 独占 GPU，并发会让它显存爆掉。
let chatQueue = Promise.resolve();

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
		if (req.method === "POST" && url.pathname === "/api/chat") {
			const task = chatQueue.then(() => handleChat(req, res));
			chatQueue = task.catch(() => {});
			return await task;
		}
		if (req.method === "POST" && url.pathname === "/api/reset") {
			history.length = 0;
			return sendJson(res, 200, { ok: true });
		}
		if (req.method === "GET" && url.pathname === "/api/health") {
			return await handleHealth(req, res);
		}
		if (req.method === "GET" && url.pathname === "/api/config") {
			return sendJson(res, 200, {
				emotions: config.emotions,
				model: config.llm?.model ?? "",
			});
		}
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end(await fs.readFile(path.join(HERE, "public", "index.html")));
		}
		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			res.writeHead(204);
			return res.end();
		}
		res.writeHead(404);
		res.end("Not Found");
	} catch (error) {
		sendJson(res, 500, { error: error.message });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`大肥鱼已就绪：http://127.0.0.1:${PORT}`);
});
