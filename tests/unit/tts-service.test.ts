import { describe, expect, it, vi } from "vitest";
import { TtsService, type TtsEngine } from "../../server/tts-service.js";

function engine(id = "test"): TtsEngine {
	return {
		id,
		label: id,
		getVoices: vi.fn(() => [{ id: "voice-1", label: "Voice 1", lang: "zh-CN" }]),
		synthesize: vi.fn(async () => ({ buffer: Buffer.from("audio"), format: "wav" as const })),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shared TTS engine center", () => {
	it("exposes the same engines, voices and synthesis contract to all callers", async () => {
		const center = new TtsService();
		const provider = engine("builtin");
		center.registerEngine("core", provider);
		expect(center.listEngines()).toEqual([{ id: "builtin", label: "builtin" }]);
		expect(await center.listVoices("builtin")).toEqual([{ id: "voice-1", label: "Voice 1", lang: "zh-CN" }]);
		const audio = await center.synthesize({ text: "  你好  ", voice: "voice-1", rate: 8 });
		expect(Buffer.from(audio.buffer).toString()).toBe("audio");
		expect(provider.synthesize).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你好",
				voice: "voice-1",
				rate: 2,
				engine: "builtin",
				signal: expect.any(AbortSignal),
			}),
		);
	});
	it("prevents engine replacement and disposes only the exact registration", () => {
		const center = new TtsService();
		const provider = engine();
		const off = center.registerEngine("a", provider);
		expect(() => center.registerEngine("b", engine())).toThrow(/already registered/);
		provider.id = "mutated";
		off();
		center.registerEngine("b", engine());
		off();
		expect(center.listEngines()).toHaveLength(1);
	});
	it("keeps per-engine requests in order and releases the queue after failures", async () => {
		const center = new TtsService();
		const provider = engine();
		const first = deferred<any>();
		vi.mocked(provider.synthesize)
			.mockImplementationOnce(() => first.promise)
			.mockRejectedValueOnce(new Error("failure"));
		center.registerEngine("plugin", provider);
		const a = center.synthesize({ engine: "test", text: "a" });
		const b = center.synthesize({ engine: "test", text: "b" });
		const expectB = expect(b).rejects.toThrow("failure");
		await vi.waitFor(() => expect(provider.synthesize).toHaveBeenCalledTimes(1));
		first.resolve({ buffer: Buffer.from("a"), format: "wav" });
		await a;
		await expectB;
		expect(await center.synthesize({ engine: "test", text: "c" })).toHaveProperty("format", "wav");
		expect(vi.mocked(provider.synthesize).mock.calls.map(([request]) => request.text)).toEqual(["a", "b", "c"]);
	});
	it("unloading an engine cancels running and queued synthesis and rejects future calls", async () => {
		const center = new TtsService();
		const provider = engine();
		vi.mocked(provider.synthesize).mockImplementation(() => new Promise(() => {}));
		const off = center.registerEngine("plugin", provider);
		const running = center.synthesize({ engine: "test", text: "running" });
		const queued = center.synthesize({ engine: "test", text: "queued" });
		const expected = [expect(running).rejects.toThrow(/unregistered/), expect(queued).rejects.toThrow(/unregistered/)];
		await vi.waitFor(() => expect(provider.synthesize).toHaveBeenCalledTimes(1));
		const signal = vi.mocked(provider.synthesize).mock.calls[0]![0].signal;
		off();
		await Promise.all(expected);
		expect(signal.aborted).toBe(true);
		expect(provider.synthesize).toHaveBeenCalledTimes(1);
		await expect(center.synthesize({ engine: "test", text: "new" })).rejects.toThrow(/unavailable/);
	});
	it("honors caller cancellation while queued without invoking its provider", async () => {
		const center = new TtsService();
		const provider = engine();
		const first = deferred<any>();
		vi.mocked(provider.synthesize).mockImplementationOnce(() => first.promise);
		center.registerEngine("p", provider);
		const a = center.synthesize({ engine: "test", text: "a" });
		const controller = new AbortController();
		const b = center.synthesize({ engine: "test", text: "b", signal: controller.signal });
		const expected = expect(b).rejects.toThrow(/cancel/);
		controller.abort(new Error("cancel"));
		await expected;
		first.resolve({ buffer: Buffer.from("ok"), format: "wav" });
		await a;
		await center.synthesize({ engine: "test", text: "c" });
		expect(vi.mocked(provider.synthesize).mock.calls.map(([request]) => request.text)).toEqual(["a", "c"]);
	});
	it("rejects invalid input and invalid audio before it can reach consumers", async () => {
		const center = new TtsService();
		const provider = engine();
		center.registerEngine("p", provider);
		await expect(center.synthesize({ engine: "test", text: "" })).rejects.toThrow(/empty/);
		await expect(center.synthesize({ engine: "test", text: "x".repeat(6001) })).rejects.toThrow(/6000/);
		expect(provider.synthesize).not.toHaveBeenCalled();
		vi.mocked(provider.synthesize).mockResolvedValueOnce({ buffer: new Uint8Array(), format: "wav" });
		await expect(center.synthesize({ engine: "test", text: "hello" })).rejects.toThrow(/empty audio/);
		vi.mocked(provider.synthesize).mockResolvedValueOnce({
			buffer: new Uint8Array(16 * 1024 * 1024 + 1),
			format: "wav",
		});
		await expect(center.synthesize({ engine: "test", text: "hello" })).rejects.toThrow(/16 MiB/);
		vi.mocked(provider.synthesize).mockResolvedValueOnce({ buffer: Buffer.from("a"), format: "pcm" });
		await expect(center.synthesize({ engine: "test", text: "hello" })).rejects.toThrow(/sample rate/);
	});
});
