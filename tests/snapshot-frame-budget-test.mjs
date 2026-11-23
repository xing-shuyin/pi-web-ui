/**
 * 首屏 / 空转的出帧预算（issue #965）。
 *
 * 实测口径与 issue 正文一致：新连接 + 不动鼠标，统计每一帧的类型与字节。
 * 守的是「同一份内容不发第二遍」：冷开只该有 1 帧全量，之后内容没变就不发；
 * 客户端明确要全量（`get_state` 且对不上 rev）时必须照发——恢复路径不能被闸挡掉。
 *
 * 用 tsx 直接跑源码，不写 dist/（避免与其他并行任务抢构建产物）。
 * 端口按仓库规范 ≥ 8900。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8971);
const dataDir = mkdtempSync(join(tmpdir(), "pi-frame-budget-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-frame-budget-agent-"));
const workDir = mkdtempSync(join(tmpdir(), "pi-frame-budget-work-"));

/** 一份大会话：窗口外的消息不参与下发，所以帧大小由窗口决定，帧数才是这次要修的东西。 */
const SEED_TOTAL = 1500;
const SEED_TEXT = "x".repeat(400);

function seedLongSession() {
	const dir = join(agentDir, "sessions");
	mkdirSync(dir, { recursive: true });
	const id = "frame-budget-seed";
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd: workDir }),
	];
	let parentId = null;
	for (let i = 0; i < SEED_TOTAL; i++) {
		const entryId = `m${i + 1}`;
		const role = i % 2 === 0 ? "user" : "assistant";
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: `2026-08-04T00:00:${String(1 + (i % 59)).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z`,
				message: {
					role,
					content: [{ type: "text", text: `${role} ${i + 1} ${SEED_TEXT}` }],
					...(role === "assistant" ? { stopReason: "stop" } : {}),
					timestamp: 1722700800000 + (i + 1) * 1000,
				},
			}),
		);
		parentId = entryId;
	}
	writeFileSync(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
	return file;
}

const seedFile = seedLongSession();

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const server = spawn(
	process.execPath,
	["--import", "tsx", "--import", "./server/resolve-global-sdk.ts", "server/index.ts"],
	{
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: workDir,
			PI_WEB_PLUGIN_CATALOG_URL: "",
		},
		stdio: "ignore",
	},
);

const frames = [];
let snapshot = null;
let ready = false;

try {
	for (let i = 0; i < 120 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const clientId = randomUUID();
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	let seq = 0;
	const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

	ws.on("message", (d) => {
		const raw = d.toString();
		let m;
		try {
			m = JSON.parse(raw);
		} catch {
			return;
		}
		frames.push({
			type: m.type,
			bytes: Buffer.byteLength(raw),
			...(m.type === "snapshot" ? { sessionFile: m.state?.sessionFile } : {}),
		});
		if (m.type === "snapshot") snapshot = m.state;
		if (m.type === "ready") {
			ready = true;
			send({ type: "get_state" });
		}
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

	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	ws.send(JSON.stringify({ type: "hello", clientId }));
	await waitFor(() => ready && snapshot !== null, "第一个快照");

	const count = (type) => frames.filter((f) => f.type === type).length;
	const coldFull = count("snapshot");
	check("冷开只发 1 帧全量快照", coldFull === 1, `snapshot=${coldFull}`);
	check("冷开没有多余的增量帧", count("snapshot_delta") === 0, `delta=${count("snapshot_delta")}`);
	check("拿到 rev", typeof snapshot?.rev === "number", `rev=${snapshot?.rev}`);

	// 等握手尾巴（插件目录 / 会话列表）静下来，再量真正的空转
	let quietSince = Date.now();
	let seen = frames.length;
	while (Date.now() - quietSince < 1500) {
		await sleep(100);
		if (frames.length !== seen) {
			seen = frames.length;
			quietSince = Date.now();
		}
	}
	const beforeIdle = frames.length;
	await sleep(5000);
	const idleFrames = frames.slice(beforeIdle);
	const byType = new Map();
	for (const f of idleFrames) {
		const e = byType.get(f.type) ?? { n: 0, bytes: 0 };
		e.n++;
		e.bytes += f.bytes;
		byType.set(f.type, e);
	}
	if (process.env.PI_FRAME_DEBUG === "1") console.log(JSON.stringify([...byType]));
	const idleFull = idleFrames.filter((f) => f.type === "snapshot").length;
	check("空转期间不发全量快照", idleFull === 0, `${idleFull} 帧`);
	const idleBytes = idleFrames.reduce((n, f) => n + f.bytes, 0);
	check("空转 5 秒总字节 < 4KB", idleBytes < 4096, `${idleBytes} B`);

	// 客户端自报 rev 且内容没变 → 不该再补一帧（这是首屏 4 帧的第二个来源）
	const beforeRepeat = count("snapshot");
	send({ type: "get_state", rev: snapshot.rev });
	await sleep(800);
	check("自报 rev 命中且内容未变 → 不重发", count("snapshot") === beforeRepeat, `+${count("snapshot") - beforeRepeat}`);

	// 对不上 rev（客户端落后 / 丢了状态）→ 必须补一帧全量
	send({ type: "get_state", rev: 1 });
	await sleep(800);
	check("rev 对不上 → 补一帧全量", count("snapshot") === beforeRepeat + 1, `+${count("snapshot") - beforeRepeat}`);

	// 大会话冷开：帧大小由窗口决定，帧数必须只有 1（issue 正文里是 4 帧 × 356KB）
	const beforeSwitch = frames.length;
	send({ type: "switch_session", path: seedFile });
	await waitFor(() => snapshot?.sessionFile === seedFile, "大会话快照", 30000);
	const switched = frames.slice(beforeSwitch);
	const seededFulls = switched.filter((f) => f.type === "snapshot" && f.sessionFile === seedFile);
	check("大会话冷开只发 1 帧全量", seededFulls.length === 1, `${seededFulls.length} 帧`);
	const seededBytes = seededFulls.reduce((n, f) => n + f.bytes, 0);
	check("该帧只带窗口内消息", snapshot.messages.length <= 300, `msgs=${snapshot.messages.length}`);

	// 同一个大会话再空转 5 秒：不该再来第二帧
	const beforeSeedIdle = frames.length;
	await sleep(3000);
	const seedIdle = frames.slice(beforeSeedIdle);
	check(
		"大会话空转不再重发全量",
		seedIdle.filter((f) => f.type === "snapshot").length === 0,
		`${seedIdle.filter((f) => f.type === "snapshot").length} 帧`,
	);
	console.log(
		`  · 大会话单帧 ${Math.round(seededBytes / 1024)}KB（${SEED_TOTAL} 条消息 / 窗口 ${snapshot.messages.length}）`,
	);

	ws.close();
} catch (err) {
	console.error(String(err?.stack ?? err));
	failures++;
} finally {
	server.kill();
	await sleep(300);
	try {
		server.kill("SIGKILL");
	} catch {}
	for (const dir of [dataDir, agentDir, workDir]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

console.log(failures === 0 ? "\n帧预算全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
