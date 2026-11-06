import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getPluginTtsProvider,
	listPluginTtsProviders,
	onTtsProvidersChange,
	refreshTtsEngines,
} from "../../web/src/tts-client.js";

vi.mock("../../web/src/base-url", () => ({ appUrl: (path: string) => `/relay${path}` }));

const audios: any[] = [];
beforeEach(() => {
	audios.length = 0;
	vi.stubGlobal(
		"Audio",
		class {
			onplay: (() => void) | null = null;
			onended: (() => void) | null = null;
			onerror: (() => void) | null = null;
			pause = vi.fn();
			load = vi.fn();
			removeAttribute = vi.fn();
			play = vi.fn(async () => {
				this.onplay?.();
			});
			constructor(public src: string) {
				audios.push(this);
			}
		},
	);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tts");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("browser TTS center adapter", () => {
	it("reads engines and voices through the relay-aware center URLs", async () => {
		const fetcher = vi.fn(async (url: string) =>
			Response.json(
				url.includes("engines")
					? {
							engines: [
								{ id: "builtin", label: "System" },
								{ id: "plugin", label: "Plugin" },
							],
						}
					: { voices: [{ id: "zh", label: "Chinese", lang: "zh-CN" }] },
			),
		);
		vi.stubGlobal("fetch", fetcher);
		await refreshTtsEngines();
		expect(listPluginTtsProviders().map(({ id }) => id)).toEqual(["builtin", "plugin"]);
		expect(await getPluginTtsProvider("plugin")!.getVoices!()).toEqual([
			{ voiceURI: "zh", name: "Chinese", lang: "zh-CN" },
		]);
		expect(fetcher).toHaveBeenCalledWith("/relay/api/tts/voices?engine=plugin");
		const changed = vi.fn();
		const off = onTtsProvidersChange(changed);
		await refreshTtsEngines();
		expect(changed).toHaveBeenCalled();
		off();
	});
	it.each(["builtin", "doubao-tts"])(
		"plays %s through the same audio endpoint and releases the object URL",
		async (engine) => {
			const fetcher = vi.fn(async () => new Response("audio", { headers: { "Content-Type": "audio/wav" } }));
			vi.stubGlobal("fetch", fetcher);
			const onStart = vi.fn();
			const onEnd = vi.fn();
			const cancel = getPluginTtsProvider(engine)!.play({
				text: "hello",
				rate: 1.2,
				voiceURI: "voice",
				onStart,
				onEnd,
			});
			await vi.waitFor(() => expect(audios).toHaveLength(1));
			expect(fetcher).toHaveBeenCalledWith(
				"/relay/api/tts/synthesize",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ text: "hello", engine, voice: "voice", rate: 1.2 }),
				}),
			);
			expect(onStart).toHaveBeenCalledTimes(1);
			audios[0].onended();
			expect(onEnd).toHaveBeenCalledTimes(1);
			expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:tts");
			cancel();
			expect(onEnd).toHaveBeenCalledTimes(1);
		},
	);
	it("aborts generation on stop and discards late audio", async () => {
		let finish!: (response: Response) => void;
		const fetcher = vi.fn(
			(_url: string, _options: any) =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const onEnd = vi.fn();
		const onError = vi.fn();
		const cancel = getPluginTtsProvider("builtin")!.play({ text: "hello", rate: 1, onEnd, onError });
		cancel();
		expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
		finish(new Response("late"));
		await Promise.resolve();
		await Promise.resolve();
		expect(audios).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});
	it("reports an unavailable selected engine without silently switching voices", async () => {
		const fetcher = vi.fn(async () => Response.json({ error: "engine unavailable" }, { status: 502 }));
		vi.stubGlobal("fetch", fetcher);
		const onError = vi.fn();
		getPluginTtsProvider("removed")!.play({ text: "hello", rate: 1, onError });
		await vi.waitFor(() =>
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "engine unavailable" })),
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(audios).toEqual([]);
	});
});
