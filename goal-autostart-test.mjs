/**
 * Direct goal set — auto-start test.
 * Sends set_goal (NO AI-提炼 / no wizard) and confirms the main agent is
 * auto-triggered to generate (a "【目标已设定】" user message appears in a
 * snapshot). No reliance on the model completing.
 *
 * Robust harness: server-startup check + WebSocket open/error/close handled,
 * so it can never hang forever — every await has a bounded timeout.
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */
const PORT = 8916;
const PROJ = "/Volumes/P/project/pi-web-ui";

async function waitPort(ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
			return true;
		} catch {
			await sleep(250);
		}
	}
	return false;
}

function openSocket(url, ms) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => { ws.terminate(); reject(new Error("ws connect timeout")); }, ms);
		ws.on("open", () => { clearTimeout(t); resolve(ws); });
		ws.on("error", (e) => { clearTimeout(t); reject(e); });
	});
}

function mkWaiters() {
	const inbox = [];
	const waiters = [];
	const onMsg = (m) => {
		let handled = false;
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].test(m)) { const r = waiters[i]; waiters.splice(i, 1); clearTimeout(r.t); r.res(m); handled = true; break; }
		}
		if (!handled) inbox.push(m);
	};
	const next = (pred, what, ms) => new Promise((res, rej) => {
		const withTimeout = (m) => {
			const mm = m;
			try { return pred(mm); } catch { return false; }
		};
		const i = inbox.findIndex(withTimeout);
		if (i >= 0) return res(inbox.splice(i, 1)[0]);
		const t = setTimeout(() => rej(new Error("timeout: " + what)), ms);
		waiters.push({ test: withTimeout, res, rej, t });
	});
	return { inbox, onMsg, next };
}

(async () => {
	// PORT should be free at start (fresh data dir); if already in use, bail clearly.
	if (await waitPort(0)) { console.error("PORT already in use at start; aborting"); process.exit(1); }
	const dataDir = mkdtempSync(join(tmpdir(), "pi-web-autostart-"));
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: PROJ },
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

	const up = await waitPort(25000);
	if (!up) { console.error("server did not start"); try { server.kill("SIGKILL"); } catch {} process.exit(1); }

	const ws = await openSocket(`ws://localhost:${PORT}/ws`, 10000);
	const { onMsg, next } = mkWaiters();
	ws.on("message", (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } onMsg(m); });

	ws.send(JSON.stringify({ type: "hello", clientId: "autostart" }));
	try { await next((m) => m.type === "snapshot", "snapshot", 20000); } catch {}

	// Direct goal set (maxRounds 0 = unlimited, locked).
	ws.send(JSON.stringify({ type: "set_goal", goal: "帮我写一句自我介绍。", maxRounds: 0, locked: true }));

	// Expect the auto-start kick-off user message in a snapshot.
	let kickoff = false;
	try {
		await next(
			(m) => m.type === "snapshot" && m.state.messages.some((mm) => (mm.content?.[0]?.text ?? "").startsWith("【目标已设定】")),
			"auto-start kick-off",
			20000,
		);
		kickoff = true;
		console.log("[d] auto-start fired after direct set_goal ✓");
	} catch {
		kickoff = false;
		console.log("[d] NO auto-start after direct set_goal");
	}

	console.log(kickoff ? "✓ direct set_goal auto-starts generation" : "✗ direct set_goal did NOT auto-start");
	try { ws.close(); if (server.pid) process.kill(server.pid, "SIGKILL"); } catch {}
	process.exit(kickoff ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
