/**
 * 左栏删除功能协议冒烟（零 token）：
 *   - delete_session：删除 <agentDir>/sessions/ 下的会话文件（磁盘验证 + sessions 列表刷新）
 *   - delete_session 越界路径（会话目录之外）：报错且不动文件
 *   - delete_session 删除“当前对话”：自动切换到次新历史会话（无历史时新建空白对话）后删除
 *   - delete_session 删除“唯一的会话”（当前对话持有）：自动新建空白对话后删除，服务不崩
 *   - delete_session 删除“后台对话占用的会话”（未过期 pi-subagents wake 订阅保留）：拒绝且文件保留
 *   - remove_project：把工作区从最近项目列表移出（projects 消息不再包含）
 * 自起编译后的 server（隔离端口 8967/8968 + 临时 data-dir + 临时 agent-dir），自行清理。
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8967;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// 两个工作区：workDir 是 PI_WEB_CWD；otherDir 只作为最近项目条目存在
const baseTmp = mkdtempSync(join(tmpdir(), "pi-web-lp-del-"));
const workDir = join(baseTmp, "proj");
const otherDir = join(baseTmp, "other");
mkdirSync(workDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(workDir, "a.txt"), "keep me");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-lp-del-data-"));
const agentDir = join(baseTmp, "agent");

// 种两个会话文件（workDir 一条 + otherDir 一条），格式与 pi CLI/TUI 相同
function seedSession(dirName, id, cwd, text, tsMs = 1722700801000, dirRoot = agentDir) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = join(dirRoot, "sessions", dirName ?? safePath);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-08-04T00:00:00.000Z",
				cwd,
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text }],
					timestamp: tsMs,
				},
			}),
		].join("\n") + "\n",
	);
	return file;
}
const sess1 = seedSession(null, "del-target", workDir, "要删除的对话");
const sess2 = seedSession(null, "del-keep", workDir, "要保留的对话");
const sessOther = seedSession(null, "del-other", otherDir, "另一个项目的对话");

const servers = [];

async function startServer(
	env = {
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: workDir,
	},
) {
	const proc = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdio: "ignore",
	});
	servers.push(proc);
	const port = Number(env.PI_WEB_PORT);
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (await portUp(port)) return;
		} catch {
			// not up yet
		}
	}
	throw new Error(`server did not start on ${port}`);
}

function connect(url = URL) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			async next(pred, what, ms = 8000) {
				const existing = inbox.findIndex(pred);
				if (existing >= 0) return inbox.splice(existing, 1)[0];
				return new Promise((res, rej) => {
					const t = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms);
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
			api.send({ type: "hello", clientId: "lp-del-test" });
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

	// 1) list_sessions 发现种下的两条（当前项目 workDir）
	c.send({ type: "list_sessions" });
	const s1 = await c.next((m) => m.type === "sessions", "sessions #1");
	const paths1 = (s1.sessions ?? []).map((x) => x.path);
	check("list_sessions 命中两条种子会话", paths1.includes(sess1) && paths1.includes(sess2), paths1.join(","));

	// 2) delete_session 删除一条 → 磁盘消失 + 列表刷新只剩一条
	// （attach 后有防抖的后台重复推送，必须等“确实不含被删项”的那一份）
	c.send({ type: "delete_session", path: sess1 });
	const s2 = await c.next(
		(m) => m.type === "sessions" && !(m.sessions ?? []).some((x) => x.path === sess1),
		"sessions #2（不含被删项）",
	);
	const paths2 = (s2.sessions ?? []).map((x) => x.path);
	check("删除后文件从磁盘消失", !existsSync(sess1), sess1);
	check("删除后列表不再包含该会话", !paths2.includes(sess1), paths2.join(","));
	check("另一条会话仍在", paths2.includes(sess2));

	// 3) 越界路径拒绝：会话目录之外的文件不能删
	c.send({ type: "delete_session", path: join(workDir, "a.txt") });
	const n1 = await c.next((m) => m.type === "notice" && m.level === "error", "error notice");
	check("越界删除返回错误提示", typeof n1.text === "string" && n1.text.length > 0, n1.text);
	check("越界文件未被删除", existsSync(join(workDir, "a.txt")));

	// 4) remove_project：最近项目列表移除 otherDir
	c.send({ type: "list_projects" });
	const p1 = await c.next((m) => m.type === "projects", "projects #1");
	const projPaths1 = (p1.projects ?? []).map((x) => x.path);
	check("初始最近项目含 otherDir", projPaths1.includes(otherDir), projPaths1.join(","));

	c.send({ type: "remove_project", path: otherDir });
	const p2 = await c.next(
		(m) => m.type === "projects" && !(m.projects ?? []).some((x) => x.path === otherDir),
		"projects #2（不含 otherDir）",
	);
	const projPaths2 = (p2.projects ?? []).map((x) => x.path);
	check("移除后最近项目不含 otherDir", !projPaths2.includes(otherDir), projPaths2.join(","));
	check("移除只动 UI 状态，目录仍在磁盘", existsSync(otherDir));

	// 5) 移除是持久的：重连后再查一次
	const c2 = await connect();
	c2.send({ type: "list_projects" });
	const p3 = await c2.next((m) => m.type === "projects", "projects #3");
	check("重连后 otherDir 仍不在最近项目里", !(p3.projects ?? []).some((x) => x.path === otherDir));

	c.ws.close();
	c2.ws.close();
}

/**
 * 删除“当前对话”的自动切走行为（独立第二套环境，避免干扰上面的既有用例）：
 *   A) 当前对话持有目标文件 + 存在更早历史 → 自动切到次新会话，再删文件；
 *   B) 当前对话持有唯一的会话文件 → 自动新建空白对话，再删文件，服务不崩；
 *   C) 后台对话（未过期 pi-subagents wake 订阅保留）持有目标文件 → 拒绝删除。
 */
