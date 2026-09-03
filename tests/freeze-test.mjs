/**
 * Freeze/reconnect regression test.
 *
 * Scenario (mirrors the reported bug):
 *   1. server up → page connects
 *   2. server killed → page must stay responsive, reconnect attempts must be
 *      bounded (exponential backoff), and at most ONE socket in flight at a time
 *   3. server restarted → page must auto-recover and complete a prompt round-trip
 *
 * Any page freeze (blocked main thread) or connection flood fails the test.
 * Runs on a dedicated port (8899) to avoid stray processes.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PI_WEB_PORT: String(PORT) },
		stdio: "ignore",
	});
	// Wait until the port actually listens (or the process died).
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return true;
		} catch {
			/* not up yet */
		}
	}
	return false;
}
async function stopServer() {
	if (server) {
		try {
			server.kill("SIGKILL");
		} catch {
			/* noop */
		}
		server = null;
	}
	// Wait until the port is actually free.
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			return; // free
		}
	}
	console.error("⚠ port did not free — killing stragglers");
	try {
		await freePort(PORT);
	} catch {
		/* noop */
	}
}

// Build first so web/dist is fresh.
try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch (err) {
	console.error("build failed:", err.message);
	process.exit(1);
}
await stopServer();
if (!(await startServer())) {
	console.error("server failed to start");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
});

// Connection-refused errors during the deliberate downtime are expected;
// anything else (e.g. "Insufficient resources", JS exceptions) is a failure.
const isExpectedError = (text) => text.includes("ERR_CONNECTION_REFUSED") || text.includes("Connection reset");

// Instrument WebSocket before app code runs: count instances / active sockets.
await page.addInitScript(() => {
	window.__wsCount = { created: 0, active: 0, maxActive: 0, closed: 0 };
	const Orig = window.WebSocket;
	window.WebSocket = class extends Orig {
		constructor(...args) {
			super(...args);
			window.__wsCount.created++;
			window.__wsCount.active++;
			window.__wsCount.maxActive = Math.max(window.__wsCount.maxActive, window.__wsCount.active);
			this.addEventListener("close", () => {
				window.__wsCount.active--;
				window.__wsCount.closed++;
			});
			this.addEventListener("error", () => {});
		}
	};
});

await page.goto(URL);
const connected = await page
	.waitForFunction(() => document.querySelector(".conn-label")?.textContent?.includes("已连接"), { timeout: 15000 })
	.then(() => true)
	.catch(() => false);
check("initial connect", connected);

// ---- kill the server: page must stay responsive with bounded reconnects ----
await stopServer();
await sleep(1200);
const responsive1 = await page
	.evaluate(() => {
		const start = performance.now();
		let x = 0;
		for (let i = 0; i < 2_000_000; i++) x += i;
		return { ms: performance.now() - start };
	})
	.catch(() => null);
check("page responsive with server down", !!responsive1 && responsive1.ms < 3000, JSON.stringify(responsive1));

// Give the client a few backoff attempts (~1s+2s+4s) to prove boundedness.
await sleep(9000);
const c1 = await page.evaluate(() => window.__wsCount);
check("at most one socket in flight at a time", c1.maxActive <= 1, JSON.stringify(c1));
check("bounded reconnect attempts while down", c1.created <= 6, `created=${c1.created}`);
check("page still responsive after 9s of downtime", (await page.evaluate(() => 40 + 2)) === 42);

// ---- restart the server: must auto-recover ----
if (!(await startServer())) {
	check("server restarted", false, "start failed");
} else {
	check("server restarted", true);
}
const recovered = await page
	.waitForFunction(() => document.querySelector(".conn-label")?.textContent?.includes("已连接"), { timeout: 25000 })
	.then(() => true)
	.catch(() => false);
check("auto-reconnect after server restart", recovered);

// ---- prompt round-trip after recovery (text-stability completion detector) ----
const reply = await page.evaluate(async () => {
	const ta = document.querySelector("textarea");
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
	setter.call(ta, "Reply with exactly: recovered");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	await new Promise((r) => setTimeout(r, 100));
	const sendBtn = [...document.querySelectorAll("button")].find((b) => b.title === "发送（Enter）");
	sendBtn.click();

	const sample = () => {
		const msgs = [...document.querySelectorAll(".msg")];
		const last = msgs[msgs.length - 1];
		return last?.getAttribute("data-role") === "assistant" ? last.textContent.trim() : null;
	};
	let prev = null;
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1500));
		const cur = sample();
		if (cur && cur === prev && cur.length > 0) return cur.slice(0, 120);
		prev = cur;
	}
	return null;
});
check("prompt round-trip after recovery", !!reply, JSON.stringify(reply?.slice(0, 60)));

check(
	"no unexpected page errors",
	pageErrors.filter((e) => !isExpectedError(e)).length === 0,
	pageErrors
		.filter((e) => !isExpectedError(e))
		.slice(0, 3)
		.join(" | "),
);

await browser.close();
await stopServer();
console.log(failures === 0 ? "\nALL FREEZE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
