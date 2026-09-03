// Temp probe: DSH tools bridge (#15) — verify plugin tool registration via
// tools/sync, schema conversion (pi JSON Schema → DSH param spec), tools/list,
// and the FULL trampoline round-trip via tools/invoke (invoke → tools.call.request
// notification → simulated server responds tools/call-result → value restored).
// Zero key: boot + tools/* RPC need no model.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname ?? ".");
const JSONRPC_ENTRY = resolve(
	HERE,
	"..",
	"..",
	"node_modules",
	"@deepseek-ai",
	"dsh-sdk-jsonrpc-server",
	"lib",
	"index.js",
);

const tmp = join(HERE, "..", "..", ".tmp-tools-probe");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// PI_WEB_DSH_DEBUG=1 → 允许 tools/invoke（调试/探针专用）。
const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		PI_WEB_DSH_DEBUG: "1",
		PI_WEB_DSH_JSONRPC_ENTRY: JSONRPC_ENTRY,
		DSH_SESSION_ROOT: join(tmp, "sessions"),
		DSH_CWD: HERE,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write("[rt] " + d));

let buf = "";
const pending = new Map();
let nextId = 1;
const callRequests = [];
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id !== undefined && pending.has(m.id)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) {
				p.reject(new Error(JSON.stringify(m.error)));
			} else {
				p.resolve(m.result);
			}
		} else if (m.method) {
			onNotify(m.method, m.params);
		}
	}
});
proc.on("exit", (code) => {
	for (const p of pending.values()) p.reject(new Error(`launcher exited early (code=${code})`));
	pending.clear();
});
const req = (method, params) =>
	new Promise((resolve2, reject) => {
		const id = nextId++;
		pending.set(id, { resolve: resolve2, reject });
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});

// 模拟服务端：收到 tools.call.request → 立即跑插件（这里直接回显）→ tools/call-result。
const onNotify = (method, params) => {
	if (method !== "tools.call.request") return;
	const { id, name, args } = params;
	callRequests.push({ id, name, args });
	console.log("tools.call.request:", id, name, JSON.stringify(args));
	if (name === "echo_tool") {
		void req("tools/call-result", { id, result: "echo:" + (args?.msg ?? ""), isError: false });
	} else {
		void req("tools/call-result", { id, result: "UNKNOWN", isError: false });
	}
};

const fail = (msg) => {
	console.error("PROBE FAILED:", msg);
	try {
		proc.kill();
	} catch {
		/* already dead */
	}
	process.exit(1);
};

try {
	await req("initialize", { cwd: HERE, provider: "deepseek-official", model: "deepseek-v4-flash" });
	console.log("initialize OK");

	// ---- 1. tools/sync：pi JSON Schema（required 数组形式）→ DSH 属性映射 ----
	const tools = [
		{
			name: "echo_tool",
			description: "Echo a message back.",
			parameters: {
				type: "object",
				properties: { msg: { type: "string", description: "message to echo" } },
				required: ["msg"],
			},
		},
		{
			name: "noarg_tool",
			description: "Tool with no arguments.",
			parameters: { type: "object", properties: {} },
		},
	];
	const syncRes = await req("tools/sync", { tools });
	console.log("tools/sync ->", JSON.stringify(syncRes));
	if (!syncRes?.count === 2) fail("expected 2 tools registered");
	if (!(syncRes?.registered ?? []).includes("echo_tool") || !(syncRes?.registered ?? []).includes("noarg_tool")) {
		fail("registered list mismatch: " + JSON.stringify(syncRes?.registered));
	}

	// ---- 2. tools/list：确认注册 + schema 转换 ----
	const listRes = await req("tools/list", {});
	const names = (listRes?.tools ?? []).map((t) => t.name);
	console.log("tools/list ->", JSON.stringify(names));
	if (!names.includes("echo_tool") || !names.includes("noarg_tool")) fail("list missing bridged tools");
	const echo = (listRes.tools ?? []).find((t) => t.name === "echo_tool");
	console.log("echo_tool params (compiled):", JSON.stringify(echo?.parameters));
	const params = echo?.parameters ?? {};
	// DSH 编译后：object + properties.msg{type:string,description} + required:["msg"]
	if (params.type !== "object" || params.properties?.msg?.type !== "string") {
		fail("echo_tool parameters not converted: " + JSON.stringify(params));
	}
	if (!Array.isArray(params.required) || !params.required.includes("msg")) {
		fail("required not preserved as array: " + JSON.stringify(params.required));
	}

	// ---- 3. tools/invoke 完整往返（trampoline → notify → call-result → 恢复） ----
	const inv = await req("tools/invoke", { name: "echo_tool", args: { msg: "hello" } });
	console.log("tools/invoke ->", JSON.stringify(inv));
	if (inv?.ok !== true || inv?.value !== "echo:hello") fail("round-trip value mismatch: " + JSON.stringify(inv));

	// ---- 4. 工具不存在 → 错误 ----
	const missing = await req("tools/invoke", { name: "nope", args: {} });
	console.log("tools/invoke(nope) ->", JSON.stringify(missing));
	if (missing?.ok !== false) fail("unknown tool should fail");

	await new Promise((r) => setTimeout(r, 300));
	await req("shutdown", {});

	const ok =
		syncRes?.count === 2 &&
		names.includes("echo_tool") &&
		params.type === "object" &&
		inv?.ok === true &&
		inv?.value === "echo:hello" &&
		callRequests.length === 1;
	console.log("call requests seen:", callRequests.length);
	console.log(ok ? "TOOLS BRIDGE OK" : "TOOLS BRIDGE FAILED");
	proc.stdin.end();
	process.exit(ok ? 0 : 1);
} catch (err) {
	fail(err.message);
}
