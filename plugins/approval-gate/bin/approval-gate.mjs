#!/usr/bin/env node
/**
 * approval-gate —— 定时任务拍板登记 CLI。
 *
 * 用法：
 *   approval-gate register --task <任务名> --title <标题> [--summary <摘要>] [--project <项目目录>]
 *                          [--conversation <会话id>] | [--auto-session "<拍板请求提示词>"] [--raw] [--model <模型>] [--timeout <秒>]
 *   approval-gate resolve  --id <拍板项id> [--status resolved|dismissed]
 *   approval-gate list     [--pending]
 *
 * 环境变量：
 *   APPROVAL_GATE_TOKEN / PI_WEB_TOKEN  面板口令（缺省自动从 ~/.pi/secrets/com.xingshuyin.pi-web-ui.env 解析）
 *   APPROVAL_GATE_URL                   面板地址（缺省 http://127.0.0.1:${PI_WEB_PORT:-8082}）
 *
 * 退出码：0 成功 / 64 参数错 / 65 面板不可达 / 66 会话建立失败
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_ENV = join(homedir(), ".pi/secrets/com.xingshuyin.pi-web-ui.env");

function die(code, msg) {
	console.error(`[approval-gate] ${msg}`);
	process.exit(code);
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq > 2) {
				// --key=value 形式：值可以是任意文本（含以 -- 开头的字符串）
				out[a.slice(2, eq)] = a.slice(eq + 1);
				continue;
			}
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) out[key] = true;
			else {
				out[key] = next;
				i++;
			}
		} else out._.push(a);
	}
	return out;
}

function resolveToken() {
	if (process.env.APPROVAL_GATE_TOKEN) return process.env.APPROVAL_GATE_TOKEN;
	if (process.env.PI_WEB_TOKEN) return process.env.PI_WEB_TOKEN;
	if (existsSync(SECRET_ENV)) {
		const line = readFileSync(SECRET_ENV, "utf8")
			.split("\n")
			.find((l) => /PI_WEB_TOKEN\s*=/.test(l));
		if (line)
			return line
				.split("=")
				.slice(1)
				.join("=")
				.trim()
				.replace(/^["']|["']$/g, "");
	}
	return "";
}

function baseUrl() {
	if (process.env.APPROVAL_GATE_URL) return process.env.APPROVAL_GATE_URL.replace(/\/+$/, "");
	const port = process.env.PI_WEB_PORT || "8082";
	return `http://127.0.0.1:${port}`;
}

async function api(method, path, body) {
	const token = resolveToken();
	const url = `${baseUrl()}/plugins-api/approval-gate${path}`;
	const headers = {
		...(body ? { "content-type": "application/json" } : {}),
		...(token ? { "x-pi-token": token, authorization: `Bearer ${token}` } : {}),
	};
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch (err) {
		die(65, `面板不可达（${baseUrl()}）：${err.message}`);
	}
	if (res.status === 401) die(65, "鉴权失败：token 无效（查 PI_WEB_TOKEN / secrets env）");
	const data = await res.json().catch(() => ({}));
	if (!res.ok) die(65, `HTTP ${res.status}: ${data.error ?? res.statusText}`);
	return data;
}

/** 建快照会话（泛化自 面板更新/scripts/notify-session.sh 的 A 档模式）并返回会话 id。 */
function autoSession(prompt, project, model, timeoutSec) {
	const piBin = [
		"pi",
		join(homedir(), ".pi/agent/bin/pi"),
		join(homedir(), ".local/share/pi-node/node-v22.23.2-darwin-arm64/bin/pi"),
	].find((p) => (p.includes("/") ? existsSync(p) : spawnSync("which", [p], { encoding: "utf8" }).status === 0));
	if (!piBin) die(66, "找不到 pi 可执行文件（PATH / ~/.pi/agent/bin）");
	const child = spawn(piBin, ["-p", "--model", model, prompt], {
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutSec * 1000,
	});
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", () => {});
	const code = child.on("close", (c) => c).exitCode ?? undefined;
	return new Promise((resolve) => {
		child.on("close", (code2) => {
			const sessionId = latestSessionId(project);
			resolve({ ok: code2 === 0 || Boolean(sessionId), sessionId, output: out, exitCode: code2 });
		});
	});
}

/** 扫 ~/.pi/agent/sessions/<编码cwd>/ 最新 jsonl 的 session id（编码：路径 / → -，首尾 --）。 */
function latestSessionId(project) {
	const enc = `--${project.replace(/^\/|\/$/g, "").replaceAll("/", "-")}--`;
	const dir = join(homedir(), ".pi/agent/sessions", enc);
	if (!existsSync(dir)) return "";
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.reverse();
	for (const f of files) {
		try {
			const first = readFileSync(join(dir, f), "utf8").split("\n")[0];
			const j = JSON.parse(first);
			if (j.type === "session" && j.id) return j.id;
		} catch {}
	}
	return "";
}

