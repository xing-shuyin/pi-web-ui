/**
 * Goal wizard — live smoke test.
 *
 * Drives the collaborative target wizard over raw WebSocket: sends a raw
 * requirement, answers each dialog question (goal_ask) it pushes via
 * `dialog_response`, and verifies the refined goal gets auto-set.
 * Requires a working model (real LLM calls, small cost).
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const PORT = 8905;
const PROJ = "/Volumes/P/project/pi-web-ui";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-wiz-")),
		PI_WEB_CWD: PROJ,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

async function waitUp() {
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

(async () => {
	await waitUp();
	await sleep(400);
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const inbox = [];
	const waiters = [];
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		// Resolve pending waiters WITHOUT leaving the message in inbox (so it is
		// not consumed twice). If no waiter matched, keep it in inbox for next().
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
	const next = (pred, what, ms = 60000) => {
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
	ws.send(JSON.stringify({ type: "hello", clientId: "wiz-live" }));
	await next((m) => m.type === "snapshot", "initial snapshot");

	console.log("Starting goal wizard…");
	ws.send(
		JSON.stringify({ type: "start_goal_wizard", text: "写一个打开即用的文件去重小工具", maxRounds: 3 }),
	);

	let sawWizardActive = false;
	let answered = 0;
	const deadline = Date.now() + 120000;
	let setGoalSeen = null;
	let kickOffSeen = false;
	while (Date.now() < deadline) {
		let msg;
		try {
			msg = await next((m) => m.type === "dialog" || m.type === "goal_status" || m.type === "notice", "any", 15000);
		} catch {
			// inner timeout — check whether a goal was already set
			msg = null;
		}
		if (!msg) {
			const g = inbox.find((m) => m.type === "goal_status");
			if (g && g.status.goal) { setGoalSeen = g.status.goal; break; }
			continue;
		}
		if (msg.type === "dialog") {
			sawWizardActive = true;
			answered += 1;
			console.error(`[d] Q${answered} (id=${msg.id}) → ${(msg.args?.[0] || "?").toString().slice(0, 50)}`);
			// Answer multiple-choice by picking the first option; else free text.
			const opts = msg.args?.[0];
			const val = Array.isArray(opts) && opts.length > 0 ? opts[0] : "都可以，你决定";
			ws.send(JSON.stringify({ type: "dialog_response", id: msg.id, value: val }));
		}
		if (msg.type === "goal_status" && msg.status.goal && !setGoalSeen) {
			setGoalSeen = msg.status.goal;
			console.error(`[d] goal set: ${msg.status.goal.slice(0, 60)}`);
			// After goal set, the wizard should AUTO-KICK generation (no "开始吧").
			// Wait a few seconds for the kick-off user message (# it's the marker
			// text injected by startGoalWizard) to appear in a snapshot.
			try {
				const snap = await next(
					(m) =>
						m.type === "snapshot" &&
						m.state.messages.some((mm) =>
							(mm.content?.[0]?.text ?? "").startsWith("【目标已设定】"),
						),
					"auto-generate kick-off user message",
					30000,
				);
				kickOffSeen = true;
				console.error("[d] auto-generate kicked off ✓");
			} catch {
				kickOffSeen = false;
			}
		}
		if (msg.type === "snapshot" && kickOffSeen) break;
	}
	await sleep(300);

	check("wizard went active (asked questions)", sawWizardActive, `answered=${answered}`);
	check("refined goal auto-set", Boolean(setGoalSeen), setGoalSeen || "none");
	check("auto-generated after survey (no manual 开始吧)", kickOffSeen);
	if (!setGoalSeen) {
		const g = inbox.find((m) => m.type === "goal_status");
		console.error("[d] last goal_status:", JSON.stringify(g));
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	try {
		ws.close();
		server.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("ERR", e);
	try {
		server?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(1);
});
