/* Scroll-stick E2E: attribute-driven shrink regression (live hawkeye symptom).
 * A stuck-at-bottom chat receives a streaming append (childList growth) AND a
 * card-like block collapses every 2.5s via CLASS REMOVAL — a pure attribute
 * mutation (no childList change), like ThinkingBlock's open⇄collapsed flip.
 * The class flip above the viewport shrinks scrollHeight with NO scroll event
 * and NO container-box change, so onScroll's dSh discriminator and the RO are
 * both silent — at HEAD 3871698 the bottom drifts and the chip pops. The
 * content MutationObserver must catch it via attributes:true + a
 * scrollHeight-delta re-pin. Assert: stick survives ≥30s (gap ~0, chip hidden).
 * Run: npm run build && node tests/scroll-attr-collapse-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-attrcollapse-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
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
const CLIENT_ID = "attr-collapse-test-client";
const TALL_TEXT = "很长的需求描述。".repeat(1200);
const root = join(fileURLToPath(new URL("..", import.meta.url)));
const server = spawn(process.execPath, [join(root, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {}
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
		} catch {}
		await sleep(200);
	}
	throw new Error("server did not start");
}
/* Seed a long chat so .messages overflows and cards land above the viewport. */
function seedChat() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 180000);
		let step = 0;
		let known = 0;
		const sendNext = () => ws.send(JSON.stringify({ type: "prompt", text: `${TALL_TEXT}\n\n第 ${step++} 条` }));
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
			if (msg.type === "snapshot") total = msg.state.messages.length;
			else if (msg.type === "snapshot_delta" && known > 0) {
				known += msg.appended?.length ?? 0;
				total = known;
			}
			if (total < 0) return;
			known = Math.max(known, total);
			if (total >= 36) {
				clearTimeout(timer);
				ws.close();
				resolve(total);
			} else if (step < 35) sendNext();
		});
		ws.on("error", reject);
	});
}
/* Setup: pre-create collapsible "tool cards" ABOVE the viewport. The churn
/* Setup: pre-create collapsible "tool cards" ABOVE the viewport. The churn
 * itself must be attribute-ONLY (class removal + style mutation, no
 * childList/characterData): at HEAD the MO already re-pins on childList /
 * characterData mutations, which would mask the drift. Attribute flips fire
 * no observer, no scroll event, and no RO callback → silent drift at HEAD. */
const SETUP_FN = `
	window.__setup = (n) => {
		const el = document.querySelector('.messages');
		window.__cards = [];
		const style = document.createElement('style');
		style.textContent = '.attrcard.open { height: 200px; } .attrcard { height: 0; }';
		document.head.appendChild(style);
		for (let i = 0; i < n; i++) {
			const card = document.createElement('div');
			card.className = 'attrcard open';
			el.insertBefore(card, el.firstChild);
			window.__cards.push(card);
		}
	};
`;
const CHURN_FN = `
	window.__churn = (ticks) => {
		window.__churnLeft = ticks;
		window.__churnN = 0;
		window.__maxGap = 0;
		window.__churnTimer = setInterval(() => {
			if (window.__churnLeft-- <= 0) return clearInterval(window.__churnTimer);
			window.__churnN++;
			const el = document.querySelector('.messages');
			// (a) attribute-only collapse above the viewport: class removal
			// shrinks height 200→0 via CSS — no childList change on the card
			const card = window.__cards[window.__churnN - 1];
			if (card) card.classList.remove('open');
			// (b) style-attribute mutation shrink on a previously collapsed card
			const prev = window.__cards[window.__churnN - 2];
			if (prev) prev.style.marginTop = '-40px';
			// (c) concurrent streaming growth below (+300px) in the SAME layout
			// flush. The browser's scrollTop clamp then fires a scroll event with
			// dSt<0 but NET dSh>0 → classifyScroll reads it as user wheel-up and
			// flips escape (the live hawkeye symptom). Collapse-only ticks would
			// self-correct via clamp + dSh<0 reassert, hiding the bug.
			const d = document.createElement('div');
			d.style.height = '300px';
			el.appendChild(d);
		}, 2500);
	};
`;
const gapOf = () => {
	const el = document.querySelector(".messages");
	return el.scrollHeight - el.scrollTop - el.clientHeight;
};

/** Live-chat arrivals: a new user+assistant message pair every 3s (like the
 * hawkeye streaming session). With >36 seeded messages this drives
 * KEEP_RECENT summary-row collapses, lazy-window placeholder swaps and
 * virtualizer remounts on every arrival. */
function startArrivals(count) {
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	let left = count;
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID + "-arrivals" })));
	const timer = setInterval(() => {
		if (left-- <= 0) {
			clearInterval(timer);
			try {
				ws.close();
			} catch {}
			return;
		}
		try {
			ws.send(
				JSON.stringify({
					type: "prompt",
					text: `到达消息 ${left}\n${"流式内容行。".repeat(40)}`,
				}),
			);
		} catch {}
	}, 3000);
	return () => clearInterval(timer);
}

async function main() {
	await waitServer();
	const total = await seedChat();
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	await page.addInitScript((id) => localStorage.setItem("pi-web-client-id", id), CLIENT_ID);
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForSelector(".msg", { timeout: 30000 });
	await sleep(500);
	await page.addScriptTag({ content: SETUP_FN });
	await page.addScriptTag({ content: CHURN_FN });
	await page.evaluate(() => window.__setup(16));

	// Stick at the bottom (go up first to summon the chip), then let ALL
	// backstops expire — only the content MO can see what comes next
	// (no scroll events, no RO, no React renders).
	await page.evaluate(() => {
		document.querySelector(".messages").scrollTop = 0;
	});
	await sleep(400);
	await page.locator(".scroll-bottom").click();
	await sleep(1500);
	let gap = await page.evaluate(gapOf);
	check(`setup: pinned before churn (gap ${gap}px < 80)`, gap < 80);

	// ---- 36s of live arrivals (12 prompts x 3s): new user+assistant pairs
	// land while pinned — KEEP_RECENT summary-row collapses, lazy-window
	// placeholder swaps and virtualizer remounts all churn per arrival.
	const stopArrivals = startArrivals(12);
	let chipEverVisible = false;
	let maxGap = 0;
	for (let i = 0; i < 12; i++) {
		await sleep(3000);
		gap = await page.evaluate(gapOf);
		maxGap = Math.max(maxGap, gap);
		if (await page.locator(".scroll-bottom").isVisible()) chipEverVisible = true;
		check(`arrival ${(i + 1) * 3}s: still pinned (gap ${gap}px < 80, chip hidden)`, gap < 80);
	}
	stopArrivals();
	check("36s of arrivals: Back-to-bottom chip never appeared", !chipEverVisible);

	// Grace: user escape still works after the churn (no forced snap machinery).
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	const topA = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await sleep(1500);
	const topB = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	gap = await page.evaluate(gapOf);
	check(
		`post-churn: user escape still sticks (Δ${Math.abs(topB - topA)}px < 100, gap ${gap}px > 300)`,
		Math.abs(topB - topA) < 100 && gap > 300,
	);

	check("no page errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) console.log("   console errors:", consoleErrors.slice(0, 3));
	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
