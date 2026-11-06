import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-scrollstick-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
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
const CLIENT_ID = "scroll-stick-test-client";
const TALL_TEXT = "很长的需求描述。".repeat(2000);

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
				ws.send(
					JSON.stringify({
						type: "prompt",
						text: "请总结这些文件",
						attachments,
					}),
				);
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

const GROW_FN = `
	window.__grow = (ticks) => {
		window.__growLeft = ticks;
		window.__growTimer = setInterval(() => {
			if (window.__growLeft-- <= 0) return clearInterval(window.__growTimer);
			const el = document.querySelector('.messages');
			const d = document.createElement('div');
			d.style.height = '180px';
			el.appendChild(d);
		}, 90);
	};
`;
const distFromBottom = (page) =>
	page.evaluate(() => {
		const el = document.querySelector(".messages");
		return el.scrollHeight - el.scrollTop - el.clientHeight;
	});

async function main() {
	await waitServer();
	const total = await seedChat(38);
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
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

	await page.evaluate(() => {
		document.querySelector(".messages").scrollTop = 0;
	});
	await sleep(400);
	await page.locator(".scroll-bottom").click();
	await page.evaluate(() => window.__grow(5));
	await sleep(1400);
	let d = await distFromBottom(page);
	check(`auto-stick: viewport pinned while bottom grew (gap ${d}px < 80)`, d < 80);

	await sleep(400);
	await page.evaluate(() => window.__grow(4));
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	const before = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await sleep(2200);
	const after = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	const gap = await distFromBottom(page);
	check(`user escape: scroll position sticks (Δ${Math.abs(after - before)}px < 400)`, Math.abs(after - before) < 400);
	check(`user escape: no force-snap to bottom (gap ${gap}px > 300)`, gap > 300);

	await sleep(1200);
	const gapFinal = await distFromBottom(page);
	check(`post-stream: still no force-snap (gap ${gapFinal}px > 300)`, gapFinal > 300);

	await page.locator(".scroll-bottom").click();
	await sleep(1700);
	const collapseFn = `
		window.__collapse = (h) => {
			const el = document.querySelector('.messages');
			// Shrink an element fully ABOVE the viewport (like a tool card
			// collapsing on finalize): scrollHeight drops, scrollTop clamps up.
			let t = null;
			for (const m of el.querySelectorAll('.msg')) {
				const r = m.getBoundingClientRect();
				if (r.bottom < el.scrollTop && r.height > h + 10) { t = m; break; }
			}
			if (!t) { window.__collapseMiss = true; return; }
			window.__collapseMiss = false;
			const before = t.getBoundingClientRect().height;
			t.style.height = before - h + 'px';
			t.style.overflow = 'hidden';
		};
	`;
	await page.evaluate(collapseFn);
	await page.evaluate(() => window.__collapse(300));
	await sleep(500);
	let d3 = await distFromBottom(page);
	check(`layout-shift while stuck: viewport stays pinned (gap ${d3}px < 80, no phantom escape)`, d3 < 80);
	await sleep(1300);
	await page.evaluate(() => window.__collapse(300));
	await sleep(500);
	d3 = await distFromBottom(page);
	check(`layout-shift while stuck: second collapse still pinned (gap ${d3}px < 80)`, d3 < 80);
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -300);
	await sleep(400);
	const gapEsc = await distFromBottom(page);
	const stA = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await sleep(1500);
	const stB = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	check(
		`layout-shift while stuck: user intent still escapes and sticks (gap ${gapEsc}px > 250, Δ${Math.abs(stB - stA)}px < 100)`,
		gapEsc > 250 && Math.abs(stB - stA) < 100,
	);

	await sleep(600);
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	const visBefore = await page.evaluate(() => {
		const el = document.querySelector(".messages");
		window.__anchorCls = el.className;
		for (const m of el.querySelectorAll(".msg")) {
			const r = m.getBoundingClientRect();
			if (r.top >= 0 && r.bottom > 0) return r.top;
		}
		return null;
	});
	await page.evaluate(() => window.__collapse(300));
	await sleep(500);
	const visAfter = await page.evaluate(() => {
		for (const m of document.querySelectorAll(".messages .msg")) {
			const r = m.getBoundingClientRect();
			if (r.top >= 0 && r.bottom > 0) return r.top;
		}
		return null;
	});
	const anchorLive = await page.evaluate(() => window.__anchorCls.includes("anchor-live"));
	const gap4 = await distFromBottom(page);
	const visDelta = Math.abs((visAfter ?? 0) - (visBefore ?? 0));
	check(
		`layout-shift while escaped: viewport not dragged (visual Δ${visDelta}px < 80, anchor-live=${anchorLive}, gap ${gap4}px > 300)`,
		visDelta < 80 && gap4 > 300 && anchorLive,
	);

	await page.locator(".scroll-bottom").click();
	await sleep(1200);
	const gapPre = await distFromBottom(page);
	check(`composer-grow setup: stuck at bottom before mutation (gap ${gapPre}px < 80)`, gapPre < 80);
	const growComposer = `
		window.__growComposer = (px) => {
			const ta = document.querySelector('.inputbar textarea');
			if (!ta) return false;
			ta.style.height = (ta.getBoundingClientRect().height + px) + 'px';
			return true;
		};
	`;
	await page.evaluate(growComposer);
	const grew = await page.evaluate(() => window.__growComposer(160));
	check("composer-grow setup: composer element found and grown", grew === true);
	await sleep(500);
	const gapGrow = await distFromBottom(page);
	check(`composer-grow while stuck: RO re-pins bottom (gap ${gapGrow}px < 80)`, gapGrow < 80);
	const chipVisible = await page.locator(".scroll-bottom").isVisible();
	check("composer-grow while stuck: Back-to-bottom chip hidden", !chipVisible);

	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	const escSt = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await page.evaluate(() => window.__growComposer(160));
	await sleep(500);
	const escStAfter = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	const gapEscGrow = await distFromBottom(page);
	check(
		`composer-grow while escaped: viewport not dragged (Δ${Math.abs(escStAfter - escSt)}px < 80, gap ${gapEscGrow}px > 300)`,
		Math.abs(escStAfter - escSt) < 80 && gapEscGrow > 300,
	);

	const stress = `
		window.__stress = (ticks, escaped) => {
			window.__stressMaxGap = 0;
			window.__stressLeft = ticks;
			window.__stressGrow = true;
			window.__stressTimer = setInterval(() => {
				if (window.__stressLeft-- <= 0) return clearInterval(window.__stressTimer);
				const el = document.querySelector('.messages');
				const d = document.createElement('div');
				d.style.height = '120px';
				el.appendChild(d);
				// Below-container pulse: oscillate the composer so the scroll
				// container's border-box changes every tick (no scroll event).
				const ta = document.querySelector('.inputbar textarea');
				if (ta) {
					const cur = ta.getBoundingClientRect().height;
					ta.style.height = (window.__stressGrow ? cur + 40 : cur - 40) + 'px';
					window.__stressGrow = !window.__stressGrow;
					(window.__stressLog = window.__stressLog ?? []).push({
						gap: el.scrollHeight - el.scrollTop - el.clientHeight,
					});
				}
				// gap is sampled by the probe RO installed below (post-snap, painted
				// geometry). rAF sampling races the next interval tick (pre-RO) and
				// would be dishonest — RO delivers AFTER layout in the frame steps.
				window.__stressTop0 = window.__stressTop0 ?? el.scrollTop;
				window.__stressMinTop = Math.min(window.__stressMinTop ?? Infinity, el.scrollTop);
				window.__stressMaxTop = Math.max(window.__stressMaxTop ?? -Infinity, el.scrollTop);
			}, 200);
		};
	`;
	await page.evaluate(stress);
	await page.evaluate(`
		window.__probeGap = 0;
		window.__probe = new ResizeObserver(() => {
			const el = document.querySelector('.messages');
			const g = el.scrollHeight - el.scrollTop - el.clientHeight;
			window.__probeGap = Math.max(window.__probeGap, g);
			(window.__probeLog = window.__probeLog ?? []).push(g);
		});
		window.__probe.observe(document.querySelector('.messages'));
	`);

	await page.locator(".scroll-bottom").click();
	await sleep(900);
	await page.evaluate(() => {
		window.__probeGap = 0;
		window.__probeLog = [];
		window.__stressMinTop = Infinity;
		window.__stressMaxTop = -Infinity;
	});
	await page.evaluate(() => window.__stress(25, false));
	await sleep(5600);
	const maxGapC = await page.evaluate(() => window.__probeGap);
	check(`sustained streaming+pulses while stuck: pinned throughout (max painted gap ${maxGapC}px < 80)`, maxGapC < 80);

	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400);
	await page.evaluate(() => {
		window.__stressMinTop = Infinity;
		window.__stressMaxTop = -Infinity;
	});
	await page.evaluate(() => window.__stress(25, true));
	await sleep(5600);
	const [minTop, maxTop, gapD] = await page.evaluate(() => [
		window.__stressMinTop,
		window.__stressMaxTop,
		(() => {
			const el = document.querySelector(".messages");
			return el.scrollHeight - el.scrollTop - el.clientHeight;
		})(),
	]);
	check(
		`sustained streaming+pulses while escaped: no snaps (top range ${minTop}–${maxTop}, drift ${maxTop - minTop}px < 80, gap ${gapD}px > 300)`,
		maxTop - minTop < 80 && gapD > 300,
	);

	async function wheelApproach(stepPx) {
		await page.evaluate(() => {
			document.querySelector(".messages").scrollTop = 0;
		});
		await sleep(400);
		let ticks = 0;
		let gap = Infinity;
		let growthFinal = null;
		let finalPhase = false;
		let shFinalStart = 0;
		let stuckTicks = 0;
		let lastTop = -1;
		while (ticks < 220) {
			await page.mouse.move(700, 450);
			await page.mouse.wheel(0, stepPx);
			ticks++;
			await sleep(80);
			const st = await page.evaluate(() => {
				const el = document.querySelector(".messages");
				return {
					top: el.scrollTop,
					sh: el.scrollHeight,
					gap: el.scrollHeight - el.scrollTop - el.clientHeight,
				};
			});
			if (!finalPhase && st.gap < 2500) {
				finalPhase = true;
				shFinalStart = st.sh;
			}
			if (finalPhase) growthFinal = st.sh - shFinalStart;
			stuckTicks = st.top === lastTop ? stuckTicks + 1 : 0;
			lastTop = st.top;
			gap = st.gap;
			if (st.gap < 80) break;
			if (stuckTicks >= 6) break;
		}
		return { ticks, gap, growthFinal, reached: gap < 80 };
	}

	const pass1 = await wheelApproach(400);
	check(
		`wheel reachability PASS 1 (fresh approach): bottom reachable by wheel alone in ${pass1.ticks} ticks (gap ${pass1.gap}px < 80)`,
		pass1.reached,
	);

	const pass2 = await wheelApproach(400);
	check(`wheel reachability PASS 2: still reachable (gap ${pass2.gap}px < 80, ${pass2.ticks} ticks)`, pass2.reached);
	check(
		`wheel reachability PASS 2: swaps height-neutral in final approach (scrollHeight growth ${pass2.growthFinal}px < 60)`,
		pass2.growthFinal !== null && pass2.growthFinal < 60,
	);

	async function cascadeProbe(direction) {
		await page.evaluate((dir) => {
			const el = document.querySelector(".messages");
			el.scrollTop = dir === "down" ? 0 : el.scrollHeight;
		}, direction);
		await sleep(700);
		await page.evaluate(() => {
			window.__traj = [];
			window.__t0 = Date.now();
			window.__handoffT = Infinity;
			window.__sampler = setInterval(() => {
				const el = document.querySelector(".messages");
				window.__traj.push({
					t: Date.now() - window.__t0,
					top: el.scrollTop,
					sh: el.scrollHeight,
				});
			}, 50);
		});
		await page.mouse.move(700, 450);
		for (let i = 0; i < 10; i++) {
			await page.mouse.wheel(0, direction === "down" ? 400 : -400);
			await sleep(60);
		}
		await page.evaluate(() => {
			window.__handoffT = Date.now() - window.__t0;
		});
		await sleep(1000);
		const traj = await page.evaluate(() => {
			clearInterval(window.__sampler);
			return window.__traj;
		});
		const handoffMs = await page.evaluate(() => window.__handoffT);
		const post = traj.filter((p) => p.t >= handoffMs + 50);
		const tops = post.map((p) => p.top);
		const drift = Math.max(...tops) - Math.min(...tops);
		const shGrow = post[post.length - 1].sh - post[0].sh;
		const last = traj[traj.length - 1];
		return { drift, shGrow, gap: last.sh - last.top - 900 };
	}

	const cascUp = await cascadeProbe("up");
	check(
		`cascade UP: wheel-up x10 settles after handoff (drift ${cascUp.drift}px < 80, ΔscrollHeight ${cascUp.shGrow}px)`,
		cascUp.drift < 80 && Math.abs(cascUp.shGrow) < 120,
	);
	const cascDown = await cascadeProbe("down");
	check(
		`cascade DOWN: wheel-down x10 settles after handoff (drift ${cascDown.drift}px < 80, ΔscrollHeight ${cascDown.shGrow}px)`,
		cascDown.drift < 80 && Math.abs(cascDown.shGrow) < 120,
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
