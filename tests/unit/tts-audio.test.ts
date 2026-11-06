import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TtsService } from "../../server/tts-service.js";
import plugin from "../../plugins/tts/index.mjs";
import { createMockHost } from "../../plugin-sdk/testing.mjs";

it("registers plugin engines only on the shared center and revokes them on unload", async () => {
	const center = new TtsService();
	const host = createMockHost({
		tts: {
			registerEngine: (engine: any) => center.registerEngine("tts", engine),
			listEngines: () => center.listEngines(),
			listVoices: (id: string) => center.listVoices(id),
			synthesize: (request: any) => center.synthesize(request),
		},
	});
	const dispose = plugin.activate(host);
	expect(center.listEngines().map(({ id }) => id)).toEqual(["doubao-tts", "deepseek-tts"]);
	const doubao = await center.listVoices("doubao-tts");
	expect(doubao).toContainEqual(expect.objectContaining({ id: "taozi", label: "温柔桃子" }));
	expect(new Set(doubao.map(({ id }) => id)).size).toBe(doubao.length);
	expect(await center.listVoices("deepseek-tts")).toContainEqual(expect.objectContaining({ id: "echo" }));
	dispose();
	expect(center.listEngines()).toEqual([]);
});

it("passes selected voice and rate to Doubao and closes its request on cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tts-ws-"));
	await writeFile(join(dir, "doubao_cookie.txt"), "sessionid=test");
	const sockets: any[] = [];
	vi.stubGlobal(
		"WebSocket",
		class {
			close = vi.fn();
			send = vi.fn();
			constructor(
				public url: string,
				public options: any,
			) {
				sockets.push(this);
			}
		},
	);
	const center = new TtsService();
	const host = createMockHost({
		dir,
		tts: {
			registerEngine: (engine: any) => center.registerEngine("tts", engine),
			listEngines: () => center.listEngines(),
			listVoices: (id: string) => center.listVoices(id),
			synthesize: (request: any) => center.synthesize(request),
		},
	});
	const dispose = plugin.activate(host);
	try {
		const controller = new AbortController();
		const pending = center.synthesize({
			text: "hello",
			engine: "doubao-tts",
			voice: "taozi",
			rate: 1.2,
			signal: controller.signal,
		});
		const expected = expect(pending).rejects.toThrow(/cancel/);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const params = new URL(sockets[0].url).searchParams;
		expect(params.get("speaker")).toBe("zh_female_wenroutaozi_uranus_bigtts");
		expect(params.get("speech_rate")).toBe("20");
		controller.abort(new Error("cancel"));
		await expected;
		expect(sockets[0].close).toHaveBeenCalled();
	} finally {
		dispose();
		vi.unstubAllGlobals();
		await rm(dir, { recursive: true, force: true });
	}
});

describe("TTS plugin callers", () => {
	it("uses the shared center for the HTTP facade, UI preview, AI tool and engine/voice listing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-tts-plugin-"));
		const tools: any[] = [];
		const routes = new Map<string, Function>();
		let onMessage: Function = () => {};
		const tts = {
			registerEngine: vi.fn(() => () => {}),
			listEngines: vi.fn(() => [{ id: "builtin", label: "System" }]),
			listVoices: vi.fn(async () => [{ id: "zh", label: "Chinese" }]),
			synthesize: vi.fn(async (_request: any) => ({ buffer: Buffer.from("shared audio"), format: "wav" })),
		};
		const host = createMockHost({
			dir,
			cwd: dir,
			tts,
			route: (_method: string, path: string, handler: Function) => {
				routes.set(`${_method} ${path}`, handler);
				return () => {};
			},
			registerAgentTool: (tool: any) => {
				tools.push(tool);
				return () => {};
			},
			onMessage: (handler: Function) => {
				onMessage = handler;
				return () => {};
			},
		});
		const dispose = plugin.activate(host);
		try {
			const tool = tools.find(({ name }) => name === "tts");
			expect(await tool.execute({ action: "list" })).toEqual({ engines: [{ id: "builtin", label: "System" }] });
			await tool.execute({ action: "list", engine: "builtin" });
			expect(tts.listVoices).toHaveBeenCalledWith("builtin");
			const output = await tool.execute({
				text: "tool",
				engine: "builtin",
				speaker: "zh",
				rate: 1.2,
				outFile: "voice.wav",
			});
			expect(output).toMatchObject({ success: true, engine: "builtin" });
			expect(await readFile(join(dir, "voice.wav"), "utf8")).toBe("shared audio");
			const response = { writeHead: vi.fn(), end: vi.fn() };
			await routes.get("POST /speak")!(
				{ body: { text: "http", engine: "builtin", speaker: "zh", speed: 0.2 } },
				response,
			);
			expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ ok: true, format: "wav" });
			await onMessage({ action: "test-speak", text: "ui", engine: "builtin", speaker: "zh" });
			expect(tts.synthesize.mock.calls.map(([request]) => request.text)).toEqual(["tool", "http", "ui"]);
			expect(tts.synthesize).toHaveBeenCalledWith(
				expect.objectContaining({ engine: "builtin", voice: "zh", rate: 1.2 }),
			);
		} finally {
			dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
