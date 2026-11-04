// PI_WEB_TOKEN optional auth — protocol smoke test (zero token).
//
// When PI_WEB_TOKEN is set on the server:
//   1. /api/health stays open (monitoring probes)
//   2. HTTP requests without a valid token → 401
//   3. ?token= query param accepted + Set-Cookie pi_web_token issued
//   4. Authorization: Bearer / X-PI-Token headers accepted
//   5. WS upgrade without token → rejected; with ?token= → connects
//   6. Re-entry via ?token= refreshes the cookie (idempotent, issue #71#1)
//   7. Server restart with a NEW PI_WEB_TOKEN while the browser still holds the
//      old cookie: stale cookie gets expired on 401, one ?token=new entry
//      re-syncs the cookie, no manual cache clearing needed (issue #71#2)
//   8. A token containing URL-special characters (`=` etc., issue #261): the
//      cookie is stored encodeURIComponent'd, so cookie-only navigation must
//      still authenticate (it used to 401 on every asset after the ?token= hit).
// Without PI_WEB_TOKEN everything behaves as before (no auth middleware).
//
// Usage: npm run build && node tests/token-auth-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8975);
const TOKEN = "s3cret-token-xyz";
const TOKEN2 = "s3cret-token-xyz-2";
/** issue #261 的原样复现口令：base64 尾巴上带 `=`（下发时会被转义成 %3D）。 */
const TOKEN3 = "00mJYc4g8rnJVJOxqBlaSiGrszirmeVQCmGnrmw8i8s=";
const base = mkdtempSync(join(tmpdir(), "pi-web-tokenauth-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

/** Spawn the built server with the given PI_WEB_TOKEN; resolve when /api/health is up. */
function startServer(token) {
	const server = spawn(NODE, ["dist/server/index.js"], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workdir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_TOKEN: token,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	server.stdout.on("data", () => {});
	server.stderr.on("data", () => {});
	return (async () => {
		for (let i = 0; i < 60; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
				if (res.ok) return server;
			} catch {
				/* not up yet */
			}
			await sleep(300);
		}
		throw new Error("server did not become ready");
	})();
}

async function stopServer(server) {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}

/** Minimal cookie jar: collect Set-Cookie (incl. expiry) from a response. */
let jar = "";
function jarHeader(res) {
	const all = [];
	for (const h of ["set-cookie"]) {
		if (res.headers.has(h)) all.push(res.headers.get(h));
	}
	return all.join("; ");
}
function applyJar(res) {
	const set = jarHeader(res);
	if (!set) return;
	// replace any existing pi_web_token entry with the newest one
	const entry = set.split("; ").find((part) => part.startsWith("pi_web_token="));
	if (!entry) return;
	const value = entry.split("=").slice(1).join("=") ?? "";
	const expires = value === "" || value.includes("Max-Age=0");
	jar = expireJar(jar);
	if (!expires) jar = `pi_web_token=${value}`;
}
function expireJar(incoming) {
	return (incoming || "")
		.split("; ")
		.filter((part) => part && !part.startsWith("pi_web_token="))
		.join("; ");
}
function httpGet(path, headers = {}) {
	return fetch(`http://127.0.0.1:${PORT}${path}`, {
		headers: jar ? { cookie: jar, ...headers } : headers,
	});
}

/** WS connect that resolves only when the socket opens; rejects otherwise. */
function wsTry(path, headers = {}) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, headers && { headers });
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error("timeout"));
		}, 4000);
		ws.on("open", () => {
			clearTimeout(timer);
			ws.close();
			resolve(true);
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			resolve({ error: err.message }); // upgrade rejection surfaces here
		});
	});
}

