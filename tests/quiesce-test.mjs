/**
 * Smoke test for the security hardening changes (issue #3):
 *   1. loopback-only binding + Origin/Host admission (cross-origin WS rejected)
 *   2. quiesce admission gate (new work rejected, existing socket survives)
 *   3. control socket status / quiesce / unquiesce
 *   4. headers stripped from models_config
 *
 * Run: node quiesce-test.mjs  (after npm run build)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { createConnection } from "node:net";

const PORT = 8911;
const REPO = resolve(process.cwd());
const DATA = mkdtempSync(join(tmpdir(), "pi-web-quiesce-"));
const HOST = "127.0.0.1";

let failures = 0;
function check(name, cond, extra = "") {
	if (cond) {
		console.log(`  ✅ ${name}`);
	} else {
		failures++;
		console.log(`  ❌ ${name} ${extra}`);
	}
}

const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA,
		PI_WEB_CWD: REPO,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 15000, desc = "") {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await pred()) return true;
		await sleep(200);
	}
	console.log(`  ⚠ waitFor timed out: ${desc}`);
	return false;
}

/** Send one command over the control socket; resolves parsed reply or null. */
function control(cmd) {
	const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${PORT}` : join(DATA, "pi-web-ui.sock");
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

/** Open a WS with an explicit Origin; resolves { opened, code, messages }. */
function openWs(origin, path = "/ws") {
	return new Promise((resolvePromise) => {
		const ws = new WebSocket(`ws://${HOST}:${PORT}${path}`, {
			origin,
			headers: { host: `${HOST}:${PORT}` },
		});
		const messages = [];
		let opened = false;
		let closed = false;
		const timer = setTimeout(() => {
			ws.terminate();
			resolvePromise({ opened, closed, code: undefined, messages });
		}, 4000);
		ws.on("open", () => {
			opened = true;
			clearTimeout(timer);
			// handshake + attach
			ws.send(JSON.stringify({ type: "hello", clientId: "tester" }));
			// 首次创建 ClientSession 含 runtime 初始化，负载高时可能超 1s ——
			// 给足握手+首帧 snapshot 时间（总上限仍由外层 4s timer 兒底）。
			setTimeout(() => resolvePromise({ opened, closed, code: undefined, messages }), 2500);
		});
		ws.on("message", (d) => {
			try {
				messages.push(JSON.parse(d.toString()));
			} catch {
				/* ignore */
			}
		});
		ws.on("close", (code) => {
			closed = true;
			clearTimeout(timer);
			resolvePromise({ opened, closed, code, messages });
		});
		ws.on("error", () => {
			/* handled by close */
		});
	});
}

