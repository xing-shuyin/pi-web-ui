import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerTtsRoutes } from "../../server/tts-routes.js";

function harness() {
	const routes = new Map<string, Function>();
	const tts = {
		listEngines: vi.fn(() => [{ id: "builtin", label: "System" }]),
		listVoices: vi.fn(async () => [{ id: "zh", label: "Chinese" }]),
		synthesize: vi.fn(async (_request: any) => ({ buffer: Buffer.from("wave"), format: "wav" as const })),
	};
	registerTtsRoutes(
		{
			get: (path: string, fn: Function) => routes.set(`GET ${path}`, fn),
			post: (path: string, fn: Function) => routes.set(`POST ${path}`, fn),
		} as any,
		tts,
	);
	const response = Object.assign(new EventEmitter(), {
		writableEnded: false,
		json: vi.fn(),
		send: vi.fn(),
		status: vi.fn(),
		setHeader: vi.fn(),
	});
	response.status.mockReturnValue(response);
	return { routes, tts, response };
}

describe("TTS center HTTP routes", () => {
	it("lists engine and voice metadata from the center", async () => {
		const { routes, tts, response } = harness();
		await routes.get("GET /api/tts/engines")!({}, response);
		expect(response.json).toHaveBeenCalledWith({ engines: tts.listEngines() });
		await routes.get("GET /api/tts/voices")!({ query: { engine: "doubao-tts" } }, response);
		expect(tts.listVoices).toHaveBeenCalledWith("doubao-tts");
	});
	it("returns binary audio with its format, preserving voice and rate", async () => {
		const { routes, tts, response } = harness();
		await routes.get("POST /api/tts/synthesize")!(
			{ body: { text: "你好", engine: "builtin", voice: "zh", rate: 1.2 } },
			response,
		);
		expect(tts.synthesize).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你好",
				engine: "builtin",
				voice: "zh",
				rate: 1.2,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "audio/wav");
		expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
		expect(response.send).toHaveBeenCalledWith(Buffer.from("wave"));
		expect(response.listenerCount("close")).toBe(0);
	});
	it("rejects empty/oversized text and reports synthesis failure", async () => {
		const { routes, tts, response } = harness();
		const synthesize = routes.get("POST /api/tts/synthesize")!;
		await synthesize({ body: { text: "" } }, response);
		await synthesize({ body: { text: "x".repeat(6001) } }, response);
		expect(response.status).toHaveBeenCalledWith(400);
		expect(tts.synthesize).not.toHaveBeenCalled();
		tts.synthesize.mockRejectedValueOnce(new Error("credential missing"));
		await synthesize({ body: { text: "hello" } }, response);
		expect(response.status).toHaveBeenCalledWith(502);
		expect(response.json).toHaveBeenCalledWith({ error: "credential missing" });
	});
	it("cancels synthesis when the browser disconnects without writing a late reply", async () => {
		const { routes, tts, response } = harness();
		let finish!: (audio: any) => void;
		tts.synthesize.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = routes.get("POST /api/tts/synthesize")!({ body: { text: "hello" } }, response);
		const signal = tts.synthesize.mock.calls[0]![0].signal;
		response.emit("close");
		expect(signal.aborted).toBe(true);
		finish({ buffer: Buffer.from("late"), format: "wav" });
		await pending;
		expect(response.send).not.toHaveBeenCalled();
		expect(response.json).not.toHaveBeenCalled();
	});
});