let server = null;
try {
	server = await startServer(TOKEN);

	// 1. health is open even with token auth enabled
	const h = await fetch(`http://127.0.0.1:${PORT}/api/health`);
	check("health open without token", h.status === 200);

	// 1b. health must NOT reflect the real token via Set-Cookie (issue #45)
	const hc = jarHeader(h);
	check(
		"health does NOT leak pi_web_token in Set-Cookie",
		!hc.includes(`pi_web_token=${encodeURIComponent(TOKEN)}`),
		hc || "<no set-cookie>",
	);
	check("health issues no Set-Cookie at all", hc === "", hc || "<no set-cookie>");

	// 2. protected route rejects missing/invalid token
	const r1 = await httpGet("/");
	check("GET / without token → 401", r1.status === 401);
	const r2 = await httpGet("/?token=wrong");
	check("GET / with wrong token → 401", r2.status === 401);
	const api = await httpGet("/api/themes");
	check("GET /api/themes without token → 401", api.status === 401);

	// 2a. browser HTML navigation without token returns 401 HTML prompt page
	const rHtml = await httpGet("/", { accept: "text/html,application/xhtml+xml" });
	check("GET / with Accept: text/html → 401", rHtml.status === 401);
	const htmlText = await rHtml.text();
	check(
		"401 HTML page contains title and token self-healing script",
		htmlText.includes("需要访问口令") && htmlText.includes("pi-web-ui:token"),
		htmlText.slice(0, 200),
	);
	check("401 HTML page on loopback contains /setup link", htmlText.includes('href="/setup"'), htmlText.slice(0, 200));

	// 2b. existing-cookie-but-wrong-token requests also clear the stale cookie
	const r2b = await httpGet("/", { cookie: `pi_web_token=${encodeURIComponent("nope")}` });
	check("GET / with stale cookie value → 401", r2b.status === 401);
	const sc2b = jarHeader(r2b);
	check(
		"401 with stale cookie expires it (Max-Age=0)",
		sc2b.includes("Max-Age=0") && sc2b.includes("pi_web_token=;"),
		sc2b,
	);

	// 3. query-param token accepted and cookie issued
	const r3 = await httpGet(`/?token=${encodeURIComponent(TOKEN)}`);
	check("GET / with ?token= → 200", r3.status === 200);
	const setCookie = jarHeader(r3);
	check(
		"Set-Cookie issues HttpOnly pi_web_token",
		setCookie.includes("pi_web_token=") && setCookie.toLowerCase().includes("httponly"),
		setCookie,
	);
	applyJar(r3);

	// 3b. re-entry with the same valid ?token= is idempotent (issue #71#1):
	// cookie still matches the server token, so no refresh needed but 200 anyway
	const r3b = await httpGet(`/?token=${encodeURIComponent(TOKEN)}`);
	check("GET / again with same ?token= → 200", r3b.status === 200);

	// 4. header-based tokens accepted
	const r4 = await httpGet("/", { authorization: `Bearer ${TOKEN}` });
	check("Authorization: Bearer accepted", r4.status === 200);
	const r5 = await httpGet("/", { "x-pi-token": TOKEN });
	check("X-PI-Token header accepted", r5.status === 200);

	// 5. WS handshake enforcement
	const wsNoToken = await wsTry("/ws");
	check("WS without token rejected", typeof wsNoToken === "object", JSON.stringify(wsNoToken));
	const wsOk = await wsTry(`/ws?token=${encodeURIComponent(TOKEN)}`);
	check("WS with ?token= connects", wsOk === true, JSON.stringify(wsOk));
	const wsBad = await wsTry("/ws?token=nope");
	check("WS with wrong token rejected", typeof wsBad === "object");

	// ---- issue #71#2: server token changed while the browser still holds the old cookie ----
	await stopServer(server);
	server = await startServer(TOKEN2); // restart with a NEW secret

	// 7a. old cookie alone now fails and gets expired (no cache clearing needed later)
	const stale1 = await httpGet("/");
	check("GET / with stale cookie after token change → 401", stale1.status === 401);
	const scStale = jarHeader(stale1);
	check(
		"stale cookie expired on 401 (Max-Age=0)",
		scStale.includes("Max-Age=0") && scStale.includes("pi_web_token=;"),
		scStale,
	);
	check("401 body hints at changed server token", (await stale1.text()).includes("口令已变更"), "<body>");
	applyJar(stale1); // jar now empty — browser would have dropped the cookie

	// 7b. one correct ?token= entry re-syncs the cookie to the new secret
	const heal = await httpGet(`/?token=${encodeURIComponent(TOKEN2)}`);
	check("GET /?token=new after token change → 200", heal.status === 200);
	const scHeal = jarHeader(heal);
	check(
		"healed cookie now carries the NEW token",
		scHeal.includes(`pi_web_token=${encodeURIComponent(TOKEN2)}`),
		scHeal,
	);
	applyJar(heal);

	// 7c. subsequent plain navigation works from the healed cookie alone
	const healedNav = await httpGet("/");
	check("GET / with healed cookie (no query) → 200", healedNav.status === 200);
	const wsHealed = await wsTry("/ws", { cookie: jar });
	check("WS with healed cookie connects", wsHealed === true, JSON.stringify(wsHealed));

	// ---- issue #261: 口令含 URL 特殊字符时，cookie 里的转义值必须仍能鉴权 ----
	await stopServer(server);
	server = await startServer(TOKEN3);
	jar = "";

	// 8a. 错的 token 仍然 401（确认没把比对放松掉）
	const wrong3 = await httpGet(`/?token=${encodeURIComponent(`${TOKEN3}x`)}`);
	check("特殊字符口令：错的 ?token= 仍 401", wrong3.status === 401);

	// 8b. 头/查询参数路径本来就传原文，先确认它们没受编码影响
	const hdr3 = await httpGet("/", { "x-pi-token": TOKEN3 });
	check("特殊字符口令：X-PI-Token 头接受", hdr3.status === 200);
	const bearer3 = await httpGet("/", { authorization: `Bearer ${TOKEN3}` });
	check("特殊字符口令：Authorization: Bearer 接受", bearer3.status === 200);

	const q3 = await httpGet(`/?token=${encodeURIComponent(TOKEN3)}`);
	check("特殊字符口令：?token= → 200", q3.status === 200);
	const sc3 = jarHeader(q3);
	check(
		"特殊字符口令：cookie 存的是 URL 编码值（与浏览器一致）",
		sc3.includes(`pi_web_token=${encodeURIComponent(TOKEN3)}`),
		sc3 || "<no set-cookie>",
	);
	applyJar(q3);

	// 8c. 关键回归：只凭 cookie 导航（修前这里是 401 —— cookie 里是 %3D，服务端拿它和 = 比）
	const nav3 = await httpGet("/");
	check("特殊字符口令：仅凭 cookie 导航 → 200", nav3.status === 200);
	const ws3 = await wsTry("/ws", { cookie: jar });
	check("特殊字符口令：WS 凭 cookie 连接", ws3 === true, JSON.stringify(ws3));

	// 8d. 明文 cookie（手写 / 旧客户端）同样接受
	const rawCookie3 = await httpGet("/", { cookie: `pi_web_token=${TOKEN3}` });
	check("特殊字符口令：明文 cookie 也接受", rawCookie3.status === 200);

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	await stopServer(server);
	process.exit(failed === 0 ? 0 : 1);
}
