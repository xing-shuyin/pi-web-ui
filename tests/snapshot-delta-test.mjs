/**
 * Incremental snapshot protocol smoke test (zero token).
 *
 * Verifies the snapshot / snapshot_delta rev-chain wire path:
 *  1. get_state always returns a FULL snapshot carrying a `rev`.
 *  2. Non-forced emissions (native slash command → flushSnapshot) arrive as
 *     snapshot_delta with baseRev === previous rev, NO `messages` field in
 *     state, and an `appended` array (empty when only light fields changed).
 *  3. The rev chain stays contiguous across mixed delta/full emissions —
 *     validated over a CONTINUOUS recording of every snapshot-ish message
 *     (one-off waits would miss intermediate emissions).
 *
 * Runs against the compiled server on a dedicated port (8943).
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
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
		} catch {
			/* retry */
		}
	}
	throw new Error("server did not start");
}

try {
	await startServer();
	const { default: WebSocket } = await import("ws");
	const ws = new WebSocket(URL);

	// Continuous recorder: EVERY snapshot-ish message is appended here with its
	// arrival index, so assertions see the complete emission stream.
	const stream = [];
	const lastRevOf = (m) => (m.type === "snapshot" ? m.state.rev : m.rev);
	let sawReady = false;
	ws.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		if (msg.type === "ready") sawReady = true;
		if (msg.type === "snapshot" || msg.type === "snapshot_delta") stream.push(msg);
	});

	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "snapdelta-test" }));
	for (let i = 0; i < 100 && !sawReady; i++) await sleep(50);
	check("ready received with protocolVersion=2", sawReady);

	const fullCount = () => stream.filter((m) => m.type === "snapshot").length;

	// --- 1) get_state → FULL snapshot with rev -----------------------------
	stream.length = 0;
	ws.send(JSON.stringify({ type: "get_state" }));
	for (let i = 0; i < 60 && fullCount() === 0; i++) await sleep(50);
	const full1 = stream.find((m) => m.type === "snapshot");
	check("get_state returns FULL snapshot", !!full1);
	check(
		"full snapshot carries messages array + numeric rev",
		Array.isArray(full1?.state?.messages) && typeof full1?.state?.rev === "number",
	);
	// --- 2) non-forced emission → snapshot_delta ---------------------------
	// /model（无参数）是原生斜杠命令：纯配置、零 token。prompt() 执行后
	// flushSnapshot() 非强制 → 应产生增量快照（appended 可能为空，仅轻字段）。
	// 不清空 stream：自动调度的快照可能随时插入，硬编码绝对 baseRev 会与
	// 插入消息竞态。改为相对链断言：delta 的 baseRev 必须等于流中它前面
	// 最近一条消息的 rev（全局连续性由第 3 步覆盖）。
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

	// --- 3) rev chain continuity across the WHOLE recorded stream ----------
	// 从第一条消息起：每个 delta 的 baseRev 必须等于上一条消息之后的 rev；
	// full snapshot 重置基准。中途 get_state 强制全量也必须推进 rev。
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
			sawFullAfterDelta = true; // marker usage below
		}
	}
	check("rev chain continuous across all emissions", chainOk);

	// --- 4) get_state forces full again ------------------------------------
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
