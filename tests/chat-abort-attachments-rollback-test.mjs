import { createServer } from "node:http";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8996;
const CLIENT_ID = "full-test-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
}

let mockResponses = [];
let receivedRequests = [];
let streamDelayMs = 0;

const mockServer = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [] }));
		return;
	}
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", async () => {
		try {
			console.log("[MOCK END FIRED]");
			console.log("[MOCK REQ]", req.method, req.url);
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = raw;
			}
			receivedRequests.push(parsed);
			const replyText = mockResponses.shift() ?? "Mock answer from AI.";
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const words = replyText.split(" ");
			for (let i = 0; i < words.length; i++) {
				if (res.writableEnded) break;
				const delta = (i === 0 ? "" : " ") + words[i];
				res.write(
					"data: " +
						JSON.stringify({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
						}) +
						String.fromCharCode(10, 10),
				);
				if (streamDelayMs > 0) {
					await new Promise((r) => setTimeout(r, streamDelayMs));
				}
			}
			console.log("[MOCK req.destroyed after loop]", req.destroyed);
			if (!res.writableEnded) {
				res.write(
					"data: " +
						JSON.stringify({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length },
						}) +
						String.fromCharCode(10, 10),
				);
				res.write("data: [DONE]" + String.fromCharCode(10, 10));
				res.end();
				console.log("[MOCK RES ENDED]");
			}
		} catch (e) {
			console.error("[MOCK ERR]", e);
		}
	});
});

await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_PORT = mockServer.address().port;
const baseDir = mkdtempSync(join(tmpdir(), "pi-chat-test-"));
const workDir = join(baseDir, "work");
const dataDir = join(baseDir, "data");
const agentDir = join(baseDir, "agent");
mkdirSync(workDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

writeFileSync(join(workDir, "file-a.txt"), "This is content of file A.\nLine 2 of file A.\n");
writeFileSync(join(workDir, "file-b.txt"), "This is content of file B.\nLine 2 of file B.\n");
writeFileSync(join(workDir, "file-large.dat"), Buffer.alloc(25 * 1024, "X"));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
				apiKey: "dummy",
				models: [{ id: "mock-model", name: "Mock Model" }],
			},
		},
	}),
);

const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: workDir,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: workDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d) => process.stdout.write("[srv out] " + d.toString()));
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

for (let i = 0; i < 100; i++) {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
		if (r.ok) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 200));
let ws;
let currentState = { isStreaming: false, messages: [] };
const stateWaiters = [];

function checkStateWaiters() {
	for (let i = 0; i < stateWaiters.length; i++) {
		if (stateWaiters[i].test(currentState)) {
			const r = stateWaiters.splice(i, 1)[0];
			clearTimeout(r.t);
			r.res(currentState);
			i--;
		}
	}
}

function waitState(pred, desc, timeout = 12000) {
	if (pred(currentState)) return Promise.resolve(currentState);
	return new Promise((res, rej) => {
		const t = setTimeout(
			() =>
				rej(
					new Error(
						"Timeout waiting for state: " +
							desc +
							" (current isStreaming=" +
							currentState.isStreaming +
							", msgs=" +
							currentState.messages.length +
							")",
					),
				),
			timeout,
		);
		stateWaiters.push({ test: pred, res, rej, t });
	});
}
const inbox = [];
const waiters = [];

function connect() {
	return new Promise((resolve, reject) => {
		ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
		ws.on("open", resolve);
		ws.on("error", reject);
		ws.on("message", (d) => {
			const rawStr = d.toString();
			const m = JSON.parse(rawStr);
			if (m.type === "snapshot_delta")
				console.log(
					"[SNAP_DELTA] isStreaming:",
					m.state?.isStreaming,
					"error:",
					m.state?.errorMessage,
					"appended:",
					m.appended?.map((x) => x.role),
				);
			if (m.type === "notice") console.log("[NOTICE]", m.level, m.text);
			console.log("[TEST RECV]", m.type, m.type === "snapshot" ? "full snap msgs: " + m.state?.messages?.length : "");
			if (m.type === "snapshot") {
				currentState = { ...m.state };
				checkStateWaiters();
			} else if (m.type === "snapshot_delta") {
				currentState = {
					...currentState,
					...m.state,
					messages:
						m.appended && m.appended.length > 0 ? [...currentState.messages, ...m.appended] : currentState.messages,
				};
				checkStateWaiters();
			} else if (m.type === "message_delta") {
				currentState.isStreaming = true;
				checkStateWaiters();
			}

			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].test(m)) {
					const r = waiters.splice(i, 1)[0];
					clearTimeout(r.t);
					r.res(m);
					return;
				}
			}
			inbox.push(m);
		});
	});
}

