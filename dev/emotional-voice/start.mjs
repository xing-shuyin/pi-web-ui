/** 同时拉起情绪语音服务与网页服务，Ctrl+C 一起停。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const MARKER = path.join(REPO, ".scratch", "emotional-voice", "setup-done.json");
const config = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

if (!fs.existsSync(MARKER)) {
	console.error("还没装好运行环境，请先运行：cd dev/emotional-voice && npm run setup");
	process.exit(1);
}
const ready = JSON.parse(fs.readFileSync(MARKER, "utf8"));

async function waitFor(url, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return;
		} catch {
			// 继续等
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`等待 ${label} 超时：${url}`);
}

let stopping = false;
const childEnv = {
	...process.env,
	CV_ROOT: ready.source,
	CV_MODEL_DIR: ready.model,
	CV_PROMPT_WAV: ready.promptWav,
	CV_WHISPER_SRC: ready.whisperSrc,
	CV_ANTLR_SRC: ready.antlrSrc,
	TTS_PORT: String(config.ttsPort),
	CV_GPU_FRACTION: String(config.tts.gpuFraction ?? 0.45),
	// 让第三方库把缓存写到工作区内的运行时目录，别往用户家目录乱写。
	MPLCONFIGDIR: path.join(path.dirname(MARKER), "matplotlib"),
	HF_HOME: path.join(path.dirname(MARKER), "huggingface"),
	XDG_CACHE_HOME: path.join(path.dirname(MARKER), "cache"),
};
if (config.tts.device === "cpu") {
	childEnv.CUDA_VISIBLE_DEVICES = "-1";
} else {
	// 空字符串也会被 CUDA 当成「没有显卡」，GPU 模式必须彻底删掉这个变量。
	delete childEnv.CUDA_VISIBLE_DEVICES;
}

const tts = spawn(ready.python, [path.join(HERE, "tts_service.py")], {
	stdio: "inherit",
	windowsHide: true,
	env: childEnv,
});

tts.on("exit", (code) => {
	if (!stopping) {
		console.error(`情绪语音服务意外退出（code=${code}）`);
		process.exit(code ?? 1);
	}
});

try {
	await waitFor(`http://127.0.0.1:${config.ttsPort}/health`, 180_000, "CosyVoice 模型加载");
} catch (error) {
	console.error(error.message);
	tts.kill();
	process.exit(1);
}

const web = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
	stdio: "inherit",
	windowsHide: true,
});

function shutdown() {
	if (stopping) return;
	stopping = true;
	tts.kill();
	web.kill();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", () => shutdown());
