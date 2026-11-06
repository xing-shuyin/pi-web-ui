import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const {
	TerminalManager,
	makeTerminalBashTool,
	makePersistentTerminalTools,
	buildTerminalBashLine,
	stripAnsi,
	splitTopLevelPipes,
	detectTrailingLimiter,
	detectStdoutRedirect,
	queryTerminalOutput,
	terminalIdleNotifyLines,
} = await import(pathToFileURL(join(REPO, "dist", "server", "terminals.js")).href);
const { makeAdaptiveBashTool, makeKillableBashTool } = await import(
	pathToFileURL(join(REPO, "dist", "server", "agent-service.js")).href
);

const workdir = mkdtempSync(join(tmpdir(), "piweb-tbash-"));
mkdirSync(join(workdir, "subdir"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name} ${extra}`);
		process.exitCode = 1;
	}
};

{
	const line = buildTerminalBashLine("ls -la");
	check(
		"单行命令追加哨兵序列",
		line.startsWith("eval $'ls -la'") &&
			/\[pi-exit-[0-9a-f]{12}:%s\]/.test(line) &&
			line.includes("__pi_rc=$?") &&
			!line.includes("\n"),
	);
	const ml = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
	check("多行脚本包进 eval $'...'", ml.startsWith("eval $'") && ml.includes("\\n") && !ml.includes("\n"));
	check("多行脚本仍是一行物理输入", !ml.includes("\n"));
	const stripped = stripAnsi("\x1b[31m红\x1b[0m\x1b]0;title\x07文\r\nx\ry");
	check("stripAnsi 清理颜色/OSC/孤立CR", stripped === "红文\r\nxy");
}

{
	const sp = splitTopLevelPipes("echo a | grep b | wc -l");
	check("splitTopLevelPipes 顶层拆分", sp.length === 3 && sp.map((s) => s.trim()).join("|") === "echo a|grep b|wc -l");
	check(
		"splitTopLevelPipes 引号内不拆",
		splitTopLevelPipes("echo 'a|b' | grep c").length === 2 &&
			splitTopLevelPipes("echo 'a|b' | grep c")[0].trim() === "echo 'a|b'",
	);
	const lim = detectTrailingLimiter("some cmd | tail -n 5");
	check("detectTrailingLimiter 识别 tail -n", lim && lim.kind === "tail" && lim.lines === 5 && lim.base === "some cmd");
	check("detectTrailingLimiter 裸 tail 默认10", detectTrailingLimiter("cmd | tail").lines === 10);
	check("detectTrailingLimiter 不拆 grep", detectTrailingLimiter("cmd | grep x") === null);
	check("detectTrailingLimiter 不拆 tail -f", detectTrailingLimiter("cmd | tail -f log") === null);
	const catLim = detectTrailingLimiter("ls | cat");
	check("detectTrailingLimiter 识别 cat", catLim && catLim.kind === "cat" && catLim.lines === null);
	check(
		"detectStdoutRedirect 识别 >file",
		(() => {
			const r = detectStdoutRedirect("make > build.log 2>&1");
			return r && r.file === "build.log";
		})(),
	);
	check("detectStdoutRedirect 忽略 /dev/null", detectStdoutRedirect("cmd > /dev/null") === null);
	check("detectStdoutRedirect 忽略 2>N", detectStdoutRedirect("cmd 2>&1") === null);
	const qt = queryTerminalOutput("line1\nline2\nline3\n[pi-exit:0]", { tail: 2 });
	check("queryTerminalOutput tail 行号", qt.text === "2: line2\n3: line3" && qt.exitCode === null);
	const qs = queryTerminalOutput("alpha\nbeta\ngamma", { search: "beta", context: 1 });
	check("queryTerminalOutput search 定位", qs.matches && qs.matches[0].line === 2 && qs.text.includes("beta"));
	check("terminalIdleNotifyLines 默认10", terminalIdleNotifyLines() === 10);
}

const mgr = new TerminalManager(() => {}, workdir);
let bgDone = null;
let idleMsOverride = 0;
let maxForegroundMsOverride = 0;
const tool = makeTerminalBashTool(mgr, {
	cwd: workdir,
	defaultPersist: () => true,
	idleMs: () => idleMsOverride,
	maxForegroundMs: () => maxForegroundMsOverride,
	lang: () => "zh",
	kills: new Set(),
	notifyBackgroundDone: (info) => {
		bgDone = info;
	},
});

const persistentTools = makePersistentTerminalTools(mgr, workdir);
const waitTool = persistentTools.find((t) => t.name === "terminal");
check("terminal(action=wait) 已注册", waitTool !== undefined);

async function run(commandOrParams, timeout) {
	const params = typeof commandOrParams === "string" ? { command: commandOrParams } : { ...commandOrParams };
	if (timeout) params.timeout = timeout;
	let result, error;
	try {
		result = await tool.execute("t1", params, undefined);
	} catch (e) {
		error = e;
	}
	return { result, error };
}

try {
	{
		const t0 = Date.now();
		const { result, error } = await run("echo hello-tbash");
		check("echo 正常完成无错误", !error);
		const text = result?.content?.[0]?.text ?? "";
		check("输出包含命令结果", text.includes("hello-tbash"), JSON.stringify(text));
		check("退出码 0", /\[exit:0\]$/.test(text.trim()));
		check("不含哨兵原文与回显标记", !text.includes("__pi_rc") && !text.includes("pi-exit"));
		check("阻塞到命令真正结束", Date.now() - t0 >= 50);
	}
	{
		const { result } = await run("sh -c 'exit 3'");
		check("非零退出码透传", /\[exit:3\]/.test(result?.content?.[0]?.text ?? ""));
	}

	{
		const script = "for i in a b c\ndo\n echo item=$i\ndone";
		const { result } = await run(script);
		const text = result?.content?.[0]?.text ?? "";
		check(
			"多行脚本执行并收集全部输出",
			text.includes("item=a") && text.includes("item=b") && text.includes("item=c"),
			JSON.stringify(text),
		);
	}

	{
		const { result } = await run({ command: "seq 1 30", tail: 5 });
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check("tail:5 只保留末 5 行（26–30）", numLines === "26,27,28,29,30", JSON.stringify(text));
		const full = await run("seq 1 30");
		const fullLines = (full.result?.content?.[0]?.text ?? "").split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
		check("不带 tail 时完整返回 30 行", fullLines === 30);
	}

	{
		idleMsOverride = 500;
		bgDone = null;
		const t0 = Date.now();
		const { result } = await run("echo started-bg; sleep 1.5; echo finished-bg");
		const elapsed = Date.now() - t0;
		const text = result?.content?.[0]?.text ?? "";
		check("静默解阻：提前返回不阻塞", elapsed < 1400, `${elapsed}ms`);
		check("返回「仍在运行」说明", text.includes("仍在持久终端 ai-bash 中运行"));
		check("返回已有部分输出", text.includes("started-bg"));
		check("details 标记 running", result?.details?.running === true);
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("完成后主动回调通知", bgDone !== null);
		if (bgDone) {
			check("通知带正确退出码", bgDone.exitCode === 0);
			check("通知带原命令", typeof bgDone.command === "string" && bgDone.command.includes("sleep"));
		}
		idleMsOverride = 0;
		await sleep(300);
	}

	{
		idleMsOverride = 500;
		mgr.kill("ai-bash");
		await run("echo w-start; sleep 2.5; echo w-end");
		const t0 = Date.now();
		let wr = null;
		try {
			wr = await waitTool.execute("tw", { action: "wait", terminalId: "ai-bash", maxWaitMs: 8000 });
		} catch (e) {
			wr = { error: e };
		}
		const parsed = JSON.parse(wr?.content?.[0]?.text ?? "{}");
		check("terminal(action=wait) 阻塞到命令真正结束", parsed.finished === true && Date.now() - t0 >= 1200);
		check("terminal(action=wait) 拿到退出码 0", parsed.exitCode === 0);
		check("terminal(action=wait) 附带等待期间的输出", (parsed.outputTail ?? "").includes("w-end"));
		const t2 = Date.now();
		const wr2 = JSON.parse(
			(await waitTool.execute("tw2", { action: "wait", terminalId: "ai-bash", cursor: 0, maxWaitMs: 3000 }))
				?.content?.[0]?.text ?? "{}",
		);
		check("存量哨兵预扫描立即返回", wr2.finished === true && Date.now() - t2 < 1500);
		await run("sleep 5");
		const t1 = Date.now();
		const wr3 = JSON.parse(
			(await waitTool.execute("tw3", { action: "wait", terminalId: "ai-bash", maxWaitMs: 800 }))?.content?.[0]?.text ??
				"{}",
		);
		check(
			"超时返回 finished:false 且耗时≈阈值",
			wr3.finished === false && Date.now() - t1 >= 700 && Date.now() - t1 < 2500,
		);
		idleMsOverride = 0;
		await sleep(5500);
	}

	{
		idleMsOverride = 0;
		mgr.kill("ai-bash");
		await run("echo idle-probe");
		const t3 = Date.now();
		const wr4 = JSON.parse(
			(await waitTool.execute("tw4", { action: "wait", terminalId: "ai-bash", maxWaitMs: 60000 }))?.content?.[0]
				?.text ?? "{}",
		);
		check(
			"空闲终端 terminal(action=wait) 秒回 applicable:false",
			wr4.applicable === false && Date.now() - t3 < 1500,
			JSON.stringify(wr4),
		);
	}

	{
		idleMsOverride = 0;
		maxForegroundMsOverride = 800;
		bgDone = null;
		mgr.kill("ai-bash");
		const t0 = Date.now();
		const { result } = await run("for i in 1 2 3 4 5 6 7 8; do echo tick-$i; sleep 0.3; done");
		const elapsed = Date.now() - t0;
		const text = result?.content?.[0]?.text ?? "";
		check("总时长解阻：流式输出下提前返回", elapsed < 2200, `${elapsed}ms`);
		check("返回总时长转后台说明", text.includes("前台执行已达") && text.includes("自动转入后台"));
		check("返回已有部分输出", text.includes("tick-1"));
		check(
			"details 标记 running 与 reason: elapsed",
			result?.details?.running === true && result?.details?.reason === "elapsed",
		);
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("总时长解阻后台命令完成回调", bgDone !== null);
		if (bgDone) {
			check("通知退出码为 0", bgDone.exitCode === 0);
		}
		maxForegroundMsOverride = 0;
		await sleep(300);
	}

	{
		idleMsOverride = 0;
		maxForegroundMsOverride = 800;
		bgDone = null;
		const t0 = Date.now();
		const { result } = await run({ command: "echo oneshot-start; sleep 2.0; echo oneshot-end", persist: false });
		const elapsed = Date.now() - t0;
		const text = result?.content?.[0]?.text ?? "";
		check("一次性终端总时长超限提前返回", elapsed < 1800, `${elapsed}ms`);
		check("一次性终端提示自动退出说明", text.includes("该终端将自动退出并发送通知"));
		check("details 记录 persist: false", result?.details?.persist === false);
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("一次性终端后台跑完收到通知", bgDone !== null);
		if (bgDone) {
			check("一次性终端退出码为 0", bgDone.exitCode === 0);
		}
		maxForegroundMsOverride = 0;
		await sleep(300);
	}

	{
		await run("cd subdir");
		const { result } = await run("pwd");
		check("cd 状态保留到下一次调用", (result?.content?.[0]?.text ?? "").includes("subdir"));
		await run(`cd "${workdir}"`);
	}

	{
		mgr.kill("ai-bash");
		const kills = new Set();
		const abortTool = makeTerminalBashTool(mgr, {
			cwd: workdir,
			defaultPersist: () => true,
			idleMs: () => 0,
			kills,
			notifyBackgroundDone: () => {},
		});
		const execPromise = abortTool.execute("t2", { command: "sleep 30" }, undefined);
		await sleep(700);
		for (const ac of [...kills]) ac.abort();
		const t0 = Date.now();
		let abortedErr = null;
		try {
			await execPromise;
		} catch (e) {
			abortedErr = e;
		}
		check("abort 后快速返回", abortedErr !== null && Date.now() - t0 < 2000);
		check("报 Command aborted", /aborted/i.test(abortedErr?.message ?? ""));
		check("取消后终端不再运行（下次创建新 shell）", !mgr.list().some((t) => t.id === "ai-bash" && t.running));
	}

	{
		const before = new Set(
			mgr
				.list()
				.filter((t) => !t.running)
				.map((t) => t.id),
		);
		const { result, error } = await run({ command: "seq 1 5", persist: false });
		check("一次性命令正常完成无错误", !error);
		const text = result?.content?.[0]?.text ?? "";
		check("一次性输出完整返回", /1\n2\n3\n4\n5/.test(text), JSON.stringify(text));
		check("一次性退出码 0", /\[exit:0\]$/.test(text.trim()));
		let oneShot;
		for (let i = 0; i < 20 && !oneShot; i++) {
			await sleep(200);
			oneShot = mgr.list().find((t) => t.id.startsWith("ai-bash-") && !t.running && !before.has(t.id));
		}
		check("一次性终端进程已结束并保留在列表", oneShot !== undefined);
		if (oneShot) {
			check("一次性终端标记 agentBash（单独归 AI bash 分组）", oneShot.agentBash === true);
			const retained = mgr.read(oneShot.id, 0, 100);
			check("一次性终端输出保留供查阅", (retained?.data ?? "").includes("5"));
		}
	}

	{
		const { result } = await run({ command: "seq 1 30", head: 5 });
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check("head:5 只保留前 5 行（1–5）", numLines === "1,2,3,4,5", JSON.stringify(text));
		const full = await run("seq 1 30");
		const fullLines = (full.result?.content?.[0]?.text ?? "").split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
		check("不带 head 时完整返回 30 行", fullLines === 30);
	}

	{
		const { result } = await run({ command: "seq 1 30", head: 20, tail: 3 });
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check("head:20 再 tail:3 → 末 3 行（18–20）", numLines === "18,19,20", JSON.stringify(text));
	}

	{
		const { result } = await run("seq 1 30 | tail -3");
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check("管道化解 只留末尾3行", numLines === "28,29,30", JSON.stringify(text));
		check("管道化解 带说明注记", text.includes("限输出") && text.includes("tail"), JSON.stringify(text.slice(0, 160)));
		check("管道化解 真实退出码", /\[exit:0\]$/.test(text.trim()));
	}

	{
		const kills = new Set();
		const killable = makeKillableBashTool(workdir, kills);
		const terminalBacked = makeTerminalBashTool(mgr, {
			cwd: workdir,
			defaultPersist: () => false,
			idleMs: () => 0,
			kills,
			notifyBackgroundDone: () => {},
		});
		let useT = false;
		const adaptive = makeAdaptiveBashTool(killable, terminalBacked, () => useT);

		const beforeNative = mgr.list().filter((t) => t.id.startsWith("ai-bash-")).length;
		const native = await adaptive.execute("a1", { command: "echo native-hi" }, undefined);
		const nativeText = native?.content?.[0]?.text ?? "";
		check("设置关走原生 bash：输出返回", nativeText.includes("native-hi"), JSON.stringify(nativeText));
		check("设置关不开终端", mgr.list().filter((t) => t.id.startsWith("ai-bash-")).length === beforeNative);

		const context = {
			cwd: workdir,
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "high",
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => join(workdir, "test-session.jsonl"),
			},
		};
		const envCommand =
			'bash -c \'printf "%s|%s|%s|%s|%s" "$PI_SESSION_ID" "${PI_SESSION_FILE-unset}" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"\'';
		const sessionEnv = await adaptive.execute(
			"env1",
			{ command: envCommand, timeout: 5 },
			undefined,
			undefined,
			context,
		);
		const envText = sessionEnv.content[0].text;
		check(
			"native subshell receives session metadata",
			envText === `test-session|${join(workdir, "test-session.jsonl")}|test-provider|test-model|high`,
			JSON.stringify(envText),
		);
		context.model = { provider: "next-provider", id: "next-model" };
		context.thinkingLevel = "off";
		context.sessionManager.getSessionId = () => "next-session";
		context.sessionManager.getSessionFile = () => undefined;
		const refreshedEnv = await adaptive.execute(
			"env2",
			{ command: envCommand, timeout: 5 },
			undefined,
			undefined,
			context,
		);
		check(
			"native subshell refreshes model, reasoning and session metadata",
			refreshedEnv.content[0].text === "next-session|unset|next-provider|next-model|off",
			JSON.stringify(refreshedEnv.content[0].text),
		);
		check("native bash releases abort controllers", kills.size === 0);

		useT = true;
		const isWin = process.platform === "win32";
		if (isWin) {
			const countBefore = mgr.list().filter((t) => t.id.startsWith("ai-bash-")).length;
			const termWin = await adaptive.execute("a2", { command: "echo terminal-hi" }, undefined);
			const termWinText = termWin?.content?.[0]?.text ?? "";
			check(
				"Windows设置开一次性命令走原生：输出返回",
				termWinText.includes("terminal-hi"),
				JSON.stringify(termWinText),
			);
			check(
				"Windows设置开一次性命令不开终端（防128控制台耗尽）",
				mgr.list().filter((t) => t.id.startsWith("ai-bash-")).length === countBefore,
			);

			const persistTerm = await adaptive.execute("a3", { command: "echo persist-hi", persist: true }, undefined);
			const persistText = persistTerm?.content?.[0]?.text ?? "";
			check("Windows设置开persist=true走持久终端", persistText.includes("persist-hi"), JSON.stringify(persistText));
			check(
				"Windows持久终端ai-bash已创建",
				mgr.list().some((t) => t.id === "ai-bash"),
			);
		} else {
			const term = await adaptive.execute("a2", { command: "echo terminal-hi" }, undefined);
			const termText = term?.content?.[0]?.text ?? "";
			check("设置开走终端：输出返回", termText.includes("terminal-hi"), JSON.stringify(termText));
			const oneShotAfter = mgr.list().some((t) => t.id.startsWith("ai-bash-") && !t.running);
			check("设置开创建了一次性终端并已结束", oneShotAfter);
		}
	}
} finally {
	mgr.killAll();
	await sleep(800);
	try {
		rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	} catch (e) {
		console.warn(`  ! 临时目录未能删除（仍被 shell 占用）：${workdir} (${e.code})`);
	}
}

console.log(`\n${passed} checks passed${process.exitCode ? "（有失败）" : ""}`);

process.exit(process.exitCode ?? 0);