function waitMsg(pred, desc, timeout = 12000) {
	const idx = inbox.findIndex(pred);
	if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error("Timeout waiting for: " + desc)), timeout);
		waiters.push({ test: pred, res, rej, t });
	});
}

function send(msg) {
	ws.send(JSON.stringify(msg));
}
try {
	await connect();
	send({ type: "hello", clientId: CLIENT_ID });
	await waitMsg((m) => m.type === "ready", "ready event");
	send({ type: "set_model", modelId: "mock/mock-model" });
	await new Promise((r) => setTimeout(r, 500));

	console.log("\n=== 1. 基础对话测试 (Chat Stream) ===");
	mockResponses.push("Hello! I am your AI assistant ready to help.");
	streamDelayMs = 10;
	send({ type: "prompt", text: "你好，请打个招呼" });

	const snapStreaming = await waitState((s) => s.isStreaming, "state.isStreaming: true", 6000);
	check("Prompt triggered isStreaming: true", snapStreaming.isStreaming === true);

	const snapDone = await waitState(
		(s) => !s.isStreaming && s.messages.some((x) => x.role === "assistant"),
		"state.isStreaming: false with assistant",
		10000,
	);
	check("Prompt finished with isStreaming: false", snapDone.isStreaming === false);
	const lastMsg = snapDone.messages[snapDone.messages.length - 1];
	check("Assistant message completed cleanly", lastMsg.role === "assistant" && lastMsg.stopReason === "stop");

	console.log("\n=== 2. 空闲时调用 Abort 幂等性测试 (Idle Abort Guard) ===");
	const t0 = Date.now();
	send({ type: "abort" });
	await new Promise((r) => setTimeout(r, 600));
	const elapsedIdleAbort = Date.now() - t0;
	check("Idle abort returned quickly without hanging (<1000ms)", elapsedIdleAbort < 1000, elapsedIdleAbort + "ms");
	const idleNotice = inbox.find((m) => m.type === "notice" && m.text.includes("强制重置"));
	check("Idle abort did not trigger false forced reset notice", !idleNotice);

	console.log("\n=== 3. 流式生成中中断测试 (Abort mid-stream) ===");
	mockResponses.push(
		"This is a very long story that is going to be interrupted by user abort command mid-way through.",
	);
	streamDelayMs = 150;
	send({ type: "prompt", text: "讲一个长故事" });

	await waitState((s) => s.isStreaming, "story isStreaming: true", 5000);
	await new Promise((r) => setTimeout(r, 300));
	send({ type: "abort" });

	const snapAborted = await waitState((s) => !s.isStreaming, "abort state.isStreaming: false", 5000);
	check("Stream was successfully stopped by abort", snapAborted.isStreaming === false);
	const abortedMsg = snapAborted.messages[snapAborted.messages.length - 1];
	check(
		"Last assistant message marked aborted or truncated",
		abortedMsg.role === "assistant" && (abortedMsg.stopReason === "aborted" || abortedMsg.stopReason === "stop"),
	);
	console.log("\n=== 4. 文件附件消息测试 (File Attachments) ===");
	mockResponses.push("I have reviewed file A and the uploaded file.");
	streamDelayMs = 10;
	const UPLOAD_BYTES = Buffer.from("Uploaded file content from browser\n").toString("base64");
	send({
		type: "prompt",
		text: "请分析我上传的附件",
		attachments: [
			{ path: "file-a.txt", mode: "reference" },
			{ path: "file-large.dat", mode: "reference" },
			{ path: "", fileData: UPLOAD_BYTES, name: "upload.txt", size: 0 },
		],
	});

	const snapAttach = await waitState(
		(s) => !s.isStreaming && s.messages.some((x) => x.customType === "file"),
		"attachment snapshot",
		10000,
	);
	const fileMessages = snapAttach.messages.filter((m) => m.customType === "file");
	check(
		"File attachments converted into customMessage asides",
		fileMessages.length >= 3,
		"count: " + fileMessages.length,
	);
	const hasPathRef = fileMessages.some((m) => m.details?.mode === "reference" && m.details?.name === "file-a.txt");
	const hasRef = fileMessages.some((m) => m.details?.mode === "reference" && m.details?.name === "file-large.dat");
	const hasUpload = fileMessages.some((m) => m.details?.upload === true && m.details?.name === "upload.txt");
	check("Path-reference attachment rendered correctly", hasPathRef);
	check("Reference attachment rendered correctly", hasRef);
	check("Uploaded fileData rendered correctly", hasUpload);

	console.log("\n=== 5. 中断文件附加的消息再次发文件附加的消息 (Abort with Attachments, Then Re-send Attachments) ===");
	mockResponses.push("I am currently analyzing file-a in detail when suddenly an abort is triggered...");
	streamDelayMs = 150;
	send({
		type: "prompt",
		text: "第一轮：详细分析 file-a",
		attachments: [{ path: "file-a.txt", mode: "reference" }],
	});

	await waitState((s) => s.isStreaming, "first attachment isStreaming: true", 5000);
	await new Promise((r) => setTimeout(r, 300));

	console.log("Triggering abort while analyzing file-a...");
	send({ type: "abort" });

	const snapFirstAborted = await waitState((s) => !s.isStreaming, "first attachment stopped", 5000);
	check("First attachment message was aborted smoothly", snapFirstAborted.isStreaming === false);

	console.log("Re-sending prompt with file-b attachment immediately after abort...");
	mockResponses.push("Now successfully analyzing file-b without any issue.");
	streamDelayMs = 10;
	send({
		type: "prompt",
		text: "第二轮：那请转为分析 file-b 吧",
		attachments: [{ path: "file-b.txt", mode: "reference" }],
	});

	const snapSecondDone = await waitState(
		(s) =>
			!s.isStreaming && s.messages.some((x) => x.role === "user" && x.content.some((b) => b.text?.includes("第二轮"))),
		"second attachment finished",
		10000,
	);
	check("Second prompt with attachment completed cleanly", snapSecondDone.isStreaming === false);

	const allFiles = snapSecondDone.messages.filter((m) => m.customType === "file");
	const foundFileA = allFiles.some((m) => m.details?.name === "file-a.txt");
	const foundFileB = allFiles.some((m) => m.details?.name === "file-b.txt");
	check("Both file-a and file-b are preserved in transcript", foundFileA && foundFileB);
	console.log("\n=== 6. 会话回滚测试 (Rollback Session) ===");
	const userMsgs = snapSecondDone.messages.filter((m) => m.role === "user");
	const firstUserMsg = userMsgs[0];
	check("Found target message for rollback", !!firstUserMsg?.id);

	if (firstUserMsg) {
		console.log("Rolling back to first user message id:", firstUserMsg.id);
		send({ type: "rollback_session", messageId: firstUserMsg.id });

		const snapRolled = await waitState(
			(s) => !s.isStreaming && s.messages.filter((x) => x.role === "user").length <= 1,
			"rolled back snapshot",
			8000,
		);
		check(
			"Session rolled back to initial checkpoint",
			snapRolled.messages.filter((x) => x.role === "user").length <= 1,
		);

		mockResponses.push("Resumed smoothly after rollback with new file.");
		send({
			type: "prompt",
			text: "回滚后提问：请读取 file-b",
			attachments: [{ path: "file-b.txt", mode: "reference" }],
		});

		const snapAfterRollback = await waitState(
			(s) =>
				!s.isStreaming &&
				s.messages.some((x) => x.role === "user" && x.content.some((b) => b.text?.includes("回滚后提问"))),
			"after rollback prompt finished",
			10000,
		);
		check("Successfully prompted with attachments after rollback", snapAfterRollback.isStreaming === false);
	}

	console.log("\n=== 7. 编辑重问测试 (Edit Message with Attachments) ===");
	const curUserMsgs = currentState.messages.filter((m) => m.role === "user");
	const editTarget = curUserMsgs[curUserMsgs.length - 1];
	check("Found target message for edit", !!editTarget?.id);

	if (editTarget) {
		mockResponses.push("Response to edited question with attachments.");
		send({
			type: "edit_message",
			messageId: editTarget.id,
			text: "编辑后的问题：重新评估 file-a",
			attachments: [{ path: "file-a.txt", mode: "reference" }],
		});

		const snapEdited = await waitState(
			(s) =>
				!s.isStreaming &&
				s.messages.some((x) => x.role === "user" && x.content.some((b) => b.text?.includes("编辑后的问题"))),
			"edited message snapshot",
			10000,
		);
		check("Edit-and-reask with attachments succeeded", snapEdited.isStreaming === false);
	}
	console.log("=== 8. 边界测试：快速连续中断与再次发附件 (Rapid Abort & Prompt) ===");
	mockResponses.push("Will be aborted instantly 1");
	streamDelayMs = 150;
	send({
		type: "prompt",
		text: "快速中断轮 1",
		attachments: [{ path: "file-a.txt", mode: "reference" }],
	});
	await waitState((s) => s.isStreaming, "rapid 1 streaming", 5000);
	send({ type: "abort" });
	await waitState((s) => !s.isStreaming, "rapid 1 stopped", 5000);
	check("Rapid abort 1 stopped", true);

	mockResponses.push("Will be aborted instantly 2");
	streamDelayMs = 150;
	send({
		type: "prompt",
		text: "快速中断轮 2",
		attachments: [{ path: "file-b.txt", mode: "reference" }],
	});
	await waitState((s) => s.isStreaming, "rapid 2 streaming", 5000);
	send({ type: "abort" });
	await waitState((s) => !s.isStreaming, "rapid 2 stopped", 5000);
	check("Rapid abort 2 stopped", true);

	mockResponses.push("Rapid abort recovered successfully and finished final turn.");
	streamDelayMs = 10;
	send({
		type: "prompt",
		text: "快速中断恢复轮 3：分析 A 和 B",
		attachments: [
			{ path: "file-a.txt", mode: "reference" },
			{ path: "file-b.txt", mode: "reference" },
		],
	});
	const snapRapidDone = await waitState(
		(s) =>
			!s.isStreaming &&
			s.messages.some((x) => x.role === "user" && x.content.some((b) => b.text?.includes("快速中断恢复轮 3"))),
		"rapid 3 done",
		10000,
	);
	check("Rapid abort recovery prompt succeeded cleanly", snapRapidDone.isStreaming === false);

	console.log("=== 9. 边界测试：连续二次回滚 (Double Rollback) ===");
	const curUserList = currentState.messages.filter((m) => m.role === "user");
	const midTarget = curUserList[Math.max(0, curUserList.length - 2)];
	const rootTarget = curUserList[0];
	if (midTarget && rootTarget) {
		console.log("First rollback to mid message:", midTarget.id);
		send({ type: "rollback_session", messageId: midTarget.id });
		await waitState(
			(s) => !s.isStreaming && s.messages.length <= snapRapidDone.messages.length,
			"first rollback ready",
			6000,
		);

		await waitMsg((m) => m.type === "notice" && m.text.includes("已回滚"), "first rollback notice");
		await new Promise((r) => setTimeout(r, 200));
		const remainingUsers = currentState.messages.filter((m) => m.role === "user");
		const rootNode = remainingUsers[0];
		if (rootNode) {
			console.log("Second rollback to root message:", rootNode.id);
			send({ type: "rollback_session", messageId: rootNode.id });
			await waitMsg((m) => m.type === "notice" && m.text.includes("已回滚"), "second rollback notice");
		}
		const snapDoubleRolled = await waitState(
			(s) => !s.isStreaming && s.messages.filter((x) => x.role === "user").length <= 1,
			"double rollback finished",
			6000,
		);
		check(
			"Double rollback successfully reset context to initial user message",
			snapDoubleRolled.messages.filter((x) => x.role === "user").length <= 1,
		);

		mockResponses.push("Response after double rollback.");
		streamDelayMs = 10;
		send({
			type: "prompt",
			text: "二次回滚后发送消息",
			attachments: [{ path: "file-a.txt", mode: "reference" }],
		});
		const snapAfterDouble = await waitState(
			(s) =>
				!s.isStreaming &&
				s.messages.some((x) => x.role === "user" && x.content.some((b) => b.text?.includes("二次回滚后发送消息"))),
			"after double rollback prompt finished",
			10000,
		);
		check("Prompting with attachments after double rollback succeeded", snapAfterDouble.isStreaming === false);
	}
} catch (err) {
	console.error("Test execution error:", err);
	failures++;
} finally {
	try {
		ws?.close();
	} catch {}
	try {
		mockServer.close();
	} catch {}
	try {
		server.kill("SIGKILL");
	} catch {}
}

console.log("\n=========================================");
console.log("Total failures: " + failures);
console.log("=========================================");
process.exit(failures === 0 ? 0 : 1);
