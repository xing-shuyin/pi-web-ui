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
const PORT = 8956;
const CID = "approval-rules-client";

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

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-rules-test-"));

async function main() {
	await startServer(dataDir);
	await sleep(300);

	const c1 = await connect();
	await c1.next((m) => m.type === "snapshot", "initial snapshot", 25000);
	const s1 = await c1.next((m) => m.type === "settings_state", "initial settings_state", 25000);
	check("settings_state 携带 approvalRules 数组", Array.isArray(s1.settings.approvalRules));
	check("默认包含 11 条内置规则", s1.settings.approvalRules.length === 11);
	const rmRf = s1.settings.approvalRules.find((r) => r.id === "builtin.bash.rm-rf");
	check("内置 rm -rf 规则存在且 builtin=true", rmRf && rmRf.builtin === true);

	const customRule = {
		id: "custom.test-docker",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value: "docker\\s+rm",
		action: "deny",
		label: "禁止删除容器",
		labelEn: "Deny docker rm",
		reason: "容器删除受保护",
	};
	c1.send({ type: "save_approval_rule", rule: customRule });
	const s2 = await c1.next(
		(m) => m.type === "settings_state" && m.settings.approvalRules?.some((r) => r.id === "custom.test-docker"),
		"rule added and pushed",
	);
	check(
		"save_approval_rule 成功并推回 settings_state",
		s2.settings.approvalRules.some((r) => r.id === "custom.test-docker"),
	);

	const reversed = [...s2.settings.approvalRules].reverse();
	c1.send({ type: "save_approval_rules", rules: reversed });
	const s3 = await c1.next(
		(m) => m.type === "settings_state" && m.settings.approvalRules?.[0]?.id === reversed[0].id,
		"rules reordered and pushed",
	);
	check("save_approval_rules 批量重排生效", s3.settings.approvalRules[0].id === reversed[0].id);

	c1.send({ type: "delete_approval_rule", id: "custom.test-docker" });
	const s4 = await c1.next(
		(m) => m.type === "settings_state" && !m.settings.approvalRules?.some((r) => r.id === "custom.test-docker"),
		"rule deleted and pushed",
	);
	check("delete_approval_rule 删除成功", !s4.settings.approvalRules.some((r) => r.id === "custom.test-docker"));

	c1.send({
		type: "save_approval_rule",
		rule: { ...rmRf, action: "allow", label: "已放行删除" },
	});
	const s5 = await c1.next(
		(m) =>
			m.type === "settings_state" &&
			m.settings.approvalRules?.find((r) => r.id === "builtin.bash.rm-rf")?.action === "allow",
		"builtin rule modified",
	);
	check(
		"内置规则可被修改并推回",
		s5.settings.approvalRules.find((r) => r.id === "builtin.bash.rm-rf")?.action === "allow",
	);

	c1.send({ type: "reset_builtin_approval_rule", id: "builtin.bash.rm-rf" });
	const s6 = await c1.next(
		(m) =>
			m.type === "settings_state" &&
			m.settings.approvalRules?.find((r) => r.id === "builtin.bash.rm-rf")?.action === "ask",
		"builtin rule reset to default",
	);
	check(
		"reset_builtin_approval_rule 成功恢复默认",
		s6.settings.approvalRules.find((r) => r.id === "builtin.bash.rm-rf")?.action === "ask",
	);

	c1.ws.close();
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
