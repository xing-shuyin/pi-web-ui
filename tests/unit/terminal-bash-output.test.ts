import { describe, expect, it } from "vitest";
import {
	buildTerminalBashLine,
	cleanBashOutput,
	detectTrailingLimiter,
	makeTerminalBashTool,
	newSentinelNonce,
	sentinelUnsafeReason,
	type TerminalManager,
} from "../../server/terminals.js";

const NONCE = "0123456789ab";

const sentinelEcho = (nonce: string): string =>
	"__pi_rc=${PIPESTATUS:-$?}; printf '" + String.raw`\n[pi-exit-${nonce}:%s]\n` + `' "$__pi_rc"`;

const sentinelExit = (nonce: string, code = 0): string => `\r\n[pi-exit-${nonce}:${code}]\r\n`;

const toCRLF = (s: string): string => s.replace(/\n/g, "\r\n");

function fakePty(realOutput: string, timing: "linux" | "conpty"): TerminalManager {
	let buf = "";
	return {
		create: () => "ai-bash-1",
		suspendIdleWatch: () => {},
		endCursor: () => 0,
		setSentinelPending: () => {},
		watchOutput: () => () => {},
		read: (_id: string, cursor: number) => {
			if (cursor >= buf.length) return null;
			return { data: buf.slice(cursor), cursor: buf.length };
		},
		inputChecked: (_id: string, data: string): string | null => {
			if (data === "exit\r" || data === "\x03") return null;
			const body = data.replace(/\r$/, "");
			const nonce = /\[pi-exit-([0-9a-f]{12}):%s\]/.exec(body)?.[1];
			if (!nonce) return "fake pty: no sentinel in input";
			const cmdFirstLine = body.split("\n")[0] ?? "";
			const sentLine = body.split("\n").pop() ?? "";
			const prompt = "c@HOST MINGW64 /tmp/x\r\n$ ";
			if (timing === "linux") {
				buf += toCRLF(body) + "\r\n" + toCRLF(realOutput) + "\r" + sentLine + "\r\n" + sentinelExit(nonce);
			} else {
				buf += prompt + cmdFirstLine + "\r\n" + toCRLF(realOutput) + prompt + sentLine + "\r\n" + sentinelExit(nonce);
			}
			return null;
		},
	} as unknown as TerminalManager;
}

async function run(
	command: string,
	realOutput: string,
	timing: "linux" | "conpty",
): Promise<{ output: string; exitCode: number }> {
	const tool = makeTerminalBashTool(fakePty(realOutput, timing), {
		cwd: process.cwd(),
		defaultPersist: () => false,
		idleMs: () => 0,
		kills: new Set(),
		notifyBackgroundDone: () => {},
	});
	const res = await tool.execute("t1", { command }, undefined, undefined, undefined as never);
	const details = res.details as { output: string; exitCode: number };
	return { output: details.output, exitCode: details.exitCode };
}

describe("cleanBashOutput：与时序无关的清洗（#572 ①、Windows ConPTY 实测）", () => {
	it("Linux 时序：命令回显 / 哨兵回显 / 真实输出 / 哨兵重绘：正文完整保留", () => {
		const raw =
			"echo hello; whoami\r\n" +
			sentinelEcho(NONCE) +
			"\r\nhello\r\nuser\r\n" +
			"\r" +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "echo hello; whoami")).toBe("hello\nuser");
	});

	it("ConPTY 时序：哨兵回显在真实输出之后，正文完整保留（旧实现在此返回空串）", () => {
		const raw =
			"c@HOST MINGW64 /tmp/x\r\n$ echo hello-dbg\r\nhello-dbg       \r\n" +
			"c@HOST MINGW64 /tmp/x\r\n$ " +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "echo hello-dbg")).toBe("hello-dbg");
	});

	it("ConPTY 时序：行尾填充空格被去掉，多行输出顺序不变", () => {
		const raw =
			"c@HOST MINGW64 /tmp/x\r\n$ ls\r\na.txt       \r\nb.txt       \r\n" +
			"c@HOST MINGW64 /tmp/x\r\n$ " +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "ls")).toBe("a.txt\nb.txt");
	});
});

describe("cleanBashOutput / 退出码：nonce 隔离真实输出里的哨兵字面量（#572 ②）", () => {
	it("真实输出含 [pi-exit:%s] 与 [pi-exit:42]：不被清掉、不被当成真哨兵", () => {
		const raw =
			"grep out\r\n" + sentinelEcho(NONCE) + "\r\nhello\r\n[pi-exit:42]\r\n[pi-exit:%s]\r\n" + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "grep out")).toBe("hello\n[pi-exit:42]\n[pi-exit:%s]");
	});
});

