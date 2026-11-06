import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8955);
const CID = "approval-policy-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer(dataDir) {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: REPO_ROOT,
			PI_WEB_PLUGIN_CATALOG_URL: "off",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		if (await portUp(PORT)) return;
	}
	throw new Error("server did not start");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			inbox,
			next(pred, what, ms = 15000) {
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

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-approval-"));

async function main() {
	await startServer(dataDir);
	await sleep(300);

	const c1 = await connect();
	await c1.next((m) => m.type === "snapshot", "initial snapshot", 25000);
	const s1 = await c1.next((m) => m.type === "settings_state", "initial settings_state", 25000);
	check("settings_state 带 toolApprovalEnabled（默认开）", s1.settings.toolApprovalEnabled === true);
	check(
		"settings_state 带 approvalPolicy（默认空策略）",
		s1.settings.approvalPolicy &&
			s1.settings.approvalPolicy.allowAll === false &&
			Array.isArray(s1.settings.approvalPolicy.categories) &&
			s1.settings.approvalPolicy.categories.length === 0,
		JSON.stringify(s1.settings.approvalPolicy),
	);

	c1.send({ type: "set_approval_policy", allowAll: true });
	const s2 = await c1.next(
		(m) => m.type === "settings_state" && m.settings.approvalPolicy?.allowAll === true,
		"approvalPolicy.allowAll = true",
	);
	check("set_approval_policy allowAll=true 生效并推回面板", s2.settings.approvalPolicy.allowAll === true);

	c1.send({ type: "set_approval_policy", allowAll: false });
	const s3 = await c1.next(
		(m) => m.type === "settings_state" && m.settings.approvalPolicy?.allowAll === false,
		"approvalPolicy.allowAll = false",
	);
	check("set_approval_policy allowAll=false 撤销", s3.settings.approvalPolicy.allowAll === false);
	check("撤销后同类名单为空（没有凭空塞档位）", s3.settings.approvalPolicy.categories.length === 0);

	c1.send({ type: "tool_approval_response", id: "appr-999", decision: "approve", scope: "category" });
	c1.send({ type: "tool_approval_response", id: "appr-998", decision: "deny", reason: "nope" });
	c1.send({ type: "set_approval_policy" });
	c1.send({ type: "get_settings" });
	const s4 = await c1.next((m) => m.type === "settings_state", "settings_state after junk messages", 10000);
	check("未知审批 id / 空策略消息不崩，服务仍回 settings_state", !!s4.settings);

	c1.send({ type: "set_settings", toolApprovalEnabled: false });
	const s5 = await c1.next(
		(m) => m.type === "settings_state" && m.settings.toolApprovalEnabled === false,
		"toolApprovalEnabled = false",
	);
	check("全局审批开关可关（settings_state 回显 false）", s5.settings.toolApprovalEnabled === false);
	c1.ws.close();
	await sleep(300);

	const c2 = await connect();
	const s6 = await c2.next((m) => m.type === "settings_state", "reconnect settings_state（同 clientId）", 25000);
	check("总开关随 client-state 持久化（重连仍是关）", s6.settings.toolApprovalEnabled === false);
	c2.send({ type: "set_settings", toolApprovalEnabled: true });
	await c2.next(
		(m) => m.type === "settings_state" && m.settings.toolApprovalEnabled === true,
		"toolApprovalEnabled = true",
	);
	c2.ws.close();
}

try {
	await main();
} catch (err) {
	failures++;
	console.error("✗ FAIL", err?.message ?? err);
} finally {
	try {
		server?.kill();
	} catch {}
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