/** Send a prompt and wait for the rejection notice. */
async function sendPromptAndCheck(origin) {
	const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`, {
		origin,
		headers: { host: `${HOST}:${PORT}` },
	});
	const notices = [];
	let ready = false;
	await new Promise((resolvePromise) => {
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: "tester" })));
		ws.on("message", (d) => {
			const m = JSON.parse(d.toString());
			if (m.type === "ready") {
				ready = true;
				ws.send(JSON.stringify({ type: "prompt", text: "你好，这是测试消息" }));
			}
			if (m.type === "notice") notices.push(m);
		});
		ws.on("close", () => resolvePromise());
		setTimeout(() => resolvePromise(), 5000);
	});
	ws.terminate();
	return { ready, notices };
}

async function main() {
	try {
		console.log(`[1] server on :${PORT} (data=${DATA})`);
		const up = await waitFor(
			async () => {
				const st = await control("status");
				return st?.ok === true;
			},
			20000,
			"server start",
		);
		check("server started + control socket reachable", up);
		if (!up) {
			console.log(serverLog);
			return;
		}

		console.log("\n[2] control socket: status");
		const st = await control("status");
		check("status ok", st?.ok === true);
		check("status has pid", typeof st?.pid === "number");
		check("status quiesced=false initially", st?.quiesced === false);
		check("status cwd=repo", st?.cwd === REPO);

		console.log("\n[3] Origin admission (HTTP-level)");
		// Cross-origin must NOT open.
		const evil = await openWs("https://evil.example");
		check("cross-origin rejected (not open)", !evil.opened, JSON.stringify(evil));
		// Same-authority must open + get ready.
		const same = await openWs(`http://${HOST}:${PORT}`);
		check("same-authority opens", same.opened);
		check(
			"same-authority got ready + snapshot",
			same.messages.some((m) => m.type === "ready") && same.messages.some((m) => m.type === "snapshot"),
		);
		// Different PORT same host → must be rejected.
		const diffPort = await openWs(`http://${HOST}:${PORT + 1}`);
		check("different-port origin rejected", !diffPort.opened, JSON.stringify(diffPort));

		console.log("\n[4] headers stripped from models_config");
		const cfg = await control("status"); // models_config is pushed on attach; check via a fresh ws
		const ws2 = await new Promise((resolvePromise) => {
			const w = new WebSocket(`ws://${HOST}:${PORT}/ws`, {
				origin: `http://${HOST}:${PORT}`,
				headers: { host: `${HOST}:${PORT}` },
			});
			const msgs = [];
			w.on("open", () => {
				w.send(JSON.stringify({ type: "hello", clientId: "tester" }));
			});
			w.on("message", (d) => {
				const m = JSON.parse(d.toString());
				msgs.push(m);
				if (m.type === "ready") {
					w.send(JSON.stringify({ type: "list_models_config" }));
				}
				if (m.type === "models_config") resolvePromise({ w, msgs });
			});
			w.on("close", () => resolvePromise({ w, msgs }));
			setTimeout(() => resolvePromise({ w, msgs }), 4000);
		});
		const mc = ws2.msgs.find((m) => m.type === "models_config");
		if (mc) {
			const leaked = (mc.providers ?? []).some((p) => "headers" in p);
			check("models_config has no headers field", !leaked);
		} else {
			check("models_config received", false);
		}
		ws2.w?.terminate();

		console.log("\n[5] quiesce admission gate");
		const q = await control("quiesce");
		check("quiesce command ok", q?.ok === true);
		const st2 = await control("status");
		check("status now quiesced=true", st2?.quiesced === true);
		check("status quiescedSince present", typeof st2?.quiescedSince === "number");

		// New prompt on an EXISTING client must be rejected with a notice.
		const { ready, notices } = await sendPromptAndCheck(`http://${HOST}:${PORT}`);
		check("existing client attaches while quiesced", ready);
		check(
			"prompt rejected with notice",
			notices.some((n) => n.level === "error" && /quiesce/.test(n.text)),
			JSON.stringify(notices),
		);

		// Brand-new client attach must be refused and socket closed (4403).
		const fresh = await openWs(`http://${HOST}:${PORT}`, "/ws"); // clientId "tester" reused... use unique id
		const fresh2 = await (async () => {
			const w = new WebSocket(`ws://${HOST}:${PORT}/ws`, {
				origin: `http://${HOST}:${PORT}`,
				headers: { host: `${HOST}:${PORT}` },
			});
			return new Promise((resolvePromise) => {
				let closed = false;
				let code = undefined;
				w.on("open", () => {
					w.send(JSON.stringify({ type: "hello", clientId: "brand-new-client" }));
				});
				w.on("close", (c) => {
					closed = true;
					code = c;
					resolvePromise({ closed, code });
				});
				w.on("error", () => {});
				setTimeout(() => resolvePromise({ closed, code }), 4000);
			});
		})();
		check("brand-new client attach refused (closed)", fresh2.closed);
		check("brand-new client closed with 4403", fresh2.code === 4403, `code=${fresh2.code}`);

		// unquiesce
		const uq = await control("unquiesce");
		check("unquiesce ok", uq?.ok === true);
		const st3 = await control("status");
		check("status quiesced=false after unquiesce", st3?.quiesced === false);

		console.log("\n[6] unknown control command");
		const bad = await control("explode");
		check("unknown cmd → {ok:false}", bad?.ok === false);

		console.log("\n" + (failures === 0 ? "🎉 ALL PASS" : `💥 ${failures} FAILURES`));
	} finally {
		server.kill("SIGTERM");
		await sleep(500);
		if (serverLog.includes("Error")) console.log("--- server log tail ---\n" + serverLog.slice(-2000));
		process.exit(failures === 0 ? 0 : 1);
	}
}

main();