describe("终端接管 bash 工具端到端（假 PTY，两种时序）", () => {
	it.each(["linux", "conpty"] as const)("%s：正常命令正文非空、退出码真实", async (timing) => {
		const r = await run("echo hello-dbg", "hello-dbg       \n", timing);
		expect(r.output).toBe("hello-dbg");
		expect(r.exitCode).toBe(0);
	});

	it.each(["linux", "conpty"] as const)("%s：多行输出完整返回", async (timing) => {
		const r = await run("ls", "a.txt\nb.txt\nc.txt\n", timing);
		expect(r.output).toBe("a.txt\nb.txt\nc.txt");
	});

	it.each(["linux", "conpty"] as const)(
		"%s：输出含 [pi-exit:42]：退出码仍是真实的 0，后续输出不被截断",
		async (timing) => {
			const r = await run("grep -n x file", "before\n[pi-exit:42]\nafter\n", timing);
			expect(r.exitCode).toBe(0);
			expect(r.output).toBe("before\n[pi-exit:42]\nafter");
		},
	);

	it.each(["linux", "conpty"] as const)("%s：输出含 printf 格式串 [pi-exit:%%s]：不吞行", async (timing) => {
		const r = await run("grep -n 'pi-exit:%s' server/terminals.ts", "A\n[pi-exit:%s]\nB\n", timing);
		expect(r.exitCode).toBe(0);
		expect(r.output).toBe("A\n[pi-exit:%s]\nB");
	});

	it("nonce 每次调用不同（同一输出不会跨调用串号）", () => {
		expect(newSentinelNonce()).not.toBe(newSentinelNonce());
		expect(newSentinelNonce()).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe("语法不完整：直接拒绝，不注入、不建终端（#571）", () => {
	function spyPty() {
		const created: string[] = [];
		const sent: string[] = [];
		const mgr = {
			create: (id: string) => {
				created.push(id);
				return { id };
			},
			suspendIdleWatch: () => {},
			endCursor: () => 0,
			setSentinelPending: () => {},
			watchOutput: () => () => {},
			read: () => null,
			inputChecked: (_id: string, data: string) => {
				sent.push(data);
				return null;
			},
		} as unknown as TerminalManager;
		return { mgr, created, sent };
	}

	it.each([
		["续行符结尾", "echo hi \\"],
		["未闭合引号", 'echo "unclosed'],
		["未闭合花括号组", "cd /tmp && { echo HELLO; date"],
	])("%s：报「语法不完整、未执行」，既不建终端也不写入", async (_label, command) => {
		const { mgr, created, sent } = spyPty();
		const tool = makeTerminalBashTool(mgr, {
			cwd: process.cwd(),
			defaultPersist: () => false,
			idleMs: () => 0,
			kills: new Set(),
			notifyBackgroundDone: () => {},
		});
		await expect(tool.execute("t1", { command }, undefined, undefined, undefined as never)).rejects.toThrow(
			/语法不完整|syntactically incomplete/,
		);
		expect(created).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("sentinelUnsafeReason：# 注释里的撇号 / 引号不算未闭合", () => {
		expect(sentinelUnsafeReason("echo hi # don't")).toBeNull();
		expect(sentinelUnsafeReason('echo "a" # say "hi')).toBeNull();
		expect(sentinelUnsafeReason("echo $# ${#arr[@]}")).toBeNull();
		expect(sentinelUnsafeReason("echo hi \\")).toBe("trailing_backslash");
	});

	it("detectTrailingLimiter：注释里的 | tail 不被当成管道拆掉", () => {
		expect(detectTrailingLimiter("echo a # x | tail -3")).toBeNull();
	});
});

describe("cleanBashOutput：真实 ConPTY wrapped eval 回显", () => {
	it("read-with-answer：清除跨行 printf 尾部，保留输入回显和 ANSWER 正文", () => {
		const nonce = "1794550003c0";
		const command = 'read -r AUDIT_ANSWER; printf "ANSWER=%s\\n" "$AUDIT_ANSWER"';
		const raw =
			"\x1b[?2004h\x1b[32m\r\nc@DESKTOP-S1QKEI6 \x1b[35mMINGW64 \x1b[33m/tmp/pi-terminal-audit-WsJzKx\x1b[m\r\n" +
			'$ \x1b[53X\x1b[?2004l\r$ eval $\'read -r AUDIT_ANSWER; printf "ANSWER=%s\\\\n" "$AUDIT_ANSWER"\'; __pi_rc=$?; printf \'\\n[pi-exit-1794550003c0:%s]\\n\r\n' +
			'\' "$__pi_rc"\x1b[K\r\nU\rUSER_ANSWER\x1b[13X\r\nANSWER=USER_ANSWER      \r\n\x1b[24X\r\n[pi-exit-1794550003c0:0]\r\n\x1b[?2004h';
		expect(cleanBashOutput(raw, nonce, command)).toBe("UUSER_ANSWER\nANSWER=USER_ANSWER");
	});

	it("interactive partial：回显折在最终变量中且尚无完成哨兵", () => {
		const command = 'read -r AUDIT_INPUT; printf "INPUT=%s\\n" "$AUDIT_INPUT"';
		const raw =
			"c@DESKTOP-S1QKEI6 MINGW64 /tmp/pi-terminal-audit-GHqntY\r\n" +
			'$ \x1b[53X\x1b[?2004l\r$ eval $\'read -r AUDIT_INPUT; printf "INPUT=%s\\\\n" "$AUDIT_INPUT"\'; __pi_rc=$?; printf \'\\n[pi-exit-e80a841bc3e1:%s]\\n\' "\r\n' +
			'$__pi_rc"\x1b[K\r\n';
		expect(cleanBashOutput(raw, "e80a841bc3e1", command)).toBe("");
	});

	it("每个字符位置的折行（含 nonce 内部）都按完整注入文本匹配", () => {
		const command = 'printf "hello\\n" # comment';
		const injected = buildTerminalBashLine(command, undefined, NONCE);
		for (let split = 1; split < injected.length; split++) {
			const raw = `$ ${injected.slice(0, split)}\r\n${injected.slice(split)}\r\nhello\r\n` + sentinelExit(NONCE);
			if (split < "eval $'".length) continue;
			expect(cleanBashOutput(raw, NONCE, command), `split ${split}`).toBe("hello");
		}
	});

	it("带 tailFile 的实际注入行支持多次折行和屏幕行尾填充", () => {
		const command = "make > build.log 2>&1";
		const injected = buildTerminalBashLine(command, { file: "build.log", lines: 20 }, NONCE);
		const chunks = injected.match(/.{1,40}/g)!;
		const raw = `$ ${chunks.join("\r\n")}\x1b[8X\r\nbuild failed\r\n` + sentinelExit(NONCE, 2);
		expect(cleanBashOutput(raw, NONCE, command, injected)).toBe("build failed");
	});

	it("真实正文里的控制尾部字面量保留，即使紧接完整回显", () => {
		const command = "echo payload";
		const body = "' \"$__pi_rc\"\n$__pi_rc\"\neval $'user text'\n[pi-term-exit:7] is literal text";
		const raw = `$ ${buildTerminalBashLine(command, undefined, NONCE)}\r\n${toCRLF(body)}\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, command)).toBe(body);
	});

	it("与注入尾部不逐字衔接的下一行保守保留", () => {
		const command = "echo payload";
		const injected = buildTerminalBashLine(command, undefined, NONCE);
		const split = injected.indexOf(' "$__pi_rc"');
		const raw = `$ ${injected.slice(0, split)}\r\nUSER OUTPUT "$__pi_rc"\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, command)).toBe('USER OUTPUT "$__pi_rc"');
	});

	it("shell-exit：去除独立机器退出标记，保留 shell 输出", () => {
		const command = "exit 7";
		const raw = `$ ${buildTerminalBashLine(command, undefined, NONCE)}\r\nexit\r\n\r\n[pi-term-exit:7]\r\n`;
		expect(cleanBashOutput(raw, NONCE, command)).toBe("exit");
	});
});

describe("cleanBashOutput：回显折行续行剥离与锚点失配回落（0.103 审计）", () => {
	it("长命令折行回显：与命令逐字衔接的续行一并剥掉", () => {
		const cmd = "echo " + "x".repeat(150);
		const raw = `c@HOST MINGW64 /tmp$ ${cmd.slice(0, 104)}\r\n${cmd.slice(104)}\r\nOK\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, cmd)).toBe("OK");
	});

	it("折行后续行与命令不衔接（真实输出）时保守保留", () => {
		const cmd = "echo " + "x".repeat(150);
		const raw =
			`c@HOST MINGW64 /tmp$ ${cmd.slice(0, 104)}\r\n${cmd.slice(104)}GARBAGE\r\nREAL-OUT\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, cmd)).toBe(`${cmd.slice(104)}GARBAGE\nREAL-OUT`);
	});

	it("锚点失配（回显缺失）：首行呈提示符形状时按回落剥掉", () => {
		const raw = `c@HOST MINGW64 /tmp$ ssh host 'long remote command'\r\nREMOTE-OUT\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "totally-different-typed-text")).toBe("REMOTE-OUT");
	});

	it("RHEL 风格提示符 [user@host dir]$ 也识别", () => {
		const raw = `[admin@web-01 /var/www]$ deploy.sh\r\nDEPLOYED\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "totally-different-typed-text")).toBe("DEPLOYED");
	});

	it("输出首行不是提示符形状时不误删", () => {
		const raw = `user@example.com\r\nBODY\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "other-cmd")).toBe("user@example.com\nBODY");
	});
});