/** 快照会话固化模板（二期）：拍板请求 + STATE 待拍板区 + 拍板后自动清账指令。 */
function buildTemplatePrompt(req, itemId) {
	return [
		req,
		"",
		"—— 以上是待拍板请求原文。请按以下流程处理（轻量，快速完成）：",
		"1. 在当前项目 STATE.md 的「待拍板」区（没有就新建一节）写入：日期、本项拍板摘要、拍板方式=本会话回复拍板词（同意/等/忽略）。",
		"2. 向主人输出不超过 10 行的拍板请求：拍板摘要一行，末尾说明回复拍板词即拍板。",
		"3. 【固化清账指令】当主人回复拍板词后：",
		"   - 先按请求原文执行拍板动作（主人说忽略/等则不执行动作）；",
		`   - 然后执行：approval-gate resolve --id ${itemId}（不在 PATH 时用：node $HOME/projects/pi-approval-gate/bin/approval-gate.mjs resolve --id ${itemId}）；`,
		"   - 主人回「忽略/不要」时加 --status dismissed；",
		"   - 完成后向主人确认一句「已拍板并清账」。",
		"不要在本轮就执行清账（本轮只是登记快照，等主人拍板后才清）。",
	].join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	if (cmd === "list") {
		const data = await api("GET", "/list");
		let items = data.items ?? [];
		if (args.pending) items = items.filter((x) => x.status === "pending");
		for (const it of items)
			console.log(
				`${it.status === "pending" ? "●" : "○"} ${it.id}  [${it.status}] ${it.task} · ${it.title}  (${it.conversationId || "无会话"})`,
			);
		console.error(`共 ${items.length} 项`);
		return;
	}
	if (cmd === "resolve") {
		if (!args.id) die(64, "resolve 需要 --id <拍板项id>");
		const data = await api("POST", "/resolve", {
			id: args.id,
			status: args.status === "dismissed" ? "dismissed" : "resolved",
		});
		console.log(`已标记 ${data.item?.id} → ${data.item?.status}`);
		return;
	}
	if (cmd === "register") {
		if (!args.task || !args.title) die(64, "register 需要 --task <任务名> --title <标题>");
		const project = args.project ? String(args.project).replace(/^~/, homedir()) : process.cwd();
		let conversationId = args.conversation ? String(args.conversation) : "";
		if (args["auto-session"]) {
			const model = args.model || "glm-5.3-flash";
			const timeout = Number(args.timeout || 300);
			// 二期流程：先登记拿 id（模板需引用）→ 建快照会话（模板固化清账指令）→ update 回填会话 id
			const pre = await api("POST", "/register", {
				task: String(args.task),
				title: String(args.title),
				summary: args.summary ? String(args.summary) : "",
				project,
			});
			if (pre.duplicate) {
				console.log(`当日已登记（幂等跳过）：${pre.item.id} [${pre.item.status}] ${pre.item.title}`);
				return;
			}
			const itemId = pre.item.id;
			const rawReq = String(args["auto-session"]);
			const prompt = args.raw ? rawReq : buildTemplatePrompt(rawReq, itemId);
			console.error(
				`[approval-gate] 建快照会话（model=${model}，timeout=${timeout}s，cwd=${project}${args.raw ? "，raw" : ""}）…`,
			);
			const r = await autoSession(prompt, project, model, timeout);
			if (!r.sessionId) {
				// 会话失败：把占位项标记 dismissed，不留孤儿 pending
				await api("POST", "/resolve", { id: itemId, status: "dismissed" }).catch(() => {});
				die(66, `快照会话建立失败（exit=${r.exitCode}）；已把占位项标记 dismissed`);
			}
			conversationId = r.sessionId;
			await api("POST", "/update", { id: itemId, conversationId });
			console.error(`[approval-gate] 快照会话已建并关联：${conversationId}`);
			console.log(
				`已登记：${itemId}  ${args.title}${conversationId ? `（会话 ${conversationId}，拍板后自动清账）` : ""}`,
			);
			return;
		}
		const data = await api("POST", "/register", {
			task: String(args.task),
			title: String(args.title),
			summary: args.summary ? String(args.summary) : "",
			project,
			conversationId,
		});
		if (data.duplicate) {
			console.log(`当日已登记（幂等跳过）：${data.item.id} [${data.item.status}] ${data.item.title}`);
			return;
		}
		console.log(
			`已登记：${data.item.id}  ${data.item.title}${data.item.conversationId ? `（会话 ${data.item.conversationId}）` : ""}`,
		);
		return;
	}
	die(64, "用法：approval-gate <register|resolve|list>（--help 看 bin/approval-gate.mjs 头注释）");
}

main().catch((e) => die(1, e?.stack || e?.message || String(e)));
