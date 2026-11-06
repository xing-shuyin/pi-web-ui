import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8901;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;
const dataDir = mkdtempSync(join(tmpdir(), "piweb-uuid-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "piweb-uuid-agent-"));
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
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: workdir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return true;
		} catch {}
	}
	return false;
}
async function stopServer() {
	if (server) {
		try {
			server.kill("SIGKILL");
		} catch {}
		server = null;
	}
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			return;
		}
	}
	console.error("⚠ port did not free — killing stragglers");
	try {
		await freePort(PORT);
	} catch {}
}

try {
	ensureBuild(PROJ, "randomuuid-test");
} catch (err) {
	console.error(String(err?.message ?? err));
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

await page.addInitScript(() => {
	try {
		delete Crypto.prototype.randomUUID;
	} catch {}
	try {
		Object.defineProperty(Crypto.prototype, "randomUUID", {
			value: undefined,
			configurable: true,
		});
	} catch {}
});
check(
	"crypto.randomUUID actually removed",
	await page.goto(URL).then(() => page.evaluate(() => typeof crypto.randomUUID === "undefined")),
);

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

let tab = false;
let termRan = false;
try {
	await page.click('.topbar-flow [role="tab"]:has-text("终端")');
	await page.waitForSelector(".terminal-view", { timeout: 5000 });
	await page.click(".term-commands .panel-new");
	await page.fill("#cmd-name", "uuid-regression");
	await page.fill("#cmd-command", "echo UUID_OK");
	await page.fill("#cmd-cwd", "${pwd}");
	await page.click(".cmd-form-actions .btn.primary");
	await sleep(500);
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

const uuidErrors = pageErrors.filter((e) => e.includes("randomUUID"));
check("no randomUUID page errors", uuidErrors.length === 0, uuidErrors.slice(0, 3).join(" | "));

await browser.close();
await stopServer();
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(workdir, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL randomUUID TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
