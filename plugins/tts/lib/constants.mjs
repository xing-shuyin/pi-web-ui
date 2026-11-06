export const HOST = "chat.deepseek.com";

export const HTTP_BASE = `https://${HOST}`;

export const WS_ENDPOINT = `wss://${HOST}/api/v0/chat/tts/`;

export const ENDPOINTS = Object.freeze({
	ticket: "/api/v0/auth/ticket",
	voices: "/api/v0/chat/tts/voices",
	voice: "/api/v0/chat/tts/voice",
	sessionCreate: "/api/v0/chat_session/create",
	sessionDelete: "/api/v0/chat_session/delete",
	historyMessages: "/api/v0/chat/history_messages",
	completion: "/api/v0/chat/completion",
	powChallenge: "/api/v0/chat/create_pow_challenge",
});

export const WS_MODE = "manual";

export const FORMATS = Object.freeze(["pcm", "opus"]);

export const PCM = Object.freeze({
	sampleRate: 24000,
	channels: 1,
	bitsPerSample: 16,
});

export const PLAYED_SEQ_UNIT_MS = 100;

const TICKET_TTL_SECONDS = 600;

export const VOICES = Object.freeze([
	Object.freeze({
		id: "mira",
		name: "贝壳",
		nameEn: "Mira",
		gender: "female",
		descriptionEn: "Versatile & Playful",
		description: "百变活泼",
		languageCount: 29,
		isDefault: true,
		demoUrls: Object.freeze({
			zh: "https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3",
		}),
	}),
	Object.freeze({
		id: "echo",
		name: "白浪",
		nameEn: "Echo",
		gender: "male",
		descriptionEn: "Bright & Confident",
		description: "明朗坚定",
		languageCount: 29,
		isDefault: false,
		demoUrls: Object.freeze({}),
	}),
	Object.freeze({
		id: "stella",
		name: "海星",
		nameEn: "Stella",
		gender: "female",
		descriptionEn: "Sweet & Lively",
		description: "俏皮甜美",
		languageCount: 10,
		isDefault: false,
		demoUrls: Object.freeze({}),
	}),
	Object.freeze({
		id: "tide",
		name: "暗潮",
		nameEn: "Tide",
		gender: "male",
		descriptionEn: "Deep & Rich",
		description: "低沉浑厚",
		languageCount: 10,
		isDefault: false,
		demoUrls: Object.freeze({
			zh: "https://cdn.deepseek.com/chat/tts/voice-demos/tide_zh.42b17eef.mp3",
		}),
	}),
]);

const VOICE_IDS = Object.freeze(VOICES.map((v) => v.id));

const SHORT_LANGUAGE_CODES = Object.freeze(["ar", "en", "id", "ja", "ko", "ms", "th", "vi", "yue", "zh"]);

export function getVoice(id) {
	if (typeof id !== "string") return undefined;
	const key = id.trim().toLowerCase();
	return VOICES.find((v) => v.id === key);
}

export const FRAME_HEADER_BYTES = 4;
