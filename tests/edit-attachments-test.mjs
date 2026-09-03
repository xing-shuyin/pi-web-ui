/**
 * edit_message attachments — protocol smoke test (issue #18, zero token).
 *
 * The edit/re-ask path now accepts optional `attachments` (the browser re-sends
 * the question's original image cards + newly pasted/dropped ones because the
 * fork drops persisted attachment asides). This test verifies:
 *   1. edit_message WITHOUT attachments (old clients) still parses and answers
 *      deterministically (unknown id → error notice).
 *   2. edit_message WITH attachments (incl. imageData/fileData) parses without
 *      a server-side TypeError — same deterministic unknown-id notice.
 * Full image round-trips need a real model and are covered manually.
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const PORT = 8969;
const CID = "edit-attach-client";

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
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) return;
		} catch {
			/* retry */
		}
	}
	throw new Error("no server");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			inbox,
			next(pred, what, ms = 10000) {
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

// A tiny valid 1x1 PNG (base64, no data: prefix) as fake imageData.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-edit-attach-"));

async function main() {
	await startServer(dataDir);
	await sleep(400);

	const c = await connect();
	await c.next((m) => m.type === "snapshot" || m.type === "ready", "ready", 20000);

	// -- old-protocol shape: no attachments field ----------------------------
	c.send({
		type: "edit_message",
		messageId: "u-nonexistent",
		text: "旧客户端的编辑重问（无附件字段）",
	});
	const n1 = await c.next(
		(m) => m.type === "notice" && typeof m.text === "string" && /找不到要编辑的消息|失败/.test(m.text),
		"old-shape edit_message → deterministic notice",
		15000,
	);
	check("edit_message without attachments parses & answers", n1.level === "error" || n1.level === "warning", n1.text);

	// -- new shape: attachments incl. raw images -----------------------------
	c.send({
		type: "edit_message",
		messageId: "u-nonexistent",
		text: "带原图+新贴图的编辑重问",
		attachments: [
			{ path: "", imageData: TINY_PNG, mimeType: "image/png", name: "原图片.png" },
			{
				path: "",
				fileData: Buffer.from("hello").toString("base64"),
				mimeType: "text/plain",
				name: "note.txt",
				size: 5,
			},
		],
	});
	const n2 = await c.next(
		(m) => m.type === "notice" && typeof m.text === "string" && /找不到要编辑的消息|失败/.test(m.text),
		"attachments edit_message → deterministic notice",
		15000,
	);
	check("edit_message with attachments parses (no TypeError)", n2.level === "error" || n2.level === "warning", n2.text);

	// Empty-text edit with attachments only is still rejected (text required).
	c.send({
		type: "edit_message",
		messageId: "u-nonexistent",
		text: "  ",
		attachments: [{ path: "", imageData: TINY_PNG, mimeType: "image/png", name: "a.png" }],
	});
	const n3 = await c.next(
		(m) => m.type === "notice" && /编辑内容为空/.test(m.text ?? ""),
		"empty text + attachments rejected",
		15000,
	);
	check("empty text with attachments still rejected", !!n3);

	// -- new shape: restored upload (uploadPath) + workspace-path attachment --
	c.send({
		type: "edit_message",
		messageId: "u-nonexistent",
		text: "带恢复上传文件与路径附件的编辑重问",
		attachments: [
			{
				path: "",
				uploadPath: "C:/tmp/.pi-web/uploads/edit-attach-client/1-data.txt",
				name: "data.txt",
				size: 9,
			},
			{ path: "server/protocol.ts", mode: "reference" },
		],
	});
	const n4 = await c.next(
		(m) => m.type === "notice" && typeof m.text === "string" && /找不到要编辑的消息|失败/.test(m.text),
		"uploadPath edit_message → deterministic notice",
		15000,
	);
	check("edit_message with uploadPath parses (no TypeError)", n4.level === "error" || n4.level === "warning", n4.text);

	c.ws.close();
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main()
	.catch((e) => {
		console.error("ERR", e);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			server?.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	});
