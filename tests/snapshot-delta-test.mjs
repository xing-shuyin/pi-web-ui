import { portUp, freePort } from "./lib/port-utils.mjs";
import { waitAttachSettled } from "./lib/attach-settle.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8943;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-snapdelta-test-"));
let server = null;

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: REPO_ROOT,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return;
		} catch {}
	}
	throw new Error("server did not start");
}

try {
	await startServer();
	const { default: WebSocket } = await import("ws");
	const ws = new WebSocket(URL);

	const stream = [];
	const lastRevOf = (m) => (m.type === "snapshot" ? m.state.rev : m.rev);
	let sawReady = false;
	let sawSchedulerTasks = false;
	ws.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		if (msg.type === "ready") sawReady = true;
		if (msg.type === "scheduler_tasks") sawSchedulerTasks = true;
		if (msg.type === "snapshot" || msg.type === "snapshot_delta") stream.push(msg);
	});

	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "snapdelta-test" }));
	for (let i = 0; i < 100 && !sawReady; i++) await sleep(50);
	check("ready received with protocolVersion=2", sawReady);

	const settled = await waitAttachSettled({ sawReady: () => sawReady, sawMarker: () => sawSchedulerTasks });
	check("attach burst settled (scheduler_tasks arrived)", settled);
	stream.length = 0;

	const fullCount = () => stream.filter((m) => m.type === "snapshot").length;

	stream.length = 0;
	ws.send(JSON.stringify({ type: "get_state" }));
	for (let i = 0; i < 60 && fullCount() === 0; i++) await sleep(50);
	const full1 = stream.find((m) => m.type === "snapshot");
	check("get_state returns FULL snapshot", !!full1);
	check(
		"full snapshot carries messages array + numeric rev",
		Array.isArray(full1?.state?.messages) && typeof full1?.state?.rev === "number",
	);
	const idxBeforePrompt = stream.length;
	let lastRev = stream.length > 0 ? lastRevOf(stream[stream.length - 1]) : 1;
	ws.send(JSON.stringify({ type: "prompt", text: "/model" }));
	for (let i = 0; i < 100 && stream.length <= idxBeforePrompt; i++) await sleep(50);
	const newMsgs = stream.slice(idxBeforePrompt);
	const d = newMsgs.find((m) => m.type === "snapshot_delta");
	check("emission after native slash prompt arrived as delta", !!d, `${newMsgs.length} new msg(s)`);
	if (d) {
		const di = stream.indexOf(d);
		const prevRev = di > 0 ? lastRevOf(stream[di - 1]) : lastRev;
		check("delta chains onto immediately preceding rev", d.baseRev === prevRev, `${d.baseRev} vs ${prevRev}`);
		check("delta state has NO messages field", !("messages" in d.state));
		check("delta appended is an array", Array.isArray(d.appended));
		check(
			"delta state still carries conversationId/streamingMessage/stats/rev",
			typeof d.state.conversationId === "string" &&
				"streamingMessage" in d.state &&
				typeof d.state.stats === "object" &&
				d.state.rev === d.rev,
		);
	}

	let prevRev = null;
	let chainOk = true;
	let sawFullAfterDelta = false;
	for (const m of [...stream]) {
		if (m.type === "snapshot") {
			if (prevRev !== null && !(m.state.rev > prevRev)) chainOk = false;
			prevRev = m.state.rev;
		} else {
			if (prevRev !== null && m.baseRev !== prevRev) chainOk = false;
			prevRev = m.rev;
			sawFullAfterDelta = true;
		}
	}
	check("rev chain continuous across all emissions", chainOk);

	stream.length = 0;
	ws.send(JSON.stringify({ type: "get_state" }));
	for (let i = 0; i < 60 && fullCount() === 0; i++) await sleep(50);
	check("get_state after deltas returns full again", fullCount() > 0);

	ws.close();
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	server?.kill("SIGTERM");
	await freePort(PORT);
	process.exit(failures === 0 ? 0 : 1);
}
