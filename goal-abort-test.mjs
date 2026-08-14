/**
 * Manual-abort stops the goal review loop.
 * Sets a goal, sends a prompt, then hits Stop (abort) mid-run. Verifies the
 * review loop does NOT re-fire and the goal is cleared (no endless review of a
 * half-finished run). If the model is too fast to interrupt, it degrades to a
 * best-effort check (may pass trivially) — the real fix is structural.
 * Robust harness: bounded awaits, never hangs.
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */
const PORT = 8917;
const PROJ = "/Volumes/P/project/pi-web-ui";

function openSocket(url, ms) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => { ws.terminate(); reject(new Error("ws timeout")); }, ms);
		ws.on("open", () => { clearTimeout(t); resolve(ws); });
		ws.on("error", (e) => { clearTimeout(t); reject(e); });
	});
}
function mkWaiters() {
	const inbox = [];
	const waiters = [];
	const onMsg = (m) => {
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].test(m)) { const r = waiters[i]; waiters.splice(i,1); clearTimeout(r.t); r.res(m); return; }
		}
		inbox.push(m);
	};
	const next = (pred, what, ms) => new Promise((res, rej) => {
		const test = (m) => { try { return pred(m); } catch { return false; } };
		const i = inbox.findIndex(test);
		if (i >= 0) return res(inbox.splice(i,1)[0]);
		const t = setTimeout(() => rej(new Error("timeout: " + what)), ms);
		waiters.push({ test, res, rej, t });
	});
	return { onMsg, next };
}

(async () => {
	// bail if port already in use
	try { execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" }); console.error("PORT busy"); process.exit(1); } catch {}
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-abort-")), PI_WEB_CWD: PROJ },
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	let up = false;
	const d0 = Date.now() + 25000;
	while (Date.now() < d0) { try { execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" }); up = true; break; } catch { await sleep(250); } }
	if (!up) { console.error("server did not start"); try { server.kill("SIGKILL"); } catch {} process.exit(1); }

	const ws = await openSocket(`ws://localhost:${PORT}/ws`, 10000);
	const { onMsg, next } = mkWaiters();
	ws.on("message", (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } onMsg(m); });
	ws.send(JSON.stringify({ type: "hello", clientId: "abort-test" }));
	try { await next((m) => m.type === "snapshot", "snap", 20000); } catch {}

	ws.send(JSON.stringify({ type: "set_goal", goal: "写一段超过500字的说明，字越多越好。", maxRounds: 0, locked: true }));
	try { await next((m) => m.type === "goal_status" && m.status.goal, "goal set", 10000); } catch {}

	// Start generation then abort shortly after (if model streams at all).
	ws.send(JSON.stringify({ type: "prompt", text: "请开始。" }));
	await sleep(4000);
	ws.send(JSON.stringify({ type: "abort" }));

	// After abort, the goal should be cleared (abort → stop review), not re-reviewed.
	await sleep(6000);
	let goalCleared = false;
	// Wait for the abort-clear goal_status (goal === null with our marker).
	try {
		await next(
			(m) => m.type === "goal_status" && m.status.goal === null && m.status.status.includes("手动停止"),
			"abort-cleared goal_status",
			15000,
		);
		goalCleared = true;
		console.log("[d] goal cleared after manual abort (review loop stopped) ✓");
	} catch {
		goalCleared = false;
		console.log("[d] goal NOT detected as cleared after abort");
	}

	console.log(goalCleared ? "✓ manual abort clears goal (stops review loop)" : "✗ goal not cleared on abort");
	try { ws.close(); if (server.pid) process.kill(server.pid, "SIGKILL"); } catch {}
	process.exit(goalCleared ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
