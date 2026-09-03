/* Collapse/lazy-render E2E: seeds a >30-message chat via WS (same clientId the
 * browser will use), then verifies old messages render as collapsed summary
 * rows and expand on click.
 * Run: npm run build && node collapse-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-collapse-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
// Real-looking auth so the one-time setup modal doesn't block the UI.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
// Tiny attachment files — each becomes one custom "file" message (aside).
for (let i = 1; i <= 35; i++) {
	writeFileSync(join(workdir, `seed-${String(i).padStart(2, "0")}.txt`), `seed content ${i}\n`);
}
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
const CLIENT_ID = "collapse-test-client";

const server = spawn(
	process.execPath,
	[join(fileURLToPath(new URL("..", import.meta.url)), "dist", "server", "index.js")],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

/** Seed a long chat instantly: one prompt with 35 attachments produces 35
 *  custom "file" messages + 1 user message = 36 messages (no need to wait for
 *  the model — the asides are appended immediately). */
async function seedChat() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 20000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID }));
		});
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") {
				const attachments = [];
				for (let i = 1; i <= 35; i++) {
					attachments.push({ path: `seed-${String(i).padStart(2, "0")}.txt` });
				}
				ws.send(
					JSON.stringify({
						type: "prompt",
						text: "请总结这些文件",
						attachments,
					}),
				);
			}
			if (msg.type === "snapshot") {
				const total = msg.state.messages.length;
				if (total >= 36) {
					clearTimeout(timer);
					ws.close();
					resolve(total);
				}
			}
		});
		ws.on("error", reject);
	});
}

async function main() {
	await waitServer();
	console.log("seeding 1 prompt + 35 attachments → 36 messages…");
	const total = await seedChat();
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	// Same clientId as the seeder → same session dir.
	await page.addInitScript((id) => localStorage.setItem("pi-web-client-id", id), CLIENT_ID);

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForSelector(".msg", { timeout: 30000 });
	console.log("app booted with 32 messages");

	// -- collapsed rows -------------------------------------------------------
	const collapsed = page.locator(".msg-collapsed");
	const full = page.locator(".msg");
	check("old messages render collapsed", (await collapsed.count()) > 0);
	check("recent messages stay fully rendered", (await full.count()) >= 15);
	const firstCollapsedPreview = (await collapsed.first().textContent()) ?? "";
	check("collapsed row shows a text preview", firstCollapsedPreview.includes("请总结这些文件"));
	const attachmentRow = page.locator(".msg-collapsed", {
		hasText: "seed-01",
	});
	check("attachment messages collapse with file-name preview", (await attachmentRow.count()) > 0);
	check("collapsed row offers 展开", firstCollapsedPreview.includes("展开"));

	// -- expand on click ------------------------------------------------------
	const beforeCount = await page.locator(".msg-collapsed").count();
	await collapsed.first().click();
	await page.waitForSelector(".msg .msg-collapse-btn", { timeout: 5000 });
	const afterCount = await page.locator(".msg-collapsed").count();
	check("clicked row expanded (one less collapsed row)", afterCount === beforeCount - 1);
	await page.waitForSelector(".msg .msg-text", { timeout: 5000 });
	const expandedText = (await page.locator(".msg .msg-text").first().textContent()) ?? "";
	check("expanded content rendered (question text visible)", expandedText.includes("请总结这些文件"));
	const collapseBtn = await page
		.locator(".msg .msg-collapse-btn")
		.first()
		.textContent()
		.catch(() => null);
	check("expanded message shows 收起 button", collapseBtn?.includes("收起") ?? false);

	// -- collapse again -------------------------------------------------------
	await page.locator(".msg .msg-collapse-btn").first().click();
	await page.waitForSelector(".msg-collapsed", { timeout: 5000 });
	check("收起 collapses the message back", (await collapsed.count()) > 0);

	// -- no console errors ----------------------------------------------------
	check("no page errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) {
		console.log("   console errors:", consoleErrors.slice(0, 3));
	}

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
