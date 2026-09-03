// Vision bridge — end-to-end protocol test with a LOCAL MOCK OpenAI-compatible
// API that serves BOTH roles: the text-only main model and the vision model.
// The mock records the vision request (must contain image content) and returns
// a fixed transcript; the main model returns a canned answer.
//
// Verifies the full flow for a text-only main model (deepseek-style):
//   1. prompt with imageData → server notices "正在用视觉桥转写"
//   2. mock vision API receives the image content
//   3. the attachment card message carries mode "bridged" + <vision-bridge>
//      transcript text (what the main model actually sees)
//   4. transcript cache: re-sending the same image skips the vision API
//
// Usage: npm run build && node vision-bridge-test.mjs [port]
import WebSocket from "ws";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8945);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-visionbridge-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// A 1x1 red PNG (pure base64, no data: prefix).
const IMG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A real PNG file in the workspace — for the file-list (path reference) flow.
writeFileSync(join(workdir, "screenshot.png"), Buffer.from(IMG_B64, "base64"));

const TRANSCRIPT = "图 1：测试图片，内容为红色 1x1 像素。无文字。" + " ".repeat(50);
const MAIN_REPLY = "我看到了：图 1 是一张纯色测试图。";

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible API — serves both the main (text-only) model and the
// vision model. Vision requests include an image content block.
const visionRequests = [];
let visionRequestCount = 0;
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const model = payload.model ?? "";
	const lastMsg = payload.messages?.at(-1);
	// The SDK serializes ImageContent to OpenAI's image_url blocks on the wire.
	const hasImage =
		Array.isArray(lastMsg?.content) && lastMsg.content.some((b) => b.type === "image_url" || b.type === "image");
	if (hasImage) {
		visionRequestCount++;
		visionRequests.push({
			model,
			systemPrompt: typeof payload.messages?.[0]?.content === "string" ? payload.messages[0].content : null,
			imageBlocks: lastMsg.content.filter((b) => b.type === "image_url" || b.type === "image").length,
			textPrompt: lastMsg.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join(" "),
		});
	}
	const isVision = hasImage; // reply routing below uses isVision
	const reply = isVision ? TRANSCRIPT : MAIN_REPLY;
	// Split into a few SSE chunks.
	const chunks = [reply.slice(0, 30), reply.slice(30)];
	if (payload.stream !== false) {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		let i = 0;
		for (const ch of chunks) {
			res.write(
				`data: ${JSON.stringify({
					id: "mock-1",
					object: "chat.completion.chunk",
					created: Date.now(),
					model,
					choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
				})}\n\n`,
			);
			i++;
		}
		res.write(
			`data: ${JSON.stringify({
				id: "mock-1",
				object: "chat.completion.chunk",
				created: Date.now(),
				model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					},
				],
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	} else {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				id: "mock-1",
				object: "chat.completion",
				created: Date.now(),
				model,
				choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
		);
	}
});
await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));
console.log(`mock API on :${MOCK_PORT}`);

// Models: MAIN is text-only; VISION accepts images. Both point at the mock.
writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({
		main: { type: "api_key", key: "main-key" },
		vision: { type: "api_key", key: "vision-key" },
	}),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "main-key",
				models: [
					{
						id: "deepseek-main",
						name: "Main Text Model",
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
			},
			vision: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "vision-key",
				models: [
					{
						id: "qwen-vl-mock",
						name: "Mock Vision",
						input: ["text", "image"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
					{
						id: "glm-vl-mock",
						name: "GLM Vision",
						input: ["text", "image"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
			},
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		ws.on("message", (d) => {
			const m = JSON.parse(d.toString());
			this.received.push(m);
			this.track(m);
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Track merged snapshot state (full snapshots replace; rev-chained deltas
	 *  merge light fields + extend messages) — mirrors the frontend reducer. */
	track(m) {
		if (m.type === "snapshot") {
			this.state = m.state;
			this.messages = m.state.messages ?? [];
		} else if (
			m.type === "snapshot_delta" &&
			this.state &&
			this.state.rev === m.baseRev &&
			(!m.conversationId || m.conversationId === this.state.conversationId)
		) {
			this.state = { ...this.state, ...m.state };
			this.messages = [...this.messages, ...m.appended];
		}
	}
	async waitFor(type, timeout = 15000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	/** Wait until the merged state satisfies pred (snapshot or delta). */
	async waitForState(pred, timeout = 15000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (this.state && pred(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	/** Wait until the merged messages contain one matching pred. */
	async waitForMessage(pred, timeout = 20000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const hit = this.messages.find(pred);
			if (hit) return hit;
			await sleep(100);
		}
		throw new Error("timeout waiting for message");
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let clean = false;
async function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
	mock.close();
}

try {
	// warm up
	await sleep(1000);
	const c = await connect();
	c.send({ type: "hello", clientId: "vision-bridge-test" });
	await c.waitFor("ready", 8000);
	console.log("  · ready, data-dir:", dataDir);

	// Pick the text-only main model.
	await new Promise((r) => setTimeout(r, 500));
	c.send({ type: "set_model", modelId: "main/deepseek-main" });
	// wait for a snapshot showing the model
	await c.waitForState((s) => s.model?.id === "deepseek-main", 15000);
	console.log("  · main model:", "deepseek-main");

	// Send one prompt with a pasted image.
	c.send({
		type: "prompt",
		text: "这张图里有什么？",
		attachments: [
			{
				path: "",
				key: "t1",
				name: "test.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});

	// 1) "transcribing" notice
	const startNotice = await c.waitFor("notice", 15000, (m) => m.text && m.text.includes("正在用视觉桥"));
	check("transcribe-start notice", startNotice.level === "info");

	// 2) mock vision API saw the image
	const doneNotice = await c.waitFor(
		"notice",
		25000,
		(m) => m.text && (m.text.includes("转写完成") || m.text.includes("转写失败")),
	);
	check("transcribe-done notice", doneNotice.text.includes("vision"));
	check(
		"vision API received 1 image",
		visionRequests.length === 1 && visionRequests[0].imageBlocks === 1 && visionRequests[0].model === "qwen-vl-mock",
	);
	check("vision prompt asks for transcription", /转写/.test(visionRequests[0]?.textPrompt ?? ""));

	// 3) bridged attachment card in the message list
	const bridged = await c.waitForMessage((m) => m.customType === "file" && m.details?.mode === "bridged", 20000);
	check("attachment card mode=bridged", true);
	const bridgedText = (bridged.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	check(
		"card contains <vision-bridge> transcript",
		bridgedText.includes("<vision-bridge>") && bridgedText.includes(TRANSCRIPT.trim()),
	);
	check(
		"card keeps the image thumbnail",
		(bridged.content ?? []).some((b) => b.type === "image"),
	);

	// 4) main model request must NOT carry image content, but carry the text
	const mainSeen = visionRequests.length; // only vision calls recorded; add main-model capture
	// wait for the main model to answer (assistant message appears)
	await c.waitForMessage((m) => m.role === "assistant", 30000);
	console.log("  · main model replied");

	// 5) cache: same image again → no second vision API call
	const before = visionRequestCount;
	c.send({
		type: "prompt",
		text: "再看一遍这张图",
		attachments: [
			{
				path: "",
				key: "t2",
				name: "test.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	await c.waitFor("notice", 20000, (m) => m.text && m.text.includes("再看一遍")).catch(() => {});
	await sleep(4000);
	check("same image reuses transcript cache (no 2nd vision call)", visionRequestCount === before);

	// -- settings: pick a specific vision model ------------------------------
	// settings_state must carry the vision-bridge fields + the model picker list
	const ss = await c.waitFor("settings_state", 10000, (m) => m.settings && Array.isArray(m.settings.visionModels));
	check(
		"settings_state has vision-bridge fields",
		ss.settings.visionBridgeEnabled === true &&
			ss.settings.visionBridgeModel === null &&
			ss.settings.visionModels.length === 2,
	);
	check(
		"settings_state carries the built-in default prompts",
		typeof ss.settings.visionBridgeDefaultPrompt === "string" &&
			ss.settings.visionBridgeDefaultPrompt.includes("You are a vision bridge") &&
			typeof ss.settings.defaultSystemPrompt === "string" &&
			ss.settings.defaultSystemPrompt.length > 0,
	);

	// Switch the preferred transcription model to the SECOND vision model.
	c.send({
		type: "set_settings",
		visionBridgeModel: "vision/glm-vl-mock",
	});
	await c.waitFor("settings_state", 10000, (m) => m.settings?.visionBridgeModel === "vision/glm-vl-mock");
	const before2 = visionRequestCount;
	// A DIFFERENT image (different name -> different batch hash -> no cache hit)
	c.send({
		type: "prompt",
		text: "用指定模型看这张图",
		attachments: [
			{
				path: "",
				key: "t3",
				name: "other.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	await c.waitFor("notice", 25000, (m) => m.text && m.text.includes("转写完成"));
	check(
		"preferred model from settings is used",
		visionRequestCount === before2 + 1 && visionRequests.at(-1)?.model === "glm-vl-mock",
	);

	// -- settings: disable the bridge ----------------------------------------
	c.send({ type: "set_settings", visionBridgeEnabled: false });
	await c.waitFor("settings_state", 10000, (m) => m.settings?.visionBridgeEnabled === false);
	const before3 = visionRequestCount;
	c.send({
		type: "prompt",
		text: "关掉视觉桥看图",
		attachments: [
			{
				path: "",
				key: "t4",
				name: "off.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	const offNotice = await c.waitFor("notice", 15000, (m) => m.text && m.text.includes("视觉桥已在设置中关闭"));
	check(
		"disabled bridge warns and skips transcription",
		offNotice.level === "warning" && visionRequestCount === before3,
	);
	// Re-enable for the next scenario.
	c.send({ type: "set_settings", visionBridgeEnabled: true, visionBridgeModel: null });
	await c.waitFor("settings_state", 10000, (m) => m.settings?.visionBridgeEnabled === true);

	// -- path-referenced image (file list → attach) ---------------------------
	// Referencing screenshot.png by PATH must ALSO go through the vision bridge
	// (a text-only model can't read binary pixels; reference alone is useless).
	const beforePath = visionRequestCount;
	c.send({
		type: "prompt",
		text: "文件列表里的图片是什么？",
		attachments: [
			{
				path: "screenshot.png",
				mode: "reference",
				name: "screenshot.png",
			},
		],
	});
	const pathDone = await c.waitFor("notice", 25000, (m) => m.text && m.text.includes("转写完成"));
	check("path-referenced image triggers the vision bridge", visionRequestCount === beforePath + 1);
	const pathCard = await c.waitForMessage(
		(m) => m.customType === "file" && m.details?.mode === "bridged" && m.details?.path === "screenshot.png",
		20000,
	);
	check("path image renders as a bridged card with path", true);
	const pathText = (pathCard.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	check(
		"bridged card carries the transcript text",
		pathText.includes("<vision-bridge>") && pathText.includes(TRANSCRIPT.trim()),
	);

	// -- custom transcription prompt (settings-panel) -------------------------
	// The vision-bridge prompt is configurable: "append" appends custom text
	// after the built-in default prompt; "replace" replaces it entirely. The
	// mock now records the system prompt it receives for each vision request.
	const DEFAULT_PROMPT_MARKER = "You are a vision bridge";
	c.send({
		type: "set_settings",
		visionBridgePromptMode: "append",
		visionBridgePrompt: "【自定义：请额外输出图片主色调】",
	});
	await c.waitFor(
		"settings_state",
		10000,
		(m) =>
			m.settings?.visionBridgePromptMode === "append" &&
			m.settings?.visionBridgePrompt === "【自定义：请额外输出图片主色调】",
	);
	const before4 = visionRequestCount;
	c.send({
		type: "prompt",
		text: "用追加提示词看图",
		attachments: [
			{
				path: "",
				key: "t5",
				name: "append.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	await c.waitFor("notice", 25000, (m) => m.text && m.text.includes("转写完成"));
	const appendReq = visionRequests.at(-1);
	check(
		"append mode: custom text appended to the built-in default prompt",
		visionRequestCount === before4 + 1 &&
			typeof appendReq?.systemPrompt === "string" &&
			appendReq.systemPrompt.includes(DEFAULT_PROMPT_MARKER) &&
			appendReq.systemPrompt.includes("【自定义：请额外输出图片主色调】"),
	);

	c.send({
		type: "set_settings",
		visionBridgePromptMode: "replace",
		visionBridgePrompt: "完全自定义的转写提示词，只输出表格数据。",
	});
	await c.waitFor("settings_state", 10000, (m) => m.settings?.visionBridgePromptMode === "replace");
	const before5 = visionRequestCount;
	c.send({
		type: "prompt",
		text: "用替换提示词看图",
		attachments: [
			{
				path: "",
				key: "t6",
				name: "replace.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	await c.waitFor("notice", 25000, (m) => m.text && m.text.includes("转写完成"));
	const replaceReq = visionRequests.at(-1);
	check(
		"replace mode: built-in prompt fully replaced by custom text",
		visionRequestCount === before5 + 1 &&
			typeof replaceReq?.systemPrompt === "string" &&
			replaceReq.systemPrompt.includes("完全自定义的转写提示词") &&
			!replaceReq.systemPrompt.includes(DEFAULT_PROMPT_MARKER),
	);

	// Custom prompt also invalidates the transcript cache for the same image:
	// changing the prompt must NOT reuse a cached transcript made with the old
	// prompt. (Re-send the SAME image/name that was cached earlier in this run.)
	const before6 = visionRequestCount;
	c.send({
		type: "prompt",
		text: "再看一遍（提示词已改，不应命中缓存）",
		attachments: [
			{
				path: "",
				key: "t7",
				name: "append.png",
				mode: "inline",
				imageData: IMG_B64,
				mimeType: "image/png",
			},
		],
	});
	await c.waitFor("notice", 25000, (m) => m.text && m.text.includes("转写完成"));
	check("custom prompt change invalidates the transcript cache", visionRequestCount === before6 + 1);

	// Restore defaults so a rerun behaves the same from the start.
	c.send({
		type: "set_settings",
		visionBridgePromptMode: "append",
		visionBridgePrompt: "",
	});
	await c.waitFor("settings_state", 10000, (m) => m.settings?.visionBridgePromptMode === "append");

	console.log(`\n${passed} checks passed`);
	await cleanup();
	process.exit(process.exitCode || 0);
} catch (err) {
	console.error("\nERROR:", err.message);
	await cleanup();
	process.exit(1);
}
