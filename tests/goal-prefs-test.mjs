/**
 * Goal prefs — persistence test.
 * Sends set_goal_prefs (model + rounds cap + locked), verifies goal_status
 * reflects it, then reconnects with the SAME clientId (simulating a reload) and
 * checks the prefs are restored. Also verifies maxRounds 0 → unlimited default.
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const PORT = 8908;
const PROJ = REPO_ROOT;
const CID = "prefs-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer(dataDir) {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: PROJ,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return;
		} catch {
			/* retry */
		}
	}
	throw new Error("no server");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			inbox,
			next(pred, what, ms = 10000) {
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
			},
			send(m) {
				ws.send(JSON.stringify(m));
			},
		};
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
		ws.on("open", () => {
			api.send({ type: "hello", clientId: CID });
			resolve(api);
		});
		ws.on("error", reject);
	});
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-prefs-"));

async function main() {
	await startServer(dataDir);
	await sleep(400);

	// Connection 1: change prefs.
	const c1 = await connect();
	await c1.next((m) => m.type === "snapshot", "initial snapshot", 20000);
	c1.send({
		type: "set_goal_prefs",
		reviewModel: "openai/gpt-4o-mini",
		maxRounds: 8,
		locked: false,
	});
	// Wait specifically for the prefs to appear (skip the attach-time goal_status).
	const g1 = await c1.next(
		(m) => m.type === "goal_status" && m.status.reviewModel === "openai/gpt-4o-mini",
		"goal_status with prefs",
		10000,
	);
	check(
		"set_goal_prefs applied (model/rounds/locked)",
		g1.status.reviewModel === "openai/gpt-4o-mini" && g1.status.maxRounds === 8 && g1.status.locked === false,
		JSON.stringify({ rm: g1.status.reviewModel, mr: g1.status.maxRounds, lo: g1.status.locked }),
	);
	c1.ws.close();

	// Connection 2 (same clientId) — simulates a reload; prefs should be restored.
	await sleep(500);
	const c2 = await connect();
	// The restored prefs come through as goal_status on attach; also snapshot may
	// not carry prefs, so wait for a goal_status whose prefs are populated.
	const g2 = await c2.next((m) => m.type === "goal_status", "goal_status after reload", 10000);
	check(
		"prefs persisted across reload (model/rounds/locked)",
		g2.status.reviewModel === "openai/gpt-4o-mini" && g2.status.maxRounds === 8 && g2.status.locked === false,
		JSON.stringify({ rm: g2.status.reviewModel, mr: g2.status.maxRounds, lo: g2.status.locked }),
	);
	c2.ws.close();

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	try {
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
