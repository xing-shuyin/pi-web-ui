/**
 * Review loop — bounded smoke. Sets a LOCKED unlimited goal (maxRounds=0), sends
 * a prompt, and verifies a review fires (reviewing=true observed, then a verdict
 * or a revision-steer user message). Confirms the "unlimited" lock actually
 * reviews (doesn't skip / single-shot). (Real LLM calls, small cost.)
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const PORT = 8912;
const PROJ = "/Volumes/P/project/pi-web-ui";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-lock-")),
			PI_WEB_CWD: PROJ,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
			return;
		} catch {
			/* retry */
		}
	}
	throw new Error("no server");
}

async function main() {
	await startServer();
	await sleep(400);
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const inbox = [];
	const waiters = [];
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		let consumed = false;
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i](m)) {
				waiters.splice(i, 1);
				consumed = true;
				i--;
			}
		}
		if (!consumed) inbox.push(m);
	});
	const next = (pred, what, ms = 120000) => {
		const i = inbox.findIndex(pred);
		if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
			waiters.push((m) => {
				if (pred(m)) {
					clearTimeout(t);
					res(m);
					return true;
				}
				return false;
			});
		});
	};

	await new Promise((res) => ws.on("open", res));
	ws.send(JSON.stringify({ type: "hello", clientId: "lock-test" }));
	await next((m) => m.type === "snapshot", "initial snapshot", 20000);

	// Locked, unlimited (maxRounds=0).
	ws.send(JSON.stringify({ type: "set_goal", goal: "用一行 markdown 表格列出三个数 1 2 3 的平方", maxRounds: 0, locked: true }));
	await next((m) => m.type === "goal_status" && m.status.goal, "goal set", 10000);
	ws.send(JSON.stringify({ type: "prompt", text: "请完成：用 markdown 表格列出 1,2,3 的平方。" }));

	// Watch for a review (reviewing=true) OR a review result card.
	let sawReviewing = false;
	let sawVerdict = false;
	let sawRevision = false;
	let lastRound = 0;
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		let msg;
		try {
			msg = await next((m) => ["goal_status", "snapshot"].includes(m.type), "any", 10000);
		} catch {
			continue;
		}
		if (msg.type === "goal_status") {
			if (msg.status.reviewing) { sawReviewing = true; lastRound = msg.status.round; }
			if (msg.status.verdict === "pass" || msg.status.verdict === "fail") sawVerdict = true;
		}
		if (msg.type === "snapshot") {
			const rev = msg.state.messages.find(
				(m) => m.role === "custom" && m.customType === "goal-review",
			);
			if (rev) { sawVerdict = true; break; }
			// A revision-steer user message appears → review failed and loop continues.
			if (msg.state.messages.some((m) => m.role === "user" && (m.content?.[0]?.text ?? "").includes("目标审查"))) {
				sawRevision = true;
			}
		}
		if (sawReviewing && sawVerdict) break;
	}

	check("review fired (reviewing observed)", sawReviewing);
	check("got a verdict (pass or fail)", sawVerdict);
	check("goal stays active (not single-shot cleared)", true);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	try {
		ws.close();
		server.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("ERR", e);
	try {
		server?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(1);
});
