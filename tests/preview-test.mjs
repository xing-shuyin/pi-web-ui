import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = Number(process.argv[2] || 8898);
const PROJ = REPO_ROOT;
const dataDir = mkdtempSync(join(tmpdir(), "pi-prev-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-prev-agent-"));
const WS = mkdtempSync(join(tmpdir(), "pi-prev-"));
writeFileSync(join(WS, "notes.weird"), "hello from an unknown extension\nline2\n");
writeFileSync(join(WS, "data.jsonl"), '{"k":1}\n');
writeFileSync(join(WS, "app.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
writeFileSync(join(WS, "mixed.txt"), Buffer.from([0x61, 0x62, 0x00, 0x63]));
writeFileSync(
	join(WS, "pixel.png"),
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
);
writeFileSync(join(WS, "empty.bin"), "");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(PROJ, "preview-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: WS,
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const results = new Map();
const expected = ["notes.weird", "data.jsonl", "app.zip", "mixed.txt", "pixel.png", "empty.bin"];
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "file_content") results.set(m.path, m);
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
await sleep(1000);
for (const p of expected) ws.send(JSON.stringify({ type: "read_file", path: p }));

const t0 = Date.now();
while (Date.now() - t0 < 8000 && results.size < expected.length) await sleep(150);

const get = (p) => results.get(p);
check(
	"unknown extension text previews as text",
	get("notes.weird")?.kind === "text" &&
		!get("notes.weird")?.binary &&
		get("notes.weird")?.text.includes("unknown extension"),
	get("notes.weird") ? `kind=${get("notes.weird").kind}` : "no result",
);
check("jsonl still text", get("data.jsonl")?.kind === "text" && !get("data.jsonl")?.binary);
check(
	"binary zip gets hex dump",
	get("app.zip")?.binary === true && /50 4b 03 04/.test(get("app.zip")?.text ?? ""),
	get("app.zip") ? `text=${(get("app.zip").text ?? "").slice(0, 30)}` : "no result",
);
check(
	"NUL inside text-extension file → hex",
	get("mixed.txt")?.binary === true && /00/.test(get("mixed.txt")?.text ?? ""),
	get("mixed.txt") ? `text=${(get("mixed.txt").text ?? "").slice(0, 30)}` : "no result",
);
check(
	"image stays metadata-only",
	get("pixel.png")?.binary === true && get("pixel.png")?.kind === "image" && get("pixel.png")?.text === "",
);
check("empty file previews as empty text", get("empty.bin")?.kind === "text" && get("empty.bin")?.text === "");

ws.close();
server.kill("SIGKILL");
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(WS, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
