import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-fence-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
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
cpSync(join(fileURLToPath(new URL("..", import.meta.url)), "plugins", "mermaid"), join(dataDir, "plugins", "mermaid"), {
	recursive: true,
});

process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const CLIENT_ID = "fence-render-client";
const READING_CONTEXT = Array.from({ length: 80 }, (_, i) => `${i + 1}. Mermaid theme regression context`).join("\n");
const MERMAID_TEXT = `${READING_CONTEXT}\n\n\`\`\`mermaid\nflowchart LR\n  A[开始] --> B[结束]\n\`\`\`\n`;
const PLAIN_TEXT = "```plantuml\nA -> B\n```";

const server = spawn(
	process.execPath,
	[join(fileURLToPath(new URL("..", import.meta.url)), "dist", "server", "index.js")],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
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

function seedMessage() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 20_000);
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID })));
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") {
				ws.send(JSON.stringify({ type: "prompt", text: MERMAID_TEXT + PLAIN_TEXT }));
				const poll = setInterval(() => ws.send(JSON.stringify({ type: "get_state" })), 1000);
				setTimeout(() => clearInterval(poll), 15_000);
			}
			if (msg.type === "snapshot") {
				const mine = msg.state.messages.filter((m) => {
					const t = Array.isArray(m.content) ? m.content.map((c) => (c && "text" in c ? c.text : "")).join("") : "";
					return m.role === "user" && t.includes("```mermaid");
				});
				if (mine.length > 0) {
					clearTimeout(timer);
					ws.close();
					resolve();
				}
			}
		});
		ws.on("error", reject);
	});
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	await waitServer();
	console.log("seeding mermaid + plantuml fence message…");
	await seedMessage();

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	const cdnHits = [];
	page.on("request", (r) => {
		if (r.url().includes("esm.sh") || r.url().includes("jsdelivr")) cdnHits.push(r.url());
	});
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

	let svgOk = false;
	let plainOk = false;
	for (let i = 0; i < 120; i++) {
		await sleep(1000);
		const state = await page
			.evaluate(() => {
				const svg = document.querySelector(".mermaid-block svg");
				const hasSvg = !!svg && svg.getAttribute("width") !== "";
				const pre = [...document.querySelectorAll(".codeblock pre code")].find((c) => c.textContent.includes("A -> B"));
				return { hasSvg, plain: !!pre };
			})
			.catch(() => ({ hasSvg: false, plain: false }));
		if (state.hasSvg) svgOk = true;
		if (state.plain) plainOk = true;
		if (svgOk && plainOk) break;
	}

	check("```mermaid 围栏被插件渲染为 SVG（.mermaid-block svg）", svgOk);
	check("```plantuml 无插件认领 → 回退普通代码块", plainOk);
	console.log("  [cdnHits]", JSON.stringify(cdnHits));
	check("渲染期间未请求外网 CDN（esm.sh/jsdelivr）——本地 vendor 生效", cdnHits.length === 0);

	const bundle = await page.evaluate(() =>
		fetch("/plugins/mermaid/client/entry.mjs")
			.then((r) => (r.ok ? r.text() : ""))
			.then((t) => t.length > 0),
	);
	check("插件 bundle 经 /plugins/mermaid/client/entry.mjs 可达", bundle);

	async function applyTheme(theme) {
		await page.evaluate(async (id) => {
			let link = document.getElementById("theme-stylesheet");
			if (!link) {
				link = document.createElement("link");
				link.id = "theme-stylesheet";
				link.rel = "stylesheet";
				document.head.appendChild(link);
			}
			await new Promise((resolve, reject) => {
				link.onload = resolve;
				link.onerror = reject;
				link.href = `/themes/${id}.css?e2e=${Date.now()}`;
			});
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}, theme);
	}

	const initialSvgId = await page.locator(".mermaid-block svg").getAttribute("id");
	await applyTheme("cyberpunk");
	await page.waitForFunction((id) => document.querySelector(".mermaid-block svg")?.id !== id, initialSvgId);
	const beforeThemeSwitch = await page.evaluate(() => {
		const svg = document.querySelector(".mermaid-block svg");
		const shape = svg?.querySelector(".node rect, .node polygon, .node path");
		const list = document.querySelector(".messages");
		if (list) {
			list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2);
			list.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
		}
		window.__mermaidMissingDuringThemeRender = false;
		window.__mermaidPresenceTimer = window.setInterval(() => {
			if (!document.querySelector(".mermaid-block svg")) window.__mermaidMissingDuringThemeRender = true;
		}, 1);
		return {
			id: svg?.id,
			stroke: shape ? getComputedStyle(shape).stroke : null,
			scrollTop: list?.scrollTop ?? null,
		};
	});
	await sleep(200);
	await applyTheme("dazzle");
	await page.waitForFunction((id) => document.querySelector(".mermaid-block svg")?.id !== id, beforeThemeSwitch.id);
	const afterThemeSwitch = await page.evaluate(() => {
		clearInterval(window.__mermaidPresenceTimer);
		const block = document.querySelector(".mermaid-block");
		const svg = block?.querySelector("svg");
		const shape = svg?.querySelector(".node rect, .node polygon, .node path");
		const label = svg?.querySelector(".nodeLabel, text");
		const list = document.querySelector(".messages");
		const probe = document.createElement("span");
		probe.style.color = "var(--accent)";
		document.body.appendChild(probe);
		const expectedStroke = getComputedStyle(probe).color;
		probe.remove();
		return {
			id: svg?.id,
			stroke: shape ? getComputedStyle(shape).stroke : null,
			expectedStroke,
			fontSize: label ? getComputedStyle(label).fontSize : null,
			diagramFontSize: getComputedStyle(document.documentElement).getPropertyValue("--mermaid-font-size").trim(),
			dark: block?.getAttribute("data-mermaid-dark"),
			scrollTop: list?.scrollTop ?? null,
			missingDuringRender: window.__mermaidMissingDuringThemeRender,
		};
	});
	console.log("  [dark theme switch]", JSON.stringify({ beforeThemeSwitch, afterThemeSwitch }));
	check(
		"同为深色的主题切换会重新渲染 SVG 并应用新配色",
		beforeThemeSwitch.id !== afterThemeSwitch.id &&
			beforeThemeSwitch.stroke !== afterThemeSwitch.stroke &&
			afterThemeSwitch.stroke === afterThemeSwitch.expectedStroke &&
			afterThemeSwitch.dark === "true",
	);
	check("主题重渲染期间旧 SVG 保持挂载", !afterThemeSwitch.missingDuringRender);
	check("Mermaid 标签字号为 12px", afterThemeSwitch.fontSize === afterThemeSwitch.diagramFontSize);
	check(
		"主题重渲染保持消息列表阅读位置",
		beforeThemeSwitch.scrollTop > 0 && beforeThemeSwitch.scrollTop === afterThemeSwitch.scrollTop,
	);

	await applyTheme("white");
	await page.waitForFunction((id) => document.querySelector(".mermaid-block svg")?.id !== id, afterThemeSwitch.id);
	const lightTheme = await page.evaluate(() => {
		const block = document.querySelector(".mermaid-block");
		const svg = block?.querySelector("svg");
		const shape = svg?.querySelector(".node rect, .node polygon, .node path");
		const probe = document.createElement("span");
		probe.style.color = "var(--accent)";
		document.body.appendChild(probe);
		const expectedStroke = getComputedStyle(probe).color;
		probe.remove();
		return {
			id: svg?.id,
			stroke: shape ? getComputedStyle(shape).stroke : null,
			expectedStroke,
			dark: block?.getAttribute("data-mermaid-dark") ?? null,
			scrollTop: document.querySelector(".messages")?.scrollTop ?? null,
		};
	});
	console.log("  [light theme switch]", JSON.stringify(lightTheme));
	check(
		"深色切换到浅色会重新渲染 SVG 并应用浅色配色",
		lightTheme.id !== afterThemeSwitch.id &&
			lightTheme.stroke === lightTheme.expectedStroke &&
			lightTheme.dark === null &&
			lightTheme.scrollTop === afterThemeSwitch.scrollTop,
	);

	const recovery = await page.evaluate(async () => {
		const mod = await import("/plugins/mermaid/client/entry.mjs?e=1");
		const render = mod.default.renderers.mermaid;
		let rejected = false;
		try {
			await render("flowchart LR\n  A[[[ broken");
		} catch {
			rejected = true;
		}
		const el = await render("flowchart LR\n  A[Fixed] --> B[Done]");
		return {
			rejected,
			recovered: !!el?.querySelector("svg"),
			orphans: document.querySelectorAll("body > [data-mermaid-render]").length,
		};
	});
	console.log("  [invalid -> valid recovery]", JSON.stringify(recovery));
	check("非法源码修正后同一插件实例可恢复渲染", recovery.rejected && recovery.recovered);
	check("失败与成功渲染均清理临时 DOM", recovery.orphans === 0);

	const manual = await page.evaluate(async () => {
		try {
			const mod = await import("/plugins/mermaid/client/entry.mjs?e=1");
			const el = await mod.default.renderers.mermaid("flowchart LR\n  A --> B");
			return { ok: !!el, hasSvg: !!(el && el.querySelector("svg")), err: null };
		} catch (e) {
			return { ok: false, hasSvg: false, err: String(e).slice(0, 200) };
		}
	});
	console.log("  [manual renderer]", JSON.stringify(manual));
	check("手动调用 renderer 能产出 SVG", manual.ok && manual.hasSvg);

	const typography = await page.evaluate(async () => {
		const mod = await import("/plugins/mermaid/client/entry.mjs?e=1");
		const render = mod.default.renderers.mermaid;
		const cases = [
			["sequence", "sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Done", "text"],
			["er", "erDiagram\n CUSTOMER ||--o{ ORDER : places", ".nodeLabel, .edgeLabel"],
			[
				"gantt",
				"gantt\n title Project\n dateFormat YYYY-MM-DD\n section Work\n Task :2026-01-01, 2d",
				".titleText, .sectionTitle, .taskText",
			],
		];
		const diagramFontSize = getComputedStyle(document.documentElement).getPropertyValue("--mermaid-font-size").trim();
		const samples = [];
		for (const [name, code, selector] of cases) {
			const el = await render(code);
			document.body.appendChild(el);
			for (const node of el.querySelectorAll(selector)) {
				if (node.textContent?.trim()) {
					samples.push({ name, text: node.textContent.trim().slice(0, 30), size: getComputedStyle(node).fontSize });
				}
			}
			el.remove();
		}
		return { diagramFontSize, samples };
	});
	console.log("  [diagram typography]", JSON.stringify(typography));
	check(
		"各 Mermaid 图型的主要标签字号均为 12px",
		typography.samples.length > 0 && typography.samples.every((sample) => sample.size === typography.diagramFontSize),
	);

	const racePage = await browser.newPage();
	await racePage.route("**/plugins/mermaid/client/entry.mjs?*", async (route) => {
		const response = await route.fetch();
		const source = await response.text();
		const needle = "\t\tmermaid: renderMermaid,";
		if (!source.includes(needle)) throw new Error("Mermaid renderer export hook not found");
		const delayed = source.replace(
			needle,
			`\t\tmermaid: async (...args) => {
		\tconst el = await renderMermaid(...args);
		\twindow.__delayedMermaidInitial = {
		\t\tid: el.querySelector("svg")?.id,
		\t\tdark: el.getAttribute("data-mermaid-dark")
		\t};
		\tawait new Promise((resolve) => { window.__releaseMermaidRenderer = resolve; });
		\treturn el;
		},`,
		);
		await route.fulfill({ response, body: delayed });
	});
	await racePage.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await racePage.waitForFunction(() => window.__delayedMermaidInitial, { timeout: 30_000 });
	await racePage.evaluate(async () => {
		const link = document.createElement("link");
		link.id = "theme-stylesheet";
		link.rel = "stylesheet";
		await new Promise((resolve, reject) => {
			link.onload = resolve;
			link.onerror = reject;
			link.href = `/themes/white.css?initial-race=${Date.now()}`;
			document.head.appendChild(link);
		});
		window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		window.__releaseMermaidRenderer();
	});
	await racePage.waitForFunction(
		() => {
			const initial = window.__delayedMermaidInitial;
			const block = document.querySelector(".mermaid-block");
			const svg = block?.querySelector("svg");
			return svg?.id && svg.id !== initial.id && !block.hasAttribute("data-mermaid-dark");
		},
		{ timeout: 30_000 },
	);
	const initialThemeRace = await racePage.evaluate(() => {
		const block = document.querySelector(".mermaid-block");
		const svg = block?.querySelector("svg");
		const shape = svg?.querySelector(".node rect, .node polygon, .node path");
		const probe = document.createElement("span");
		probe.style.color = "var(--accent)";
		document.body.appendChild(probe);
		const expectedStroke = getComputedStyle(probe).color;
		probe.remove();
		return {
			initial: window.__delayedMermaidInitial,
			id: svg?.id,
			dark: block?.getAttribute("data-mermaid-dark") ?? null,
			stroke: shape ? getComputedStyle(shape).stroke : null,
			expectedStroke,
		};
	});
	console.log("  [initial render theme race]", JSON.stringify(initialThemeRace));
	check(
		"首次渲染期间的主题变化会在元素挂载后补同步",
		initialThemeRace.initial.dark === "true" &&
			initialThemeRace.id !== initialThemeRace.initial.id &&
			initialThemeRace.dark === null &&
			initialThemeRace.stroke === initialThemeRace.expectedStroke,
	);
	await racePage.close();

	await browser.close();
	console.log(passed >= 3 ? "\nFENCE RENDER E2E PASSED" : "\nFENCE RENDER E2E FAILED");
}

main()
	.catch((err) => {
		console.error("✗", err);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {}
	});
