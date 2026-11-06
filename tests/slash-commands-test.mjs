import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8793;
const WS_URL = `ws://localhost:${PORT}/ws`;
const CLIENT_ID = `slash-cmd-test-${Date.now()}`;
const PROJ = REPO_ROOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NATIVE_NAMES = ["new", "model", "compact", "cwd", "thinking", "resume", "help", "copy"];

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else {
				inbox.push(msg);
			}
		});
		ws.on("open", () =>
			resolve({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 30000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeout);
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(t);
								res(m);
							},
						});
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

async function main() {
	try {
		ensureBuild(PROJ, "slash-commands-test");
	} catch (err) {
		console.error(String(err?.message ?? err));
		process.exit(1);
	}
	try {
		await freePort(PORT);
	} catch {}
	await sleep(500);
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: REPO_ROOT,
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "piweb-slash-")),
			PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "piweb-slash-agent-")),
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) {
		console.error("server failed to start");
		process.exit(1);
	}

	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");

	const cat = await c.wait((m) => m.type === "slash_commands");
	const names = new Set(cat.commands.map((x) => x.name));
	const missing = NATIVE_NAMES.filter((n) => !names.has(n));
	if (missing.length > 0) {
		throw new Error(`FAIL: builtin commands missing: ${missing.join(", ")}`);
	}
	const bySource = {};
	for (const cmd of cat.commands) {
		bySource[cmd.source] = (bySource[cmd.source] ?? 0) + 1;
	}
	console.log(`[1] catalog on attach: ${cat.commands.length} commands`, JSON.stringify(bySource));
	if (cat.commands.length < NATIVE_NAMES.length) {
		throw new Error("FAIL: catalog smaller than the native set");
	}

	c.send({ type: "get_commands" });
	const cat2 = await c.wait((m) => m.type === "slash_commands");
	if (cat2.commands.length !== cat.commands.length) {
		throw new Error(`FAIL: get_commands returned ${cat2.commands.length}, expected ${cat.commands.length}`);
	}
	console.log(`[2] get_commands re-request: ${cat2.commands.length} commands`);

	const TMP_CWD = mkdtempSync(join(tmpdir(), "slash-cwd-"));
	const norm = (p) => p.replace(/\\/g, "/");
	c.send({ type: "prompt", text: `/cwd ${TMP_CWD}` });
	await c.wait((m) => (m.type === "snapshot" || m.type === "snapshot_delta") && norm(m.state?.cwd) === norm(TMP_CWD));
	const cwdSwitching = await c
		.wait((m) => m.type === "transition_progress" && m.kind === "cwd" && m.phase !== "done", 6000)
		.catch(() => null);
	const cwdOk = await c
		.wait((m) => m.type === "transition_progress" && m.kind === "cwd" && m.phase === "done", 6000)
		.catch(() => null);
	if (!cwdOk) {
		throw new Error("FAIL: /cwd valid path did not switch workspace");
	}
	console.log(`[3] /cwd valid → ${cwdSwitching ? cwdSwitching.text + " → " : ""}${cwdOk.text}`);

	c.send({ type: "prompt", text: "/cwd /nonexistent-zzz" });
	const cwdBad = await c.wait(
		(m) => m.type === "notice" && typeof m.text === "string" && m.text.includes("切换工作目录失败"),
		6000,
	);
	if (!cwdBad.text.includes("切换工作目录失败")) {
		throw new Error("FAIL: /cwd invalid path should notice an error");
	}
	console.log(`[4] /cwd invalid → ${cwdBad.text}`);

	c.send({ type: "prompt", text: "/model 这个模型必然不存在xyz" });
	const modelBad = await c.wait(
		(m) => m.type === "notice" && typeof m.text === "string" && m.text.includes("没有匹配到模型"),
		6000,
	);
	if (!modelBad.text.includes("没有匹配到模型")) {
		throw new Error("FAIL: /model no-match should notice an error");
	}
	console.log(`[5] /model no-match → ${modelBad.text}`);

	c.send({ type: "prompt", text: "/help" });
	const leak = await c.wait((m) => m.type === "notice" && m.text.includes("提示发送失败"), 3000).catch(() => null);
	if (leak) {
		throw new Error("FAIL: /help leaked to the SDK prompt");
	}
	console.log("[6] /help intercepted, no SDK leak");

	c.send({ type: "prompt", text: "/new" });
	const newChat = await c.wait((m) => m.type === "conversations", 6000);
	if (!newChat.activeId) {
		throw new Error("FAIL: /new did not create a conversation");
	}
	console.log(`[7] /new → active conversation ${newChat.activeId.slice(0, 8)}…`);

	c.send({ type: "prompt", text: "/new /cwd" });
	const firstNotice = await c
		.wait((m) => m.type === "notice" && m.text.includes("当前工作目录"), 8000)
		.catch(() => null);
	if (!firstNotice) {
		throw new Error("FAIL: /new <prompt> did not deliver the first prompt");
	}
	console.log(`[7b] /new /cwd → first prompt delivered (${firstNotice.text.split("。")[0]})`);

	c.send({ type: "prompt", text: "/reload" });
	const catReloaded = await c.wait((m) => m.type === "slash_commands", 20000);
	const reloadNotice = await c
		.wait((m) => m.type === "notice" && m.text.includes("已重新加载"), 8000)
		.catch(() => null);
	if (!reloadNotice) {
		throw new Error("FAIL: /reload did not emit its 已重新加载 notice");
	}
	const namesAfterReload = new Set(catReloaded.commands.map((x) => x.name));
	const missingAfterReload = NATIVE_NAMES.filter((n) => !namesAfterReload.has(n));
	if (missingAfterReload.length > 0) {
		throw new Error(`FAIL: builtin commands missing after /reload: ${missingAfterReload.join(", ")}`);
	}
	console.log(`[8] /reload → catalog re-pushed (${catReloaded.commands.length} commands), ${reloadNotice.text}`);

	c.close();
	server.kill();
	console.log("\n✅ SLASH-COMMAND CHECKS PASSED");
}

main().catch(async (e) => {
	console.error("❌", e.message);
	try {
		await freePort(PORT);
	} catch {}
	process.exit(1);
});