async function runCurrentSessionCases() {
	const base2 = mkdtempSync(join(tmpdir(), "pi-web-lp-del-cur-"));
	const workDir2 = join(base2, "proj");
	const dataDir2 = mkdtempSync(join(tmpdir(), "pi-web-lp-del-cur-data-"));
	const agentDir2 = join(base2, "agent");
	// PI_SUBAGENTS_TEMP_ROOT：让 wake 订阅扫描落在本测试可控的目录里
	const subRoot = join(base2, "pi-subagents-root");
	mkdirSync(workDir2, { recursive: true });

	// 先种旧会话再种新会话：mtime 与消息时间戳一致地让“最新”= cur-target（continueRecent 取最新）
	const sessOld = seedSession(null, "cur-fallback", workDir2, "旧的保留对话", 1722700801000, agentDir2);
	await sleep(10);
	const sessActive = seedSession(null, "cur-target", workDir2, "要删除的当前对话", 1722700802000, agentDir2);

	await startServer({
		PI_WEB_PORT: String(PORT + 1),
		PI_WEB_DATA_DIR: dataDir2,
		PI_CODING_AGENT_DIR: agentDir2,
		PI_WEB_CWD: workDir2,
		PI_SUBAGENTS_TEMP_ROOT: subRoot,
	});
	const URL2 = `ws://localhost:${PORT + 1}/ws`;
	const c = await connect(URL2);
	const stateMsg = (m) =>
		(m.type === "snapshot" || m.type === "snapshot_delta") && m.state && typeof m.state === "object";

	// A) 启动即恢复最近会话：活跃对话持有 cur-target
	const init = await c.next((m) => stateMsg(m) && m.state.sessionFile, "初始 snapshot（含 sessionFile）");
	check("启动恢复最近会话（当前对话持有 cur-target）", init.state.sessionFile === sessActive, init.state.sessionFile);
	const convId1 = init.state.conversationId;

	c.send({ type: "delete_session", path: sessActive });
	const switched = await c.next((m) => stateMsg(m) && m.state.sessionFile === sessOld, "自动切换到次新会话");
	check("删除当前对话后自动切换到次新会话", switched.state.sessionFile === sessOld);
	check(
		"切换产生了新的活跃对话",
		switched.state.conversationId !== convId1,
		`${convId1} → ${switched.state.conversationId}`,
	);
	const convId2 = switched.state.conversationId;
	await c.next((m) => m.type === "conversations" && m.activeId === convId2, "conversations（activeId=新对话）");
	await c.next(
		(m) => m.type === "sessions" && !(m.sessions ?? []).some((x) => x.path === sessActive),
		"sessions（不含被删项）",
	);
	check("被删的当前会话文件已从磁盘消失", !existsSync(sessActive), sessActive);

	// B) 当前对话持有唯一的会话文件 → 自动新建空白对话
	// 收件箱里滞留着删除前时代的旧状态消息（60ms 防抖快照），必须先清空，
	// 否则下面的“conversationId 变化”断言会匹配到旧消息。
	for (;;) {
		try {
			await c.next(() => true, "drain", 1);
		} catch {
			break;
		}
	}
	c.send({ type: "delete_session", path: sessOld });
	const blank = await c.next(
		(m) => stateMsg(m) && m.state.conversationId !== convId2 && m.state.sessionFile !== sessOld,
		"自动新建空白对话",
	);
	check("唯一会话被删后自动新建空白对话", blank.state.conversationId !== convId2, blank.state.conversationId);
	check("旧会话文件从磁盘消失", !existsSync(sessOld), sessOld);
	// 删除管线的收尾（rm 后的 sessions 刷新）也到达 —— 证明整条链路跑完、服务未崩
	await c.next(
		(m) => m.type === "sessions" && !(m.sessions ?? []).some((x) => x.path === sessOld),
		"sessions（B 删后刷新）",
	);

	// C) 后台对话持有目标文件 → 拒绝删除（wake 订阅让切走时保留运行时）
	const sessBg = seedSession(null, "cur-bg", workDir2, "后台占用的对话", 1722700803000, agentDir2);
	const sessAfter = seedSession(null, "cur-after", workDir2, "切换目标对话", 1722700804000, agentDir2);
	const subDir = join(subRoot, "wait-subscriptions");
	mkdirSync(subDir, { recursive: true });
	const bgToken = "3f2b8c64-1a2b-4c3d-9e4f-5a6b7c8d9e0f";
	writeFileSync(
		join(subDir, `${bgToken}.json`),
		JSON.stringify({
			version: 1,
			token: bgToken,
			sessionId: sessBg, // 会话 .jsonl 绝对路径（与 conv.session.sessionFile 一致）
			targetKind: "async",
			runId: "run-del-test",
			requestedId: "req-del-test",
			createdAt: Date.now(),
			expiresAt: Date.now() + 10 * 60_000,
		}),
	);

	c.send({ type: "switch_session", path: sessBg });
	const onBg = await c.next((m) => stateMsg(m) && m.state.sessionFile === sessBg, "切到后台目标会话");
	const bgConvId = onBg.state.conversationId;
	c.send({ type: "switch_session", path: sessAfter });
	await c.next((m) => stateMsg(m) && m.state.sessionFile === sessAfter, "切走（后台保留）");
	const convsC = await c.next(
		(m) => m.type === "conversations" && (m.conversations ?? []).some((x) => x.id === bgConvId),
		"conversations（后台对话在运行列表）",
	);
	check(
		"切走后原对话保留为后台运行",
		(convsC.conversations ?? []).some((x) => x.id === bgConvId),
		bgConvId,
	);

	c.send({ type: "delete_session", path: sessBg });
	const nC = await c.next(
		(m) => m.type === "notice" && m.level === "warning" && m.text === "该对话正在后台运行，请先停止或关闭该对话再删除",
		"后台占用拒绝删除提示",
	);
	check("后台对话占用的会话拒绝删除", typeof nC.text === "string" && nC.text.includes("后台运行"), nC.text);
	check("后台会话文件仍在磁盘", existsSync(sessBg), sessBg);

	c.ws.close();
}

try {
	await run();
	await runCurrentSessionCases();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	for (const s of servers) {
		if (s?.pid) process.kill(s.pid, "SIGTERM");
	}
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
