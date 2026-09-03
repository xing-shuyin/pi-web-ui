/**
 * Regression test: crypto.randomUUID must never crash the app.
 *
 * crypto.randomUUID is ONLY available in secure contexts (HTTPS or localhost).
 * When pi-web-ui is served over plain HTTP on a LAN IP / remote host, or in
 * browsers without the API (Safari < 15.4), it is `undefined` — the WebSocket
 * `onopen` handler used to throw before sending `hello`, so the session never
 * attached (UI stuck, every feature dead), and opening a terminal crashed too.
 *
 * This test simulates that environment by deleting Crypto.prototype.randomUUID
 * before app code runs, then asserts:
 *   1. the connection still attaches (server snapshot arrives → hello was sent)
 *   2. opening a terminal still works (openTab's id generation)
 *   3. zero page errors mentioning randomUUID
 *
 * Runs on a dedicated port (8901). Usage: npm run build && node randomuuid-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8901;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;
// Hermetic workdir: the test server runs in a fresh temp dir so the user's
// real .pi/commands.json (in the project) is never loaded or modified.
const workdir = mkdtempSync(join(tmpdir(), "piweb-uuid-"));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: workdir },
		stdio: "ignore",
	});
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

// Simulate a non-secure context (plain HTTP on a LAN IP / old browser):
// strip crypto.randomUUID BEFORE any app code runs.
await page.addInitScript(() => {
	try {
		delete Crypto.prototype.randomUUID;
	} catch {
		/* noop */
	}
	try {
		Object.defineProperty(Crypto.prototype, "randomUUID", {
			value: undefined,
			configurable: true,
		});
	} catch {
		/* noop */
	}
});
check(
	"crypto.randomUUID actually removed",
	await page.goto(URL).then(() => page.evaluate(() => typeof crypto.randomUUID === "undefined")),
);

// ---- 1. connection must attach: hello sent, server snapshot arrives ----
// "已连接" alone is NOT sufficient (status flips to "open" before the throw);
// a server snapshot (footer cwd) proves the hello round-trip completed.
const attached = await page
	.waitForFunction(
		() => {
			const el = document.querySelector(".status-cwd");
			return el && el.textContent.length > 0;
		},
		{ timeout: 15000 },
	)
	.then(() => true)
	.catch(() => false);
check("session attaches without crypto.randomUUID (hello + snapshot)", attached);

// ---- 2. opening a terminal must not crash (openTab id generation) ----
let tab = false;
let termRan = false;
try {
	await page.click('.view-switch button:has-text("终端")');
	await page.waitForSelector(".terminal-view", { timeout: 5000 });
	await page.click(".term-commands .panel-new");
	await page.fill("#cmd-name", "uuid-regression");
	await page.fill("#cmd-command", "echo UUID_OK");
	await page.fill("#cmd-cwd", "${pwd}");
	await page.click(".cmd-form-actions .btn.primary");
	await sleep(500);
	// Target OUR command row specifically — with a hermetic workdir the list
	// starts empty, but never assume "the first .cmd-run" is ours.
	await page.locator(".cmd-item", { hasText: "uuid-regression" }).locator(".cmd-run").click();
	tab = await page
		.waitForSelector(".term-tab", { timeout: 8000 })
		.then(() => true)
		.catch(() => false);
	if (tab) {
		const deadline = Date.now() + 10000;
		let termText = "";
		while (Date.now() < deadline) {
			termText = await page.textContent(".term-main").catch(() => "");
			if (termText.includes("UUID_OK")) break;
			await sleep(500);
		}
		termRan = termText.includes("UUID_OK");
		if (!termRan) console.log(`⚠ term-main dump: ${JSON.stringify(termText.slice(0, 300))}`);
	}
} catch (err) {
	console.log(`⚠ terminal section aborted: ${err.message.split("\n")[0]}`);
}
check("terminal tab opens without crypto.randomUUID", tab);
check("terminal command ran", termRan);

// ---- 3. zero randomUUID errors anywhere ----
const uuidErrors = pageErrors.filter((e) => e.includes("randomUUID"));
check("no randomUUID page errors", uuidErrors.length === 0, uuidErrors.slice(0, 3).join(" | "));

await browser.close();
await stopServer();
try {
	rmSync(workdir, { recursive: true, force: true });
} catch {
	/* noop */
}
console.log(failures === 0 ? "\nALL randomUUID TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
