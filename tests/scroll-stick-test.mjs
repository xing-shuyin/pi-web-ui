/* Scroll stick E2E: verifies the two pending assertions for the
 * Back-to-bottom fix in MessageList.tsx on a long (>30 msg) chat:
 *  (i)  auto-stick — scrollHeight growing after the jump (streaming appends)
 *       does not outrun scrollToBottom's re-asserts; viewport stays pinned;
 *  (ii) user escape — an upward wheel during/after the grace window sticks
 *       and never bounces back (no force-snap, even if layout shifts).
 * Run: npm run build && node tests/scroll-stick-test.mjs */
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

/** Seed a long chat via WS (same pattern as lazy-window-test). */
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

/** Start inflating scrollHeight like a streaming append would: a 180px-tall
 *  spacer every 90ms for `ticks` ticks, inside the scroll container. */
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

	// ---- (i) auto-stick: growth race after back-to-bottom ----
	// Real streaming appends arrive WITH React renders (effect at line ~443
	// re-pins); the scrollToBottom re-asserts (rAF x2 + 120/300/600ms) are the
	// backstop for growth within the ~600ms after the jump. Simulate growth in
	// that window: 5 ticks x 90ms ≈ 900px of bottom growth racing the re-asserts.
	await page.evaluate(() => {
		document.querySelector(".messages").scrollTop = 0;
	});
	await sleep(400);
	await page.locator(".scroll-bottom").click();
	await page.evaluate(() => window.__grow(5));
	await sleep(1400); // past the 600ms re-assert
	let d = await distFromBottom(page);
	check(`auto-stick: viewport pinned while bottom grew (gap ${d}px < 80)`, d < 80);

	// ---- (ii) user escape: upward wheel sticks, no bounce-back ----
	await sleep(400); // grace window (250ms) fully elapsed
	await page.evaluate(() => window.__grow(4)); // still "streaming" when user escapes
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400); // let the wheel's own scroll settle
	const before = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	await sleep(2200); // well past any re-assert timer / stream end — no force-snap
	const after = await page.evaluate(() => document.querySelector(".messages").scrollTop);
	const gap = await distFromBottom(page);
	check(`user escape: scroll position sticks (Δ${Math.abs(after - before)}px < 400)`, Math.abs(after - before) < 400);
	check(`user escape: no force-snap to bottom (gap ${gap}px > 300)`, gap > 300);

	// Post-stream: no late snap-back after growth stops
	await sleep(1200);
	const gapFinal = await distFromBottom(page);
	check(`post-stream: still no force-snap (gap ${gapFinal}px > 300)`, gapFinal > 300);

	// ---- (iii) layout-shift discriminator: collapse above viewport while
	// stuck, >1.5s after the last programmatic jump (outside grace window).
	// Simulates tool-card finalize / message trim: scrollHeight shrinks,
	// scrollTop clamps upward by the same amount. Must NOT be read as user
	// intent; stick must re-assert the snap and keep auto-following.
	await page.locator(".scroll-bottom").click();
	await sleep(1700); // well past the ~850ms effective grace window
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
	await page.evaluate(() => window.__collapse(300)); // mid-size shrink (-500 < dSt < -4)
	await sleep(500);
	let d3 = await distFromBottom(page);
	check(`layout-shift while stuck: viewport stays pinned (gap ${d3}px < 80, no phantom escape)`, d3 < 80);
	// Second collapse: stick must still be armed (escapedRef was not flipped),
	// so the re-assert keeps pinning through repeated layout shifts.
	await sleep(1300); // outside grace window again
	await page.evaluate(() => window.__collapse(300));
	await sleep(500);
	d3 = await distFromBottom(page);
	check(`layout-shift while stuck: second collapse still pinned (gap ${d3}px < 80)`, d3 < 80);
	// And a genuine wheel-up right after must still escape immediately
	// (proves the discriminator left real user intent fully armed).
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

	// ---- (iv) same collapse while NOT stuck (user reading above): must not
	// drag the viewport back down.
	// NOTE: assert VISUAL displacement, not raw scrollTop. With `anchor-live`
	// (overflow-anchor: auto) active while escaped, the browser legitimately
	// adjusts scrollTop by exactly the collapse amount to keep the reading
	// position visually fixed — a moving scrollTop is NOT the view being dragged
	// (probe: scrollTop Δ -300, visual Δ 0). Measure an in-view .msg rect.
	await sleep(600); // let growth settle
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

	// ---- (v) GEOMETRY-DRIVEN STICK: composer growth shrinks the scroll
	// container's border-box WITHOUT any scroll event — the scroll-event-driven
	// stick machinery is blind to it. The ResizeObserver must re-pin.
	// Check A: stick active, grow the composer (simulate typing growth),
	// container must re-pin within ~500ms with zero scroll/wheel input.
	await page.locator(".scroll-bottom").click();
	await sleep(1200); // expire the 600ms backstop + grace — ONLY the RO can pin now
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
	// RO callbacks run after layout, before paint — 500ms is a generous window,
	// and nothing else can re-pin here: no scroll events fire (scrollTop is
	// untouched by the shrink), and all re-assert timers have expired.
	await sleep(500);
	const gapGrow = await distFromBottom(page);
	check(`composer-grow while stuck: RO re-pins bottom (gap ${gapGrow}px < 80)`, gapGrow < 80);
	// Chip must be hidden again (RO re-pin keeps its state source consistent).
	const chipVisible = await page.locator(".scroll-bottom").isVisible();
	check("composer-grow while stuck: Back-to-bottom chip hidden", !chipVisible);

	// Check B: user escaped (reading above) + composer grows → must NOT move.
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

	// ---- (vi) SUSTAINED STREAMING + below-container pulses (checks C/D):
	// the drift class is COMPOUND — appends grow scrollHeight while the
	// composer / live-status boxes below the container animate, shrinking the
	// container with no scroll event. Stress both together for ~5s.
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
	// Probe RO: registered AFTER the app's RO, so Chrome delivers its callback
	// after the app's re-pin has run — it samples the gap as PAINTED, which is
	// the honest per-frame "stays pinned throughout" signal. (rAF sampling
	// races the next interval tick pre-RO and would measure transient states.)
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

	// Check C: stuck + sustained stress → pinned throughout (max painted gap).
	await page.locator(".scroll-bottom").click();
	await sleep(900); // expire backstops — RO + append effect must hold it alone
	await page.evaluate(() => {
		window.__probeGap = 0;
		window.__probeLog = [];
		window.__stressMinTop = Infinity;
		window.__stressMaxTop = -Infinity;
	});
	await page.evaluate(() => window.__stress(25, false));
	await sleep(5600); // 25 ticks x 200ms + margin
	const maxGapC = await page.evaluate(() => window.__probeGap);
	check(`sustained streaming+pulses while stuck: pinned throughout (max painted gap ${maxGapC}px < 80)`, maxGapC < 80);

	// Check D: escaped + same stress → viewport stays where the user put it.
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

	// ---- (vii) WHEEL REACHABILITY + SWAP CASCADE (v0.34 defect #1 — the
	// receding bottom). Johnson's live IDLE symptom: wheeling toward the bottom
	// stalls "almost there" (gap stays > 80px chip threshold) because
	// placeholder→real swaps GROW scrollHeight faster than the wheel descends,
	// and each wheel tick re-plans swaps (self-sustaining cascade drift).
	// With measured-height placeholders, swaps are height-neutral ⇒ wheel-only
	// reachability, near-zero second-pass growth, flat post-handoff trajectory.

	// Wheel-step from the very top (>> 2500px above bottom) toward the bottom
	// in fixed increments until the wheel's floor. Returns ticks used, final
	// gap, and scrollHeight growth during the FINAL approach (gap < 2500px).
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
			await sleep(80); // let the rAF sweep + swap settle
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
			if (st.gap < 80) break; // reached bottom — chip threshold cleared
			if (stuckTicks >= 6) break; // wheel floor reached short of bottom
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

	// CASCADE checks: 10 wheel ticks then hands off — the view must SETTLE
	// within ~500ms of the last tick: no continued self-scrolling (flat
	// scrollTop trajectory over the following 1s), no scrollHeight creep.
	async function cascadeProbe(direction) {
		await page.evaluate((dir) => {
			const el = document.querySelector(".messages");
			el.scrollTop = dir === "down" ? 0 : el.scrollHeight;
		}, direction);
		await sleep(700); // let swaps from the jump settle before the ticks
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
		// Handoff = the moment the LAST tick's own scroll landed — measured,
		// not assumed (dispatch overhead makes a fixed offset dishonest).
		await page.evaluate(() => {
			window.__handoffT = Date.now() - window.__t0;
		});
		await sleep(1000); // hands off — sample the post-handoff trajectory
		const traj = await page.evaluate(() => {
			clearInterval(window.__sampler);
			return window.__traj;
		});
		const handoffMs = await page.evaluate(() => window.__handoffT);
		const post = traj.filter((p) => p.t >= handoffMs + 50); // +50ms = one sample, past the last tick's echo
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
