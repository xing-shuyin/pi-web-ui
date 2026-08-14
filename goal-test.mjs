/**
 * Goal / review — protocol smoke test.
 *
 * Verifies the full wire path for set_goal / goal_status / clear_goal WITHOUT
 * triggering a real review (a review needs an actual LLM call, so it's skipped
 * here — this test only proves the status machine + socket round-trip).
 *
 * Runs against the compiled server on a dedicated port (8901).
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const PORT = 8901;
const URL = `ws://localhost:${PORT}/ws`;
const PROJ = "/Volumes/P/project/pi-web-ui";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-goal-test-"));
let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
			return;
		} catch {
			// not up yet
		}
	}
	throw new Error("server did not start");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			inbox,
			/** Wait for the next message matching a predicate (with timeout). */
			async next(pred, what, ms = 8000) {
				const existing = inbox.findIndex(pred);
				if (existing >= 0) return inbox.splice(existing, 1)[0];
				return new Promise((res, rej) => {
					const t = setTimeout(
						() => rej(new Error(`timeout waiting for ${what}`)),
						ms,
					);
					waiters.push((m) => {
						if (pred(m)) {
							clearTimeout(t);
							res(m);
							return true;
						}
						return false;
					});
				});
			},
			send(m) {
				ws.send(JSON.stringify(m));
			},
		};
		ws.onopen = () => {
			api.send({ type: "hello", clientId: "goal-test" });
			resolve(api);
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			inbox.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i](msg)) {
					waiters.splice(i, 1);
					i--;
				}
			}
		};
		ws.onerror = reject;
	});
}

async function run() {
	await startServer();
	await sleep(300);
	const c = await connect();

	// 1) Set a locked goal with a reviewer model and maxRounds.
	c.send({
		type: "set_goal",
		goal: "把首页标题改为 Goal Buddy",
		reviewModel: "openai/gpt-4o-mini",
		maxRounds: 2,
		locked: true,
	});
	const g1 = await c.next(
		(m) => m.type === "goal_status" && m.status.goal === "把首页标题改为 Goal Buddy",
		"goal_status after set",
	);
	check(
		"set_goal sets status",
		g1.status.goal === "把首页标题改为 Goal Buddy",
		JSON.stringify(g1.status),
	);
	check(
		"locked + reviewModel + maxRounds carried",
		g1.status.locked === true &&
			g1.status.reviewModel === "openai/gpt-4o-mini" &&
			g1.status.maxRounds === 2,
		JSON.stringify(g1.status),
	);
	check("verdict resets to pending", g1.status.verdict === "pending");

	// 2) Clear it.
	c.send({ type: "clear_goal" });
	const g2 = await c.next(
		(m) => m.type === "goal_status" && m.status.goal === null,
		"goal_status after clear",
	);
	check("clear_goal clears the goal", g2.status.goal === null, JSON.stringify(g2.status));

	// 3) Single-shot (locked=false).
	c.send({ type: "set_goal", goal: "只审查这一轮", maxRounds: 3, locked: false });
	const g3 = await c.next(
		(m) => m.type === "goal_status" && m.status.goal === "只审查这一轮",
		"goal_status single-shot",
	);
	check(
		"single-shot locked=false",
		g3.status.locked === false && g3.status.maxRounds === 3,
		JSON.stringify(g3.status),
	);

	c.send({ type: "clear_goal" });
	await c.next(
		(m) => m.type === "goal_status" && m.status.goal === null,
		"goal_status cleared again",
	);

	// 4) Empty goal text should clear, not set. Drain any stragglers first.
	c.inbox.length = 0;
	c.send({ type: "set_goal", goal: "", maxRounds: 3, locked: true });
	const g4 = await c.next(
		(m) => m.type === "goal_status" && m.status.goal === null,
		"goal_status empty set",
	);
	check(
		"empty goal treated as clear",
		g4.status.goal === null,
		`goal=${JSON.stringify(g4.status.goal)}`,
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	try {
		c.ws.close();
		server.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("test error:", err);
	try {
		server?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(1);
});
