// Temp probe: vision bridge — attachment/save + attachment/read + prompt with
// a real image block (model must actually see the image).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname ?? ".");
const KEY = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).deepseek.key;
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
const IMG = resolve(HERE, "..", "..", "assets", "shot1.png");

const tmp = join(HERE, "..", "..", ".tmp-vision-probe");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		DEEPSEEK_API_KEY: KEY,
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
let lastAssistant = "";
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

let turnDone = false;
const onNotify = (method, params) => {
	if (method !== "session.event") return;
	const ev = params?.event;
	if (ev?.type === "assistant/message") {
		lastAssistant = (ev.data?.message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
	}
	if (ev?.type === "turn/end") {
		turnDone = true;
		console.log("turn/end:", ev.data?.reason?.kind);
	}
};

try {
	await req("initialize", { cwd: HERE, provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" });
	console.log("initialize OK");

	// 1) attachment/save（真实截图）
	const png = readFileSync(IMG);
	const b64 = png.toString("base64");
	const saved = await req("attachment/save", { mediaType: "image/png", data: b64, name: "shot1.png" });
	console.log("saved ref:", JSON.stringify(saved));
	if (!saved?.ref?.attachmentId) throw new Error("attachment/save 未返回 ref");
	const savedBytes = saved.ref.bytes;
	console.log("ref bytes match:", savedBytes === png.length, `(src=${png.length} saved=${savedBytes})`);

	// 2) attachment/read 往返
	const read = await req("attachment/read", { ref: saved.ref });
	const readBytes = Buffer.from(read.data, "base64").length;
	console.log("read bytes:", readBytes, "mediaType:", read.mediaType);
	if (readBytes === 0) throw new Error("attachment/read 空数据");

	// 3) prompt 带 image 块 → 模型看图回复
	const sessionId = "vision-probe-session";
	await req("session/prompt", {
		sessionId,
		contentBlocks: [
			{ type: "image", attachment: saved.ref },
			{ type: "text", text: "这张截图里显示的是什么应用？用一句话回答，并说出你看到的任何文字。" },
		],
	});
	for (let i = 0; i < 120 && !turnDone; i++) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.log("assistant reply:", JSON.stringify(lastAssistant.slice(0, 200)));

	const ok = !!saved?.ref?.attachmentId && readBytes > 0 && turnDone && lastAssistant.length > 5;
	console.log(ok ? "VISION BRIDGE OK" : "VISION BRIDGE FAILED");
	await req("shutdown", {});
	proc.stdin.end();
	process.exit(ok ? 0 : 1);
} catch (err) {
	console.error("PROBE FAILED:", err.message);
	proc.kill();
	process.exit(1);
}
