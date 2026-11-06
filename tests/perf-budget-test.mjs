import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { freePort, portUp } from "./lib/port-utils.mjs";

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设置 PI_WEB_CHROME 可指定路径）");
	process.exit(0);
}

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-perf-budget-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 28000 + Math.floor(Math.random() * 8000);

try {
	ensureBuild(REPO, "perf-budget-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

await freePort(PORT);
mkdirSync(WORK, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

function seedSession(id, messageCount) {
	const sessionsDir = join(AGENT_DIR, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const file = join(sessionsDir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd: WORK })];

	for (let i = 1; i <= messageCount; i++) {
		const isUser = i % 2 === 1;
		const content = isUser
			? [{ type: "text", text: `这是用户第 ${i} 次提出的代码重构与性能优化需求指令。` }]
			: [
					{
						type: "text",
						text: `这是助手第 ${i} 轮回复，包含分析报告与实现代码：\n\`\`\`ts\nexport function calculateMetrics_${i}(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n\`\`\`\n请仔细查阅上述实现。`,
					},
					{
						type: "toolCall",
						id: `call_${i}`,
						name: "read",
						argumentsText: JSON.stringify({ path: `src/utils/module_${i}.ts` }),
					},
				];

		lines.push(
			JSON.stringify({
				type: "message",
				id: `m_${i}`,
				parentId: i > 1 ? `m_${i - 1}` : null,
				timestamp: `2026-08-04T00:00:${String(i).padStart(2, "0")}.000Z`,
				message: {
					role: isUser ? "user" : "assistant",
					content,
					timestamp: 1722700800000 + i * 1000,
				},
			}),
		);
	}
	writeFileSync(file, lines.join("\n") + "\n");
}

seedSession("short-session", 2);
seedSession("large-session-perf", 35);

writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "sk-mock",
					models: [{ id: "mock-model", name: "Mock Model" }],
				},
			},
		},
		null,
		2,
	),
);

let server = null;
let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) {
		failures++;
		process.exitCode = 1;
	}
}

try {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: WORK,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_DIR: AGENT_DIR,
			PI_WEB_CWD: WORK,
			PI_WEB_PLUGIN_CATALOG_URL: "",
		},
		stdio: "ignore",
	});

	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".session-item", { timeout: 15000 });

	await page.evaluate(() => {
		window.__longTasks = [];
		const obs = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				window.__longTasks.push({ duration: e.duration, name: e.name, startTime: e.startTime });
			}
		});
		obs.observe({ entryTypes: ["longtask"] });
	});

	const sessionItems = await page.$$(".session-item");
	check("成功加载并渲染历史会话列表", sessionItems.length >= 2, `找到 ${sessionItems.length} 个会话`);

	let targetButton = null;
	for (const item of sessionItems) {
		const text = await item.textContent();
		if (text && text.includes("35 条消息")) {
			targetButton = item;
			break;
		}
	}
	check("定位到 35 条消息的大容量基准会话", !!targetButton);

	if (targetButton) {
		await page.evaluate(() => (window.__longTasks = []));

		const t0 = performance.now();
		await targetButton.click();
		await sleep(1000);
		const t1 = performance.now();

		const longTasks = await page.evaluate(() => window.__longTasks);
		const maxLongTask = longTasks.length > 0 ? Math.round(Math.max(...longTasks.map((t) => t.duration))) : 0;
		const totalFreeze = Math.round(longTasks.reduce((acc, cur) => acc + cur.duration, 0));

		check(
			"性能门禁：切换大容量会话单次最大卡顿 ≤ 150ms",
			maxLongTask <= 150,
			`实测最大卡顿: ${maxLongTask}ms (上限: 150ms)`,
		);
		check(
			"性能门禁：切换大容量会话总卡死阻塞 ≤ 200ms",
			totalFreeze <= 200,
			`实测总阻塞: ${totalFreeze}ms (上限: 200ms, LongTasks: ${longTasks.length}个)`,
		);
	}

	const textarea = await page.locator("textarea").first();
	await textarea.focus();
	await page.evaluate(() => (window.__longTasks = []));

	const testKeys = "性能预算门禁连续快速输入测试12345";
	for (let i = 0; i < testKeys.length; i++) {
		await page.keyboard.type(testKeys[i], { delay: 10 });
	}

	const typingLongTasks = await page.evaluate(() => window.__longTasks);
	check(
		"性能门禁：输入框高频打字无 Long Task 阻塞（0次）",
		typingLongTasks.length === 0,
		`打字期间 LongTasks 次数: ${typingLongTasks.length}`,
	);

	await browser.close();
} catch (err) {
	console.error("测试执行异常:", err);
	failures++;
	process.exitCode = 1;
} finally {
	if (server) {
		try {
			server.kill("SIGKILL");
		} catch {}
	}
	try {
		await freePort(PORT);
		rmSync(base, { recursive: true, force: true });
	} catch {}
}

if (failures === 0) {
	console.log("\n✓ 性能预算门禁全项通过（Zero Regressions）！");
} else {
	console.log(`\n✗ 性能预算门禁未通过，发现 ${failures} 处指标超标或异常！`);
}
