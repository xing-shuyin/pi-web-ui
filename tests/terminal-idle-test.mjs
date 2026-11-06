import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_WEB_TERMINAL_IDLE_MS = "700";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager } = await import(pathToFileURL(join(REPO, "dist", "server", "terminals.js")).href);

const workdir = mkdtempSync(join(tmpdir(), "piweb-term-idle-"));
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

function makeManager(events) {
	const mgr = new TerminalManager(() => {}, workdir);
	mgr.onAgentIdle = (terminalId, idleMs, title) => {
		events.push({ terminalId, idleMs, title, at: Date.now() });
	};
	return mgr;
}

try {
	{
		const events = [];
		const mgr = makeManager(events);
		check("用户终端创建成功", mgr.create("user-term", workdir, 80, 24, workdir) !== null);
		await sleep(1200);
		check("用户终端静默 1.2s 不触发提醒", events.length === 0);
		mgr.killAll();
	}

	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("agent-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("agent-term");
		const t0 = Date.now();
		for (let i = 0; i < 40 && events.length === 0; i++) await sleep(50);
		check("agent 终端静默后触发提醒", events.length === 1);
		if (events.length === 1) {
			check("提醒来自正确终端", events[0].terminalId === "agent-term");
			check("idleMs ≥ 阈值", events[0].idleMs >= 650);
			check("idleMs 合理（<3s）", events[0].idleMs < 3000);
			check("触发时机 ≈ 阈值之后", events[0].at - t0 >= 650);
		}
		await sleep(1100);
		check("一次性：持续沉默不重复提醒", events.length === 1);
		mgr.noteAgentActivity("agent-term");
		for (let i = 0; i < 40 && events.length < 2; i++) await sleep(50);
		check("agent 再次触碰后重新武装并触发第二次", events.length === 2);
		mgr.killAll();
	}

	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("reset-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("reset-term");
		for (let i = 0; i < 3; i++) {
			await sleep(300);
			mgr.inputChecked("reset-term", "");
		}
		await sleep(500);
		check("活动不断重置倒计时 → 阈值时间内不触发", events.length === 0);
		await sleep(600);
		check("停止活动后仍会正常触发", events.length === 1);
		mgr.killAll();
	}

	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("exit-term", workdir, 80, 24, workdir);
		mgr.inputChecked("exit-term", "exit\r");
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			if (!mgr.list().find((t) => t.id === "exit-term")?.running) break;
		}
		mgr.noteAgentActivity("exit-term");
		await sleep(1100);
		check("终端退出后不触发静默提醒", events.length === 0);
		mgr.killAll();
	}

	console.log(`\n${passed} checks passed${process.exitCode ? "（有失败）" : ""}`);
} finally {
	try {
		rmSync(workdir, { recursive: true, force: true });
	} catch {}
}
process.exit(process.exitCode || 0);
