/* Scroll DOM-mutation stick E2E: pins the content-level MutationObserver
 * re-pin in MessageList.tsx. Growth that mutates DOM INSIDE .messages without
 * any React state change (extension/liveOutputs card churn, post-jump height
 * corrections) used to drift the bottom away silently: the container RO only
 * sees the container BOX (unchanged), and the messages/liveOutputs effects
 * never re-run. Growth here runs ~3.75s — far beyond the ~850ms
 * scrollToBottom re-assert window — so only the MutationObserver keeps the
 * viewport pinned.
 *
 * Mutation-proven: revert the MO effect in MessageList.tsx → drift >80px → RED.
 * Run: npm run build:web && node tests/scroll-dom-mutation-test.mjs */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const { chromium } = require2("playwright-core");
const { CHROME_PATH } = require2("./lib/chrome.mjs");
const { WebSocket } = require2("ws");

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-scrollmut-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
for (let i = 1; i <= 35; i++) writeFileSync(join(workdir, `seed-${String(i).padStart(2, "0")}.txt`), `seed ${i}\n`);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "test-model" }],
			},
		},
	}),
);
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const CLIENT_ID = "scroll-dom-mutation-test-client";
const TALL_TEXT = "很长的需求描述。".repeat(2000);

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const server = spawn(process.execPath, [join(root, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
	} catch {}
	await sleep(200);
}

function seedChat(want) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 30000);
		let step = 0;
		let known = 0;
		const sendNext = () => {
			if (step === 0) {
				const attachments = [];
				for (let i = 1; i <= 35; i++) attachments.push({ path: `seed-${String(i).padStart(2, "0")}.txt` });
				ws.send(JSON.stringify({ type: "prompt", text: "总结", attachments }));
			} else {
				ws.send(JSON.stringify({ type: "prompt", text: `${TALL_TEXT}\n\n第 ${step} 条` }));
			}
			step++;
		};
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID })));
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") return sendNext();
			let total = -1;
			if (msg.type === "snapshot") {
				known = msg.state.messages.length;
				total = known;
			} else if (msg.type === "snapshot_delta") {
				known += msg.appended?.length ?? 0;
				total = known;
			}
			if (total < 0) return;
			if (step === 1 && total >= 36) return sendNext();
			if (step === 2 && total >= 38) return sendNext();
			if (total >= want) {
				clearTimeout(timer);
				ws.close();
				resolve(total);
			}
		});
		ws.on("error", reject);
	});
}

async function main() {
	await waitServer();
	const total = await seedChat(38);
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.addInitScript((id) => localStorage.setItem("pi-web-client-id", id), CLIENT_ID);
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForSelector(".msg", { timeout: 30000 });
	await sleep(500);

	// Jump to bottom via the app's own back-to-bottom control (sets stick=true).
	await page.evaluate(() => {
		const el = document.querySelector(".messages");
		el.scrollTop = 0;
	});
	await sleep(300);
	const chip = await page.$(".scroll-bottom");
	if (chip) await chip.click();
	await sleep(400);

	// Pure-DOM growth INSIDE the scroll content, NO React state change, running
	// ~3.75s (past every scrollToBottom re-assert timer).
	await page.evaluate(() => {
		const el = document.querySelector(".messages");
		const anchor = el.querySelector(".msg .msg-body") || el.querySelector(".msg");
		window.__mutLeft = 25;
		window.__mutTimer = setInterval(() => {
			if (window.__mutLeft-- <= 0) return clearInterval(window.__mutTimer);
			const d = document.createElement("div");
			d.style.height = "120px";
			d.textContent = "live tool output tick";
			anchor.appendChild(d);
		}, 150);
	});
	await sleep(4500);

	const { dist, sh, chipAfter } = await page.evaluate(() => {
		const el = document.querySelector(".messages");
		clearInterval(window.__mutTimer);
		return {
			dist: el.scrollHeight - el.scrollTop - el.clientHeight,
			sh: el.scrollHeight,
			chipAfter: !!document.querySelector(".scroll-bottom"),
		};
	});
	console.log(`distFromBottom after 3.75s of pure-DOM growth: ${dist.toFixed(0)}px (sh=${sh}, chip=${chipAfter})`);
	let passed = 0;
	const check = (name, cond) => {
		if (cond) {
			passed++;
			console.log(`  ✓ ${name}`);
		} else {
			console.log(`  ✗ FAIL: ${name}`);
			process.exitCode = 1;
		}
	};
	check("viewport stays pinned during pure-DOM content growth (dist < 80px)", dist < 80);
	check("back-to-bottom chip stays hidden while stuck", !chipAfter);

	await browser.close();
	console.log(passed === 2 ? "PASS" : "FAIL");
	process.exit(process.exitCode ? 1 : 0);
}

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("server did not start");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
