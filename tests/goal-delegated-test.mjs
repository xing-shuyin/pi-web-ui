import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8907);
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-goal-delegated-"));

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: REPO_ROOT,
		PI_WEB_TOOL_TIMEOUT_MS: "12000",
	},
	stdio: "ignore",
});
for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
let conversations = [];
let goalStatus = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = { ...snapshot, ...m.state, messages: [...(snapshot.messages ?? []), ...m.appended] };
		}
	} else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "goal_status") goalStatus = m.status;
});

const waitFor = async (pred, what, timeout = 15000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};

const execRows = (parentId) => (conversations ?? []).filter((c) => c.parentId === parentId);

try {
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() })));
	await waitFor(() => snapshot !== null, "initial snapshot");
	const mainId = snapshot?.conversationId;
	check("主对话已就绪", typeof mainId === "string" && mainId.length > 0, mainId ?? "(none)");

	send({
		type: "set_goal",
		goal: "把 README 的安装说明补全",
		maxRounds: 1,
		locked: true,
	});
	await waitFor(
		() => goalStatus?.goal === "把 README 的安装说明补全" && !!goalStatus?.roles?.executor?.convId,
		"goal_status with executor",
	);

	check(
		"reviewMode 已从协议移除（只剩一条路径）",
		goalStatus?.reviewMode === undefined,
		String(goalStatus?.reviewMode),
	);
	check("execModel 字段存在（新后端标志）", goalStatus?.execModel === null, String(goalStatus?.execModel));
	const execId = goalStatus?.roles?.executor?.convId;
	check("服务端拉起了常驻执行对话", typeof execId === "string" && execId.length > 0, execId ?? "(none)");
	check(
		"循环相位已进入执行/审查",
		goalStatus?.phase === "executing" || goalStatus?.phase === "reviewing" || goalStatus?.phase === "blocked",
		String(goalStatus?.phase),
	);

	await waitFor(() => execRows(mainId).some((r) => r.id === execId), "executor row in conversations");
	const row = execRows(mainId).find((r) => r.id === execId);
	check("左栏出现执行对话（挂在主对话下）", !!row, row ? `${row.id} · ${row.title}` : "(missing)");
	check(
		"执行对话是落盘对话（无「子代理」微标 + 带目标执行标题）",
		!!row && row.isSubagent === false && /^\[(目标执行|Goal executor)\]/.test(String(row.title)),
		row ? `${row.isSubagent} · ${row.title}` : "",
	);

	const mainTexts = (snapshot?.messages ?? [])
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
	check("主对话没收到「请开始实现」kick（它是审查者）", !mainTexts.includes("请现在开始实现"));

	send({ type: "clear_goal" });
	await waitFor(() => goalStatus?.goal === null, "goal_status cleared");
	const removed = await waitFor(() => !execRows(mainId).some((r) => r.id === execId), "executor row removed");
	check("清目标后执行对话被移出左栏", removed);
} catch (err) {
	check(`冒烟异常：${err instanceof Error ? err.message : String(err)}`, false);
} finally {
	try {
		ws.close();
	} catch {}
	server.kill();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
