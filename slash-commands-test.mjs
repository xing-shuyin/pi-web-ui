/* Smoke test: chat-input slash commands.
 *   - slash_commands catalog arrives on attach and on get_commands (builtin +
 *     extension + prompt template + skill commands).
 *   - Native commands (/new /model /cwd /thinking /help …) are intercepted
 *     server-side in AgentService.prompt() and never hit the SDK.
 *   - Non-native slash text falls through to the SDK prompt (no interception).
 *
 * Run:  node slash-commands-test.mjs
 */
import { execSync, spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8793;
const WS_URL = `ws://localhost:${PORT}/ws`;
// Unique per run — a persisted lastCwd from a previous run would restore /tmp
// on attach and change the /cwd assertions.
const CLIENT_ID = `slash-cmd-test-${Date.now()}`;
const PROJ = "/Volumes/P/project/pi-web-ui";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NATIVE_NAMES = [
	"new",
	"model",
	"compact",
	"cwd",
	"thinking",
	"resume",
	"help",
	"copy",
];

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
				wait: (pred, timeout = 8000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(
							() => rej(new Error("timeout waiting for message")),
							timeout,
						);
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
	// Build + boot the server on a dedicated port.
	try {
		execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
	} catch {
		console.error("build failed");
		process.exit(1);
	}
	try {
		execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, {
			stdio: "ignore",
		});
	} catch {
		/* port free */
	}
	await sleep(500);
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: "/Volumes/P/project" },
		stdio: "ignore",
	});
	const portUp = async () => {
		try {
			execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	for (let i = 0; i < 40 && !(await portUp()); i++) await sleep(250);
	if (!(await portUp())) {
		console.error("server failed to start");
		process.exit(1);
	}

	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");

	// --- 1. catalog arrives on attach ---
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
	console.log(
		`[1] catalog on attach: ${cat.commands.length} commands`,
		JSON.stringify(bySource),
	);
	if (cat.commands.length < NATIVE_NAMES.length) {
		throw new Error("FAIL: catalog smaller than the native set");
	}

	// --- 2. get_commands re-request works ---
	c.send({ type: "get_commands" });
	const cat2 = await c.wait((m) => m.type === "slash_commands");
	if (cat2.commands.length !== cat.commands.length) {
		throw new Error(
			`FAIL: get_commands returned ${cat2.commands.length}, expected ${cat.commands.length}`,
		);
	}
	console.log(`[2] get_commands re-request: ${cat2.commands.length} commands`);

	// --- 3. native /cwd (valid + invalid) ---
	c.send({ type: "prompt", text: "/cwd /tmp" });
	await c.wait((m) => m.type === "snapshot" && m.state.cwd === "/tmp");
	const cwdOk = await c.wait((m) => m.type === "notice", 6000).catch(() => null);
	if (!cwdOk || !cwdOk.text.includes("已切换到工作目录")) {
		throw new Error("FAIL: /cwd valid path did not switch workspace");
	}
	console.log(`[3] /cwd valid → ${cwdOk.text}`);

	c.send({ type: "prompt", text: "/cwd /nonexistent-zzz" });
	const cwdBad = await c.wait((m) => m.type === "notice", 6000);
	if (!cwdBad.text.includes("切换工作目录失败")) {
		throw new Error("FAIL: /cwd invalid path should notice an error");
	}
	console.log(`[4] /cwd invalid → ${cwdBad.text}`);

	// --- 4. native /model with no match ---
	c.send({ type: "prompt", text: "/model 这个模型必然不存在xyz" });
	const modelBad = await c.wait((m) => m.type === "notice", 6000);
	if (!modelBad.text.includes("没有匹配到模型")) {
		throw new Error("FAIL: /model no-match should notice an error");
	}
	console.log(`[5] /model no-match → ${modelBad.text}`);

	// --- 5. native /help is swallowed (no prompt-send failure) ---
	c.send({ type: "prompt", text: "/help" });
	const leak = await c.wait(
		(m) => m.type === "notice" && m.text.includes("提示发送失败"),
		3000,
	).catch(() => null);
	if (leak) {
		throw new Error("FAIL: /help leaked to the SDK prompt");
	}
	console.log("[6] /help intercepted, no SDK leak");

	// --- 6. /new works (snapshot after new_chat, no error) ---
	c.send({ type: "prompt", text: "/new" });
	const newChat = await c.wait((m) => m.type === "conversations", 6000);
	if (!newChat.activeId) {
		throw new Error("FAIL: /new did not create a conversation");
	}
	console.log(`[7] /new → active conversation ${newChat.activeId.slice(0, 8)}…`);

	// --- 8. /reload re-discovers resources and re-pushes the catalog ---
	c.send({ type: "prompt", text: "/reload" });
	const catReloaded = await c.wait(
		(m) => m.type === "slash_commands",
		20000,
	);
	const reloadNotice = await c.wait((m) => m.type === "notice", 8000);
	if (!reloadNotice.text.includes("已重新加载")) {
		throw new Error(`FAIL: /reload notice unexpected: ${reloadNotice.text}`);
	}
	const namesAfterReload = new Set(catReloaded.commands.map((x) => x.name));
	const missingAfterReload = NATIVE_NAMES.filter((n) => !namesAfterReload.has(n));
	if (missingAfterReload.length > 0) {
		throw new Error(
			`FAIL: builtin commands missing after /reload: ${missingAfterReload.join(", ")}`,
		);
	}
	console.log(
		`[8] /reload → catalog re-pushed (${catReloaded.commands.length} commands), ${reloadNotice.text}`,
	);

	c.close();
	server.kill();
	console.log("\n✅ SLASH-COMMAND CHECKS PASSED");
}

main().catch((e) => {
	console.error("❌", e.message);
	try {
		execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, {
			stdio: "ignore",
		});
	} catch {
		/* */
	}
	process.exit(1);
});
