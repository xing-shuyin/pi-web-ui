import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TTS_SETTINGS,
	MAX_TTS_CHARS,
	assistantPlainText,
	isSpeaking,
	isTtsAvailable,
	loadTtsSettings,
	onSpeakingChange,
	speakingSourceId,
	saveTtsSettings,
	speak,
	stopSpeaking,
	stripMarkdownForSpeech,
	type TtsSettings,
} from "../../web/src/tts.js";

function stubLocalStorage(): Map<string, string> {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
		setItem: (k: string, v: string) => {
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
		clear: () => {
			store.clear();
		},
	});
	return store;
}

const { providerPlay, providerStop } = vi.hoisted(() => ({ providerPlay: vi.fn(), providerStop: vi.fn() }));
vi.mock("../../web/src/tts-client", () => ({ getPluginTtsProvider: (id: string) => ({ id, play: providerPlay }) }));

beforeEach(() => {
	stubLocalStorage();
	providerPlay.mockReset().mockImplementation(() => providerStop);
	providerStop.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	stopSpeaking();
});

describe("stripMarkdownForSpeech", () => {
	it("drops fenced code blocks entirely and keeps surrounding prose", () => {
		const out = stripMarkdownForSpeech("before\n```js\nconst x = 1;\n```\nafter");
		expect(out).toBe("before after");
	});

	it("drops an unterminated fenced code block too", () => {
		const out = stripMarkdownForSpeech("prose\n```\nnever closed");
		expect(out).toBe("prose");
	});

	it("keeps inline code content but drops backticks", () => {
		expect(stripMarkdownForSpeech("run `npm ci` now")).toBe("run npm ci now");
	});

	it("collapses links to their text and drops images", () => {
		expect(stripMarkdownForSpeech("see [docs](https://x.y) and ![pic](a.png)")).toBe("see docs and");
	});

	it("strips headings, emphasis, blockquotes and list bullets", () => {
		const md = "## Title\n**bold** and *it* and _u_\n> quoted\n- item one\n* item two";
		const out = stripMarkdownForSpeech(md);
		expect(out).not.toContain("#");
		expect(out).toContain("Title");
		expect(out).toContain("bold");
		expect(out).not.toContain("**");
		expect(out).toContain("quoted");
		expect(out).toContain("item one");
		expect(out).not.toContain("-");
	});

	it("drops table separator rows and pipes", () => {
		const out = stripMarkdownForSpeech("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(out).not.toContain("|");
		expect(out).not.toContain("---");
		expect(out).toContain("a");
		expect(out).toContain("1");
	});

	it("caps output at MAX_TTS_CHARS with an ellipsis", () => {
		const long = "字".repeat(MAX_TTS_CHARS + 100);
		const out = stripMarkdownForSpeech(long);
		expect(out.length).toBe(MAX_TTS_CHARS + 1);
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns empty string for empty input", () => {
		expect(stripMarkdownForSpeech("")).toBe("");
		expect(stripMarkdownForSpeech("```js\n```\n")).toBe("");
	});
});

describe("assistantPlainText", () => {
	it("takes the LAST assistant message and only its text blocks", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [{ type: "text", text: "question" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "secret reasoning" },
					{ type: "text", text: "final **answer**" },
				],
			},
		];
		expect(assistantPlainText(msgs)).toBe("final answer");
	});

	it("returns empty for no messages / no assistant message", () => {
		expect(assistantPlainText(undefined)).toBe("");
		expect(assistantPlainText(null)).toBe("");
		expect(assistantPlainText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("");
	});

	it("strips markdown from the reply", () => {
		const msgs = [{ role: "assistant", content: [{ type: "text", text: "# Title\n```\ncode\n```\ndone" }] }];
		expect(assistantPlainText(msgs)).toBe("Title done");
	});
});

describe("tts settings persistence", () => {
	it("clears browser-only system voice IDs while retaining plugin selections", () => {
		const store = stubLocalStorage();
		store.set("pi-web-tts", JSON.stringify({ engine: "builtin", voiceURI: "browser-voice", enabled: true, rate: 1.3 }));
		expect(loadTtsSettings()).toMatchObject({ voiceURI: "", enabled: true, rate: 1.3 });
		store.set("pi-web-tts", JSON.stringify({ engine: "doubao-tts", voiceURI: "taozi" }));
		expect(loadTtsSettings()).toMatchObject({ voiceURI: "taozi", engine: "doubao-tts" });
	});
	it("returns defaults when nothing is stored", () => {
		expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
	});

	it("returns defaults on corrupted JSON", () => {
		localStorage.setItem("pi-web-tts", "{not json");
		expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
	});

	it("sanitizes out-of-range and wrong-typed values", () => {
		localStorage.setItem("pi-web-tts", JSON.stringify({ enabled: "yes", rate: 99, voiceURI: 42, announce: false }));
		const s = loadTtsSettings();
		expect(s.enabled).toBe(DEFAULT_TTS_SETTINGS.enabled);
		expect(s.rate).toBe(2);
		expect(s.voiceURI).toBe("");
		expect(s.announce).toBe(false);
	});

	it("round-trips through saveTtsSettings", () => {
		const s: TtsSettings = {
			enabled: true,
			announce: true,
			readReplies: true,
			streamReplies: true,
			rate: 1.3,
			voiceURI: "v1",
			engine: "builtin",
		};
		saveTtsSettings(s);
		expect(loadTtsSettings()).toEqual(s);
	});
});

describe("speak and speaking state", () => {
	it("requires audio playback and fetch rather than browser speech synthesis", () => {
		vi.stubGlobal("Audio", class {});
		expect(isTtsAvailable()).toBe(true);
		vi.stubGlobal("Audio", undefined);
		expect(isTtsAvailable()).toBe(false);
	});
	it("sends builtin and plugin engines through the same provider with the selected voice and rate", () => {
		speak("你好", { ...DEFAULT_TTS_SETTINGS, enabled: false, rate: 1.5, voiceURI: "zh-voice" });
		expect(providerPlay).toHaveBeenCalledWith(
			expect.objectContaining({ text: "你好", rate: 1.5, voiceURI: "zh-voice" }),
		);
	});
	it("tracks source and clears speaking state after completion or error", () => {
		const listener = vi.fn();
		const off = onSpeakingChange(listener);
		speak("hello", DEFAULT_TTS_SETTINGS, "msg-1");
		expect(isSpeaking()).toBe(true);
		expect(speakingSourceId()).toBe("msg-1");
		providerPlay.mock.calls.at(-1)![0].onEnd();
		expect(isSpeaking()).toBe(false);
		expect(speakingSourceId()).toBeNull();
		speak("again");
		providerPlay.mock.calls.at(-1)![0].onError(new Error("unavailable"));
		expect(isSpeaking()).toBe(false);
		expect(listener).toHaveBeenCalledWith(false);
		off();
	});
	it("cancels the previous audio before a new reply or explicit stop", () => {
		speak("first", DEFAULT_TTS_SETTINGS, "a");
		speak("second", DEFAULT_TTS_SETTINGS, "b");
		expect(providerStop).toHaveBeenCalledTimes(1);
		expect(speakingSourceId()).toBe("b");
		stopSpeaking();
		expect(providerStop).toHaveBeenCalledTimes(2);
		expect(isSpeaking()).toBe(false);
	});
});
