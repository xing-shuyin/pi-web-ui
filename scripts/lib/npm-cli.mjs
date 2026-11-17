// scripts/lib/npm-cli.mjs
// 发布链路（scripts/pack-npm.mjs · scripts/publish-npm.mjs）共用的 npm 调用原语。
// 单源理由：Windows 上 npm 是 npm.cmd，Node 22+ 不允许直接 spawn .cmd；走 npm 自己给的
// npm_execpath（npm-cli.js）用 node 拉起，既不需要 shell 也没有参数拼接的注入面。
// 直接用 node 跑脚本时没有 npm_execpath，退回 shell（此路径只接受纯数字 OTP 等安全参数）。
import { spawn } from "node:child_process";

export function npmCall(argv, { cwd } = {}) {
	const npmCli = process.env.npm_execpath;
	if (npmCli?.endsWith(".js")) return { command: process.execPath, argv: [npmCli, ...argv], shell: false, cwd };
	return { command: ["npm", ...argv].join(" "), shell: process.platform === "win32", cwd };
}

/** 发布一律针对「已归一化的 tarball 文件」：npm 会重新打包目录，权限位又丢了。 */
export function publishArgv(file, { otp = "", dryRun = false } = {}) {
	const argv = ["publish", file];
	if (dryRun) argv.push("--dry-run");
	if (otp) argv.push(`--otp=${otp}`);
	return argv;
}

function spawnChild({ command, argv, shell, cwd }, onData) {
	const child = shell
		? spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })
		: spawn(command, argv ?? [], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.on("data", (chunk) => onData(chunk.toString()));
	child.stderr?.on("data", (chunk) => onData(chunk.toString()));
	return child;
}

/** 跑一条命令，同时回显并收集输出（要按 registry 的响应内容分流，不能只继承 stdio）。 */
export function runCollect(call, { echo = true } = {}) {
	return new Promise((done) => {
		let out = "";
		const child = spawnChild(call, (text) => {
			out += text;
			if (echo) process.stdout.write(text);
		});
		child.on("error", (err) => done({ code: 1, out: out + String(err) }));
		child.on("exit", (code) => done({ code: code ?? 1, out }));
	});
}

export function capture(call) {
	return new Promise((done) => {
		let out = "";
		const child = spawnChild(call, (text) => (out += text));
		child.on("error", () => done(""));
		child.on("exit", () => done(out.trim()));
	});
}
