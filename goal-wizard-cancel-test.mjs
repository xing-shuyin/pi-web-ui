/**
 * Goal wizard — cancellation test.
 *
 * Starts a wizard, answers the first question, then sends clear_goal (the ✗
 * button). Verifies the browser dialog is closed (dialog_closed), the wizard
 * status clears, and NO goal is auto-set.
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const PORT = 8906;
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
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-wizcan-")),
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
	const next = (pred, what, ms = 30000) => {
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
	ws.send(JSON.stringify({ type: "hello", clientId: "wiz-cancel" }));
	await next((m) => m.type === "snapshot", "initial snapshot");

	ws.send(JSON.stringify({ type: "start_goal_wizard", text: "写一个文件同步工具", maxRounds: 4 }));

	// Wait for the FIRST question dialog, then cancel via clear_goal.
	const d1 = await next((m) => m.type === "dialog", "first question", 40000);
	console.error(`[d] got Q (id=${d1.id}): ${(d1.args?.[0] || "").toString().slice(0, 50)}`);
	check("wizard asked a question", true);

	// User clicks ✗ → clear_goal.
	ws.send(JSON.stringify({ type: "clear_goal" }));

	// Expect a dialog_closed for that dialog (the browser modal must close).
	try {
		const closed = await next(
			(m) => m.type === "dialog_closed" && m.id === d1.id,
			"dialog_closed for the wizard question",
			15000,
		);
		check("dialog closed on cancel", closed.id === d1.id);
	} catch {
		check("dialog closed on cancel", false, "no dialog_closed");
	}

	// Wizard status should return to inactive (no active=goal).
	await sleep(1200);
	const gs = inbox.filter((m) => m.type === "goal_status");
	const last = gs[gs.length - 1];
	const wizardInactive = last && last.status.wizard && last.status.wizard.active === false;
	const noGoal = last ? last.status.goal === null : true;
	check("wizard went inactive after cancel", Boolean(wizardInactive), JSON.stringify(last?.status?.wizard));
	check("no goal auto-set on cancel", noGoal);

	// Wait a moment to ensure no delayed goal_set arrives.
	await sleep(2000);
	const lateGoal = inbox.some(
		(m) => m.type === "goal_status" && m.status.goal && m.status.goal !== null,
	);
	check("no goal set even after waiting", !lateGoal);

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
