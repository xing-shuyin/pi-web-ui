import { spawn } from "node:child_process";

export function speechReplyText(input, maxChars = 160) {
	let text = String(input || "")
		.replace(/```[\s\S]*?(?:```|$)/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, "")
		.replace(/[`*_~|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const truncated = text.length > maxChars;
	if (truncated) text = `${text.slice(0, maxChars).trimEnd()}。更多内容请查看文字回复。`;
	return { text, truncated };
}

async function ffmpegPcm(executable, input, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			executable,
			["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"],
			{ windowsHide: true, signal, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
		);
		const chunks = [];
		let length = 0;
		let error;
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			length += chunk.length;
			if (length > 16 * 1024 * 1024) {
				error = new Error("QQ 语音音频过大");
				child.kill();
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk}`.slice(-1024);
		});
		child.on("error", (err) => {
			error = err;
		});
		child.on("close", (code) => {
			if (error) reject(error);
			else if (code !== 0) reject(new Error(`QQ 语音转码失败：${stderr}`));
			else resolve(Buffer.concat(chunks));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

export function createQqVoiceRenderer(host) {
	let codecPromise;
	let ffmpegPromise;
	async function dependency(spec, load) {
		if (!(await host.ensureDeps?.([spec]))) throw new Error(`QQ 语音组件 ${spec} 安装失败，请检查网络`);
		return load();
	}
	return async (text, config, { signal } = {}) => {
		const audio = await host.tts.synthesize({
			text,
			engine: config.voiceEngine || "builtin",
			voice: config.voiceSpeaker || "",
			rate: Number(config.voiceRate) || 1,
			signal,
		});
		signal?.throwIfAborted();
		if (!codecPromise)
			codecPromise = dependency("silk-wasm@3.7.1", () => import("silk-wasm")).catch((error) => {
				codecPromise = undefined;
				throw error;
			});
		const codec = await codecPromise;
		signal?.throwIfAborted();
		if (codec.isSilk(audio.buffer)) return { buffer: Buffer.from(audio.buffer), fileName: "reply.silk", kind: "voice" };
		let input = audio.buffer;
		let sampleRate = audio.sampleRate || 0;
		if (audio.format !== "wav" && audio.format !== "pcm") {
			if (!ffmpegPromise)
				ffmpegPromise = dependency("ffmpeg-static@5.3.0", () => import("ffmpeg-static")).catch((error) => {
					ffmpegPromise = undefined;
					throw error;
				});
			const ffmpeg = (await ffmpegPromise).default;
			signal?.throwIfAborted();
			input = await ffmpegPcm(ffmpeg, input, signal);
			sampleRate = 24000;
		}
		const encoded = await codec.encode(input, sampleRate);
		signal?.throwIfAborted();
		if (!encoded.data?.length || encoded.duration > 60000) throw new Error("QQ 语音须为 60 秒内的有效音频");
		return { buffer: Buffer.from(encoded.data), fileName: "reply.silk", kind: "voice" };
	};
}
