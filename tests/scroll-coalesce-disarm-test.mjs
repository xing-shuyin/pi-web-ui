/* Scroll-stick E2E: growth-coalescence disarm regression (live-dump verified).
 * Reproduces the hawkeye event chain captured on instrumented build efbf289:
 * while pinned at the bottom, streaming growth (~94px/100ms) coalesces TWO
 * flushes into the SAME scroll event as a user wheel-down tick (~93.6px):
 * dSh≈188 but dSt=+93.6 → gap≈94 → nearBottom=false. At HEAD the onScroll
 * stick assignment reads "not near bottom" as leaving intent and disarms the
 * stick (esc:false, dSt>0 — NO upward gesture happened), so the MO/RO
 * re-pins go dead and the gap locks open while the user keeps wheeling DOWN
 * toward the bottom — unreachable until Back-to-bottom. The identical event
 * inside the post-BtB grace window survives; outside it kills the stick.
 * Assert: (a) stick never disarms on downward scrolls (chip stays hidden);
 * (b) every coalescence gap closes to <80 within 1s; (c) over a sustained
 * ~30s run the gap is ≥80 for <8% of samples (no ~94px lock); (d) upward
 * wheel still escapes (existing semantics intact).
 * Run: npm run build && node tests/scroll-coalesce-disarm-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-coalesce-"));
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
const CLIENT_ID = "scroll-coalesce-test-client";
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

/** Seed a long chat via WS (same pattern as scroll-attr-collapse-test). */
function seedChat(want) {
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
			if (total >= want) {
				clearTimeout(timer);
				ws.close();
				resolve(total);
			} else if (step < want) sendNext();
		});
		ws.on("error", reject);
	});
}

/* Streaming growth: a 94px spacer every 100ms, like the hawkeye stream's
 * per-tick growth (~94px). Runs continuously through the down-phase. */
const GROW_FN = `
	window.__growStart = () => {
		window.__growTimer = setInterval(() => {
			const el = document.querySelector('.messages');
			const d = document.createElement('div');
			d.style.height = '94px';
			el.appendChild(d);
		}, 100);
	};
	window.__growStop = () => clearInterval(window.__growTimer);
`;
/* Coalescence arm: on the NEXT wheel event, synchronously append TWO 94px
 * flushes inside the wheel listener (before the browser applies the wheel
 * scroll). The resulting scroll event carries dSh≈188 against dSt≈93.6 and
 * opens a ~94px gap — the exact dump geometry, deterministic per cycle. */
const COALESCE_FN = `
	window.__coalesced = 0;
	window.__coalesceArm = false;
	window.__armCoalesce = () => { window.__coalesceArm = true; };
	window.addEventListener('wheel', () => {
		if (!window.__coalesceArm) return;
		window.__coalesceArm = false;
		const el = document.querySelector('.messages');
		for (let i = 0; i < 2; i++) {
			const d = document.createElement('div');
			d.style.height = '94px';
			el.appendChild(d);
		}
		window.__coalesced++;
	}, { passive: true });
`;
/* 50ms gap sampler + exact chip watcher (MutationObserver on the wrap that
 * hosts .scroll-bottom — no polling round-trips, no missed appearances). */
const PROBE_FN = `
	window.__samples = [];
	window.__chipSeen = false;
	window.__probeStart = () => {
		const t0 = performance.now();
		window.__probeTimer = setInterval(() => {
			const el = document.querySelector('.messages');
			window.__samples.push({
				t: performance.now() - t0,
				gap: el.scrollHeight - el.scrollTop - el.clientHeight,
			});
		}, 50);
		new MutationObserver(() => {
			if (document.querySelector('.scroll-bottom')) window.__chipSeen = true;
		}).observe(document.querySelector('.messages-wrap'), { childList: true, subtree: true });
	};
`;

