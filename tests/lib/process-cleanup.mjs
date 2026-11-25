/**
 * 测试进程卫生（单一实现，`run-smoke` 与手工清理脚本共用）。
 *
 * 为什么需要它：冒烟用例各自 `spawn(node, dist/server/index.js)` 再 `server.kill()`。这有三处漏：
 *
 * 1. **只杀直接子进程**：server 自己再 spawn 的子进程（PTY / hub / 插件子进程）留在进程表里；
 * 2. **runner 被中断**：Ctrl-C / 上一条命令超时被 kill / 终端关掉 —— 测试进程成孤儿，它的 server 继续占端口；
 * 3. **大多数用例根本不调 `freePort`**：下一次同端口跑就撞上「上轮残留的旧构建」，
 *    `waitForPort` 认为服务已就绪，于是拿旧产物跑出假绿/假红（本仓库踩过：改了 dist 却一直连到旧 server）。
 *
 * 这里只做三件确定性的事：杀进程**树**、查/清端口占用、按命令行特征扫残留。
 * 不做「按端口段盲杀」——那会顺手杀掉同事正在跑的另一份测试或 `npm run dev`。
 */
import { execFileSync } from "node:child_process";

/** 残留判定：匹配的是**进程命令行**，不是端口。 */
const TEST_PROCESS_PATTERNS = [
	// 用例脚本本体
	/[\\/]tests[\\/][\w.-]+-test\.mjs\b/,
	// 冒烟 runner 本体
	/[\\/]tests[\\/]run-smoke\.mjs\b/,
];

/** 用例 spawn 的服务端：只认**仓库里**的产物（`node_modules/pi-web-ui/...` 是装好的正式服务，别杀）。 */
const REPO_SERVER_PATTERN = /[\\/]dist[\\/]server[\\/]index\.js\b/;

/** 当前进程表里带命令行的 node 进程（Windows 用 CIM，其余用 ps）。 */
export function listNodeProcesses() {
	try {
		if (process.platform === "win32") {
			const out = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { $_.ProcessId.ToString() + "`t" + $_.ParentProcessId.ToString() + "`t" + ($_.CommandLine -replace "`r?`n", \' \') }',
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
			return parseRows(out);
		}
		const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
		const rows = [];
		for (const line of out.split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (m) rows.push({ pid: Number(m[1]), parentPid: Number(m[2]), commandLine: m[3] ?? "" });
		}
		return rows;
	} catch {
		return [];
	}
}

function parseRows(out) {
	const rows = [];
	for (const line of out.split("\n")) {
		const [pidRaw, ppidRaw, ...rest] = line.trim().split("\t");
		const pid = Number(pidRaw);
		const parentPid = Number(ppidRaw);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		rows.push({ pid, parentPid: Number.isInteger(parentPid) ? parentPid : 0, commandLine: rest.join("\t") });
	}
	return rows;
}

/** 某个 TCP 端口当前的监听者 PID（拿不到就返回空数组，绝不抛）。 */
export function portHolders(port) {
	try {
		if (process.platform === "win32") {
			const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const pids = new Set();
			const needle = `:${port}`;
			for (const line of out.split("\n")) {
				if (!line.includes("LISTENING")) continue;
				const cols = line.trim().split(/\s+/);
				if (cols.length < 5) continue;
				// 本地地址形如 127.0.0.1:8918 / [::]:8918
				if (!cols[1].endsWith(needle)) continue;
				const pid = Number(cols[cols.length - 1]);
				if (Number.isInteger(pid) && pid > 0) pids.add(pid);
			}
			return [...pids];
		}
		const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.map((x) => Number(x.trim()))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch {
		return [];
	}
}

/** 杀整个进程树（Windows 没有进程组：`taskkill /T` 才是「连子进程一起」）。 */
export function killTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
			return true;
		}
		try {
			process.kill(-pid, "SIGKILL");
			return true;
		} catch {
			process.kill(pid, "SIGKILL");
			return true;
		}
	} catch {
		return false;
	}
}

/** 这行命令行像不像「测试残留」（见文件头三条特征）。 */
export function looksLikeTestProcess(commandLine) {
	if (!commandLine) return false;
	// 全局安装的 pi-web-ui 服务（长期常驻的正式进程）长得一模一样：`node_modules` 里的一律不算残留。
	if (REPO_SERVER_PATTERN.test(commandLine) && !/[\\/]node_modules[\\/]/.test(commandLine)) return true;
	return TEST_PROCESS_PATTERNS.some((re) => re.test(commandLine));
}

/**
 * 跑一个用例**之前**把它的端口收干净。
 *
 * 只杀「命令行像测试残留」的占用者：占着端口但不是测试进程的（`npm run dev`、别的服务）一律不动，
 * 交给调用方决定（`run-smoke` 会直接报错退出，而不是拿旧 server 出假绿）。
 */
export function freeTestPort(port) {
	const holders = portHolders(port).filter((pid) => pid !== process.pid);
	if (holders.length === 0) return { wasBusy: false, killed: [], foreign: [] };
	const rows = new Map(listNodeProcesses().map((row) => [row.pid, row]));
	const killed = [];
	const foreign = [];
	for (const pid of holders) {
		const row = rows.get(pid);
		// 拿不到命令行（权限 / 已退出）= 当作残留：端口被占这件事本身已经足够让它不可信。
		if (row && !looksLikeTestProcess(row.commandLine)) {
			foreign.push(pid);
			continue;
		}
		if (killTree(pid)) killed.push(pid);
	}
	return { wasBusy: true, killed, foreign };
}

/** 扫一遍进程表：所有像测试残留、且**不是**本进程的 node 进程。 */
export function findTestResidue() {
	return listNodeProcesses()
		.filter((row) => row.pid !== process.pid && looksLikeTestProcess(row.commandLine))
		.map((row) => ({ pid: row.pid, commandLine: row.commandLine }));
}

/** 清掉（父进程在表里时先杀子：父退出会重排 PID 复用窗口）。 */
export function sweepTestResidue({ dryRun = false } = {}) {
	const found = findTestResidue();
	if (dryRun) return { found, killed: [] };
	const killed = [];
	for (const item of found) if (killTree(item.pid)) killed.push(item.pid);
	return { found, killed };
}
