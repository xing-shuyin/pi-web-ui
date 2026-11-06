import { describe, expect, it } from "vitest";
import { buildTerminalBashLine, detectTrailingLimiter, sentinelUnsafeReason } from "../../server/terminals.js";

const SENTINEL_FMT = /\[pi-exit-[0-9a-f]{12}:%s\]/;

describe("buildTerminalBashLine：单物理行执行与退出捕获", () => {
	it("单行命令使用 eval 转义并保留 shell 退出语义", () => {
		const line = buildTerminalBashLine("ls -la");
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("eval $'ls -la'");
		expect(line).toMatch(SENTINEL_FMT);
		expect(line).toContain("__pi_rc=$?");
		expect(line).not.toContain("PIPESTATUS");
	});

	it("尾注释被限制在 eval 脚本内，不能吞哨兵", () => {
		const line = buildTerminalBashLine("echo done # note");
		expect(line).toContain("eval $'echo done # note'; __pi_rc=$?");
		expect(line).not.toContain("\n");
		expect(line).toMatch(SENTINEL_FMT);
	});

	it("eval 中的语法错误仍留下外层完成哨兵", () => {
		const line = buildTerminalBashLine("echo hi |");
		expect(line).toContain("eval $'echo hi |'; __pi_rc=$?");
		expect(line).not.toContain("\n");
		expect(line).toMatch(SENTINEL_FMT);
	});

	it("尾随续行符：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine("echo hi \\");
		expect(line).toBe("echo hi \\");
		expect(line).not.toContain("pi-exit");
	});

	it("未闭合引号：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine('echo "hi');
		expect(line).toBe('echo "hi');
		expect(line).not.toContain("pi-exit");
	});

	it("多行命令保持 $'...' 转义单行 + 行内拼接（行为不变）", () => {
		const line = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
		expect(line.startsWith("eval $'")).toBe(true);
		expect(line.includes("\n")).toBe(false);
		expect(line).toContain("; __pi_rc=");
		expect(line).toMatch(SENTINEL_FMT);
	});

	it("tailFile：tail 补看段落在哨兵行内，退出码仍是底层命令的", () => {
		const line = buildTerminalBashLine("make", { file: "build.log", lines: 20 });
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("tail -n 20 -- 'build.log'");
		expect(line).toMatch(SENTINEL_FMT);
	});
});

describe("sentinelUnsafeReason：续行/引号扫描（audit fix #2）", () => {
	it("普通单行命令 → null（可注入）", () => {
		expect(sentinelUnsafeReason("echo 'a b' | grep a")).toBeNull();
		expect(sentinelUnsafeReason('echo "x=$(date)"')).toBeNull();
	});

	it("尾随续行符 → trailing_backslash（含尾随空白）", () => {
		expect(sentinelUnsafeReason("echo hi \\")).toBe("trailing_backslash");
		expect(sentinelUnsafeReason("echo hi \\   ")).toBe("trailing_backslash");
	});

	it("未闭合引号 → unclosed_quote（三种引号）", () => {
		expect(sentinelUnsafeReason('echo "hi')).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo 'hi")).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo `hi")).toBe("unclosed_quote");
	});

	it("ANSI-C 引号内的转义单引号不误判", () => {
		expect(sentinelUnsafeReason("echo $'it\\'s fine'")).toBeNull();
	});

	it("多行命令恒判安全（走 eval 转义路径，必然可注入）", () => {
		expect(sentinelUnsafeReason("echo 'x\ndo\ny'")).toBeNull();
	});
});

describe("detectTrailingLimiter：命令替换保守跳过拆管（audit fix #6）", () => {
	it("含 $( 的命令直接跳过：替换内的嵌套管道不被误拆", () => {
		expect(detectTrailingLimiter("echo $(ls | tail -5)")).toBeNull();
		expect(detectTrailingLimiter("diff $(sort a.txt | tail -1) b.txt | tail -3")).toBeNull();
	});

	it("含反引号的命令直接跳过", () => {
		expect(detectTrailingLimiter("echo `ls | tail -5`")).toBeNull();
	});

	it("不含命令替换的尾部限输出管道照常识别", () => {
		const hit = detectTrailingLimiter("seq 1 30 | tail -3");
		expect(hit).not.toBeNull();
		expect(hit?.base).toBe("seq 1 30");
		expect(hit?.lines).toBe(3);
	});
});