async function main() {
	await waitServer();
	const total = await seedChat(38);
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
	await page.addScriptTag({ content: GROW_FN });
	await page.addScriptTag({ content: COALESCE_FN });
	await page.addScriptTag({ content: PROBE_FN });

	// Arm the stick via Back-to-bottom, then let ALL backstops expire (600ms
	// re-assert + ~850ms effective grace) — everything that follows is pure
	// user-downward input + streaming growth, fully OUTSIDE the grace window.
	await page.evaluate(() => {
		document.querySelector(".messages").scrollTop = 0;
	});
	await sleep(400);
	await page.locator(".scroll-bottom").click();
	await sleep(1600);
	let gap = await page.evaluate(() => {
		const el = document.querySelector(".messages");
		return el.scrollHeight - el.scrollTop - el.clientHeight;
	});
	check(`setup: pinned before the run (gap ${gap}px < 80)`, gap < 80);

	// ---- ~30s sustained: growth 94px/100ms + wheel-down 93.6px/100ms, with a
	// forced two-flush coalescence every 12th tick (dSh≈188 vs dSt≈93.6) — the
	// dump's gap-opening event, ~25 times, while the stick is armed.
	await page.mouse.move(700, 450);
	await page.evaluate(() => window.__probeStart());
	await page.evaluate(() => window.__growStart());
	const CYCLES = 300; // 300 × ~100ms ≈ 30s
	for (let i = 0; i < CYCLES; i++) {
		if (i % 12 === 3) await page.evaluate(() => window.__armCoalesce());
		await page.mouse.wheel(0, 93.6);
		await sleep(100);
	}
	await sleep(800); // let the final re-pin land before judging
	const [coalesced, samples, chipSeen] = await page.evaluate(() => {
		clearInterval(window.__probeTimer);
		window.__growStop();
		return [window.__coalesced, window.__samples, window.__chipSeen];
	});

	// Harness validity: the dump geometry actually fired.
	check(`harness: ${coalesced} coalesced (dSh≈188 vs dSt≈93.6) events fired`, coalesced >= 20);

	// (a) Stick must never disarm on downward scrolls: at HEAD the first
	// coalesced event flips stickRef and the chip pops immediately.
	check("(a) downward phase: stick never disarms (chip hidden whole run)", !chipSeen);

	// (b) Every gap excursion ≥80px must close to <80px within 1s.
	let excStart = null;
	let worst = 0;
	let stillOpen = false;
	for (const s of samples) {
		if (s.gap >= 80) {
			if (excStart === null) excStart = s.t;
		} else if (excStart !== null) {
			worst = Math.max(worst, s.t - excStart);
			excStart = null;
		}
	}
	if (excStart !== null) stillOpen = true;
	check(
		`(b) every coalescence gap closes <80 within 1s (worst ${Math.round(worst)}ms${stillOpen ? ", STILL OPEN at end" : ""})`,
		!stillOpen && worst < 1000,
	);

	// (c) Sustained ~30s: the gap is ≥80px for <8% of samples — no ~94px lock.
	const hot = samples.filter((s) => s.gap >= 80).length;
	const hotPct = (100 * hot) / samples.length;
	check(`(c) sustained: gap ≥80 for ${hotPct.toFixed(1)}% of samples (< 8%, no lock)`, hotPct < 8);

	// (d) Existing behavior intact: an upward wheel still escapes and stays
	// escaped (growth already stopped; nothing may drag the viewport back).
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	const topA = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await sleep(1500);
	const topB = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	gap = await page.evaluate(() => {
		const el = document.querySelector(".messages");
		return el.scrollHeight - el.scrollTop - el.clientHeight;
	});
	check(
		`(d) upward wheel: escape still sticks (Δ${Math.abs(topB - topA)}px < 100, gap ${gap}px > 300)`,
		Math.abs(topB - topA) < 100 && gap > 300,
	);
	check(
		"(d) upward wheel: Back-to-bottom chip appears (escape visible)",
		await page.locator(".scroll-bottom").isVisible(),
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
