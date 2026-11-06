import type { Express } from "express";
import { ttsService, type TtsClient } from "./tts-service.js";

export function registerTtsRoutes(app: Express, tts: TtsClient = ttsService): void {
	app.get("/api/tts/engines", (_req, res) => {
		res.json({ engines: tts.listEngines() });
	});
	app.get("/api/tts/voices", async (req, res) => {
		try {
			res.json({ voices: await tts.listVoices(String(req.query.engine || "builtin")) });
		} catch (error) {
			res.status(502).json({ error: (error as Error).message });
		}
	});
	app.post("/api/tts/synthesize", async (req, res) => {
		if (typeof req.body?.text !== "string" || !req.body.text.trim() || req.body.text.length > 6000) {
			res.status(400).json({ error: "TTS requires 1–6000 characters of text" });
			return;
		}
		const controller = new AbortController();
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", onClose);
		try {
			const audio = await tts.synthesize({
				text: req.body.text,
				engine: req.body.engine,
				voice: req.body.voice,
				rate: req.body.rate,
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			const mime = {
				wav: "audio/wav",
				mp3: "audio/mpeg",
				aac: "audio/aac",
				ogg: "audio/ogg",
				pcm: "audio/L16",
				silk: "audio/silk",
			};
			res.setHeader("Content-Type", mime[audio.format]);
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-TTS-Format", audio.format);
			if (audio.sampleRate) res.setHeader("X-TTS-Sample-Rate", String(audio.sampleRate));
			res.send(Buffer.from(audio.buffer));
		} catch (error) {
			if (!controller.signal.aborted) res.status(502).json({ error: (error as Error).message });
		} finally {
			res.off("close", onClose);
		}
	});
}