describe("括号组感知：组内 | 不是顶层管道，未闭合组不注入哨兵（#573）", () => {
	it("花括号组内的末段 | tail 不被拆（复现原形：cmd && { …; x | tail -3; } > log）", () => {
		expect(detectTrailingLimiter("cd /tmp && { echo HELLO; date | tail -3; } > /tmp/x.log 2>&1; echo done")).toBeNull();
	});

	it("子 shell 内的 | tail 不被拆", () => {
		expect(detectTrailingLimiter("cd /tmp && ( echo A; date | tail -3 )")).toBeNull();
	});

	it("组外的顶层尾部管道仍照常拆，base 是完整的组", () => {
		const hit = detectTrailingLimiter("{ echo a; echo b; } | tail -1");
		expect(hit?.base).toBe("{ echo a; echo b; }");
		expect(hit?.lines).toBe(1);
	});

	it("逻辑或 || 不是管道；转义的 \| 是字面竖线，都不拆", () => {
		expect(detectTrailingLimiter("false || tail -3")).toBeNull();
		expect(detectTrailingLimiter("echo a \\| tail -3")).toBeNull();
	});

	it("ANSI-C 引号内的 \' 不提前闭合引号，其后的顶层管道照常识别", () => {
		const hit = detectTrailingLimiter("echo $'it\\'s' | tail -1");
		expect(hit?.base).toBe("echo $'it\\'s'");
	});

	it("sentinelUnsafeReason：未闭合的 { / ( 组 → unclosed_group（残句不注入）", () => {
		expect(sentinelUnsafeReason("cd /tmp && { echo HELLO; date | tail -3")).toBe("unclosed_group");
		expect(sentinelUnsafeReason("cd /tmp && ( echo A; date")).toBe("unclosed_group");
	});

	it("sentinelUnsafeReason：括号已配平 / 参数展开 / 函数定义 / case 的 ) 不误判", () => {
		expect(sentinelUnsafeReason("cd /tmp && { echo HELLO; date | tail -3; } > /tmp/x.log 2>&1; echo done")).toBeNull();
		expect(sentinelUnsafeReason("echo ${HOME} && echo $((1+2))")).toBeNull();
		expect(sentinelUnsafeReason("f() { echo a; }; f")).toBeNull();
		expect(sentinelUnsafeReason("case x in a) echo a;; esac")).toBeNull();
		expect(sentinelUnsafeReason("echo '{' && echo done")).toBeNull();
	});
});

describe("sentinelUnsafeReason：heredoc 与关键字块（0.103 审计补漏）", () => {
	it("未闭合 heredoc → unclosed_heredoc：哨兵行会被当正文吞掉，shell 停在 PS2", () => {
		expect(sentinelUnsafeReason("cat <<EOF")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat <<- EOF")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat << 'EOF'")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat <<EOF | grep a")).toBe("unclosed_heredoc");
	});

	it("<<< here-string 与算术左移不是 heredoc，不误判", () => {
		expect(sentinelUnsafeReason("cat <<< 'text'")).toBeNull();
		expect(sentinelUnsafeReason("echo $((1 << 2))")).toBeNull();
		expect(sentinelUnsafeReason("(( x << 2 ))")).toBeNull();
		expect(sentinelUnsafeReason("echo a << b")).toBe("unclosed_heredoc");
	});

	it("未闭合 if/for/while/case 块 → unclosed_block", () => {
		expect(sentinelUnsafeReason("if [ -f x ]; then echo y")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("for f in *; do echo $f")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("while true; do sleep 1")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("case $x in a) echo y;; ")).toBe("unclosed_block");
	});

	it("单行闭合的 if/for/while/case 不误判", () => {
		expect(sentinelUnsafeReason("if [ -f x ]; then echo y; fi")).toBeNull();
		expect(sentinelUnsafeReason("for f in *; do echo $f; done")).toBeNull();
		expect(sentinelUnsafeReason("while read l; do echo $l; done < f.txt")).toBeNull();
		expect(sentinelUnsafeReason("case $x in a) echo y;; esac")).toBeNull();
		expect(sentinelUnsafeReason("if true; then echo a; elif false; then echo b; else echo c; fi")).toBeNull();
	});

	it("作为参数/操作数/字符串的关键字不算块（命令位置识别）", () => {
		expect(sentinelUnsafeReason("echo if done fi esac while")).toBeNull();
		expect(sentinelUnsafeReason("[[ $x == if ]]")).toBeNull();
		expect(sentinelUnsafeReason("echo 'if; then'")).toBeNull();
		expect(sentinelUnsafeReason("grep if file # while done")).toBeNull();
	});
});
