/**
 * eval-tool.ts — 受控的持久代码求值沙箱工具（eval）。
 *
 * 背景与设计：
 *   AI 在面对需要快速计算、复杂数据处理（如解析庞大的 CSV/JSON 数据、统计指标计算）、
 *   算法推演或生成图表时，以往只能通过 `bash` 工具反复创建与删除临时脚本，且中间变量
 *   无法跨调用持久化。
 *
 *   借鉴 oh-my-pi (omp) 的 eval 工具经验，同时彻底规避其两大缺陷：
 *   1. 【工具挤占防范】：本工具默认关闭（defaultOn: false，opt-in），不挤占常规代码编写/检索；
 *   2. 【IPC 死锁防范】：采用轻量独立子进程驱动，输出独立缓冲，配以跨平台进程树硬超时查杀
 *      （Windows 下 taskkill /F /T，Unix 下 SIGKILL），杜绝子进程挂起与假死。
 *
 * 支持语言：
 *   - "py": Python 3（使用内置 ast 解析，支持多语句执行、最后表达式求值与变量保持）；
 *   - "js" / "ts": Node.js（基于 node:repl，支持 top-level await、变量保持与控制台捕获）。
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { EVAL_TOOL_NAME } from "./tool-manager.js";

export { EVAL_TOOL_NAME };

const DEFAULT_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_CHARS = 12000;

export interface EvalWorkerResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	result: string | null;
	error: string | null;
}

/** 跨平台递归查杀进程树。 */
export function killProcessTree(proc: ChildProcess): void {
	if (!proc.pid) return;
	if (process.platform === "win32") {
		try {
			execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	} else {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	}
}

/** 探测系统可用的 Python 命令。 */
function resolvePythonCmd(): string | null {
	for (const cmd of ["python", "python3", "py"]) {
		try {
			const out = execSync(`${cmd} --version`, { stdio: "pipe", encoding: "utf8" });
			if (out.toLowerCase().includes("python")) return cmd;
		} catch {}
	}
	return null;
}

const PYTHON_DRIVER_SCRIPT = `
import sys, io, ast, json, traceback, os

WORKDIR = os.environ.get('PI_EVAL_WORKDIR', '')
PROJECT_DIR = os.environ.get('PI_EVAL_PROJECT_DIR', '')

_scope = {'__name__': '__main__', 'WORKDIR': WORKDIR, 'PROJECT_DIR': PROJECT_DIR}

def run_cell(code):
    out = io.StringIO()
    err = io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    res = None
    exc = None
    try:
        parsed = ast.parse(code)
        if parsed.body and isinstance(parsed.body[-1], ast.Expr):
            last = parsed.body.pop()
            if parsed.body:
                exec(compile(parsed, '<eval>', 'exec'), _scope)
            res = eval(compile(ast.Expression(last.value), '<eval>', 'eval'), _scope)
        else:
            exec(compile(code, '<eval>', 'exec'), _scope)
    except Exception:
        exc = traceback.format_exc()
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return {
        'stdout': out.getvalue(),
        'stderr': err.getvalue(),
        'result': repr(res) if res is not None else None,
        'error': exc
    }

for line in sys.stdin:
    if not line.strip():
        continue
    try:
        req = json.loads(line)
        if req.get('action') == 'reset':
            _scope.clear()
            _scope['__name__'] = '__main__'
            _scope['WORKDIR'] = WORKDIR
            _scope['PROJECT_DIR'] = PROJECT_DIR
            resp = {'ok': True, 'stdout': '', 'stderr': '', 'result': None, 'error': None}
        else:
            resp = run_cell(req.get('code', ''))
            resp['ok'] = resp['error'] is None
    except Exception as e:
        resp = {'ok': False, 'stdout': '', 'stderr': '', 'result': None, 'error': traceback.format_exc()}
    
    sys.stdout.write('__PI_EVAL_RES__' + json.dumps(resp, ensure_ascii=False) + '\\n')
    sys.stdout.flush()
`;

const NODE_DRIVER_SCRIPT = `
import repl from "node:repl";
import { PassThrough } from "node:stream";
import readline from "node:readline";

let server;
function createRepl() {
  const inStream = new PassThrough();
  const outStream = new PassThrough();
  server = repl.start({
    input: inStream,
    output: outStream,
    terminal: false,
    useColors: false,
    preview: false
  });
  server.context.console = console;
  server.context.setTimeout = setTimeout;
  server.context.clearTimeout = clearTimeout;
  server.context.setInterval = setInterval;
  server.context.clearInterval = clearInterval;
  server.context.Buffer = Buffer;
  server.context.URL = URL;
  server.context.WORKDIR = process.env.PI_EVAL_WORKDIR || "";
  server.context.PROJECT_DIR = process.env.PI_EVAL_PROJECT_DIR || "";
}
createRepl();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    if (req.action === "reset") {
      createRepl();
      process.stdout.write("__PI_EVAL_RES__" + JSON.stringify({ ok: true, stdout: "", stderr: "", result: null, error: null }) + "\\n");
      return;
    }
    let capturedOut = "";
    let capturedErr = "";
    const origLog = server.context.console.log;
    const origErr = server.context.console.error;
    const origWarn = server.context.console.warn;
    server.context.console.log = (...args) => {
      capturedOut += args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\\n";
    };
    server.context.console.error = (...args) => {
      capturedErr += args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\\n";
    };
    server.context.console.warn = (...args) => {
      capturedErr += args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\\n";
    };

    server.eval(req.code, server.context, "eval", (err, result) => {
      server.context.console.log = origLog;
      server.context.console.error = origErr;
      server.context.console.warn = origWarn;
      const resp = {
        ok: !err,
        stdout: capturedOut,
        stderr: capturedErr,
        result: result !== undefined ? (typeof result === "string" ? result : JSON.stringify(result, null, 2)) : null,
        error: err ? (err.stack || String(err)) : null
      };
      process.stdout.write("__PI_EVAL_RES__" + JSON.stringify(resp) + "\\n");
    });
  } catch (e) {
    const resp = { ok: false, stdout: "", stderr: "", result: null, error: e.stack || String(e) };
    process.stdout.write("__PI_EVAL_RES__" + JSON.stringify(resp) + "\\n");
  }
});
`;

/** 排队中的一次内核请求（驱动协议是单槽的，串行消费；并行 tool call 自动排队）。 */
interface PendingRequest {
	req: { action: string; code?: string };
	timeoutMs: number;
	timer: ReturnType<typeof setTimeout>;
	done: boolean;
	resolve: (res: EvalWorkerResult) => void;
	reject: (err: Error) => void;
}

/**
 * 净化 Eval 子进程环境变量：仅保留操作系统基础变量，剥离所有包含 key/token/secret/auth/cred 等敏感环境变量，
 * 杜绝沙箱脚本窃取宿主云凭据与 API Key。
 */
export function sanitizeEvalEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowedKeys = new Set([
		"path",
		"pathext",
		"systemroot",
		"windir",
		"temp",
		"tmp",
		"tmpdir",
		"home",
		"userprofile",
		"lang",
		"lc_all",
		"term",
		"shell",
		"comspec",
		"os",
		"number_of_processors",
		"processor_architecture",
		"appdata",
		"localappdata",
		"homedrive",
		"homepath",
		"systemdrive",
		"programdata",
		"programfiles",
		"programfiles(x86)",
		"commonprogramfiles",
		"node_env",
	]);
	const cleanEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(sourceEnv)) {
		if (value === undefined) continue;
		const lowerKey = key.toLowerCase();
		if (
			lowerKey.includes("key") ||
			lowerKey.includes("token") ||
			lowerKey.includes("secret") ||
			lowerKey.includes("auth") ||
			lowerKey.includes("pass") ||
			lowerKey.includes("cred")
		) {
			continue;
		}
		if (allowedKeys.has(lowerKey) || lowerKey.startsWith("npm_") || lowerKey.startsWith("python")) {
			cleanEnv[key] = value;
		}
	}
	return cleanEnv;
}

/** 单个持久内核工作进程包装。 */
class EvalKernel {
	private proc: ChildProcess | null = null;
	private rl: readline.Interface | null = null;
	private current: PendingRequest | null = null;
	private queue: PendingRequest[] = [];
	private stderrTail = "";
	private closed = false;
	readonly workdir: string;

	constructor(
		private readonly language: "py" | "js" | "ts",
		private readonly cwd: string,
	) {
		this.workdir = mkdtempSync(join(tmpdir(), `pi-eval-${language}-`));
	}

	private spawn(): void {
		if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
			return;
		}

		// 沙箱边界：内核 cwd 是本会话的独立临时目录（不落在项目里），要读项目
		// 文件时用驱动内注入的 PROJECT_DIR 显式拼绝对路径（两个 env 见下）。
		const spawnOpts = {
			cwd: this.workdir,
			stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: {
				...sanitizeEvalEnv(process.env),
				PI_EVAL_WORKDIR: this.workdir,
				PI_EVAL_PROJECT_DIR: this.cwd,
			},
		};

		if (this.language === "py") {
			const pyCmd = resolvePythonCmd();
			if (!pyCmd) {
				throw new Error("Python executable not found in PATH. Please install Python or use language: 'js'.");
			}
			this.proc = spawn(pyCmd, ["-u", "-c", PYTHON_DRIVER_SCRIPT], spawnOpts);
		} else {
			// js / ts：独立 node -e 驱动，ts 时带 --experimental-strip-types 支持 TypeScript 原生剥离执行。
			const nodeArgs =
				this.language === "ts" ? ["--experimental-strip-types", "-e", NODE_DRIVER_SCRIPT] : ["-e", NODE_DRIVER_SCRIPT];
			this.proc = spawn(process.execPath, nodeArgs, spawnOpts);
		}

		// stderr 必须持续排空：驱动只把用户的 print/console 劫进 StringIO，但
		// os.write(2, …) / 原生扩展 / eval 里再 spawn 的子进程仍写真实 fd 2。
		// piped stderr 无人读，写满 ~64KB 管道缓冲会把驱动挂住（表现为假超时）。
		this.proc.stderr!.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
		});

		this.rl = readline.createInterface({ input: this.proc.stdout! });
		this.rl.on("line", (line) => {
			if (!line.startsWith("__PI_EVAL_RES__")) return;
			const item = this.current;
			if (!item) return;
			this.current = null;
			try {
				const data = JSON.parse(line.slice("__PI_EVAL_RES__".length)) as EvalWorkerResult;
				this.settle(item, data);
			} catch {
				this.settle(item, {
					ok: false,
					stdout: "",
					stderr: this.stderrTail,
					result: null,
					error: "Kernel returned an unparsable response frame",
				});
			}
			this.pump();
		});

		// 代际守卫：killProc 之后旧进程的 exit/error 是「迟到的」，那时 this.proc
		// 已指向新进程（或 null），绝不能让它污染新内核的状态。
		const proc = this.proc;
		proc.on("error", (err) => {
			if (this.proc !== proc) return;
			this.procDied(`Kernel process error: ${err.message}`);
		});

		proc.on("exit", (code) => {
			if (this.proc !== proc) return;
			this.procDied(`Kernel process exited unexpectedly with code ${code}`);
		});
	}

	/** 进程异常退出：结算在飞与排队中的请求（都当失败，不假装成功）。 */
	private procDied(message: string): void {
		if (this.current) {
			const item = this.current;
			this.current = null;
			this.settle(item, {
				ok: false,
				stdout: "",
				stderr: this.stderrTail,
				result: null,
				error: message,
			});
		}
		const queued = this.queue.splice(0);
		for (const item of queued) {
			this.settle(item, { ok: false, stdout: "", stderr: "", result: null, error: message });
		}
		this.pump();
	}

	async execute(code: string, timeoutMs: number, reset = false): Promise<EvalWorkerResult> {
		if (this.closed) throw new Error("Eval kernel is closed");
		if (reset) {
			await this.sendAction({ action: "reset" }, 3000).catch(() => {});
		}
		return await this.sendAction({ action: "eval", code }, timeoutMs);
	}

	private sendAction(req: { action: string; code?: string }, timeoutMs: number): Promise<EvalWorkerResult> {
		return new Promise((resolve, reject) => {
			const item: PendingRequest = {
				req,
				timeoutMs,
				timer: setTimeout(() => {}, 0),
				done: false,
				resolve,
				reject,
			};
			item.timer = setTimeout(() => {
				if (item.done) return;
				if (this.current === item) {
					this.current = null;
					// 硬超时：杀进程树（不留孤儿），后续 pump 按需重启内核。
					this.killProc();
					this.pump();
				}
				item.reject(new Error(`Execution timed out after ${Math.round(item.timeoutMs / 1000)}s`));
			}, timeoutMs);
			this.queue.push(item);
			this.pump();
		});
	}

	/** 串行消费队列：驱动协议一次只发一条请求。 */
	private pump(): void {
		if (this.current || this.queue.length === 0) return;
		try {
			this.spawn();
		} catch (err) {
			const item = this.queue.shift();
			if (item) {
				this.settle(item, { ok: false, stdout: "", stderr: "", result: null, error: (err as Error).message });
			}
			return;
		}
		const item = this.queue.shift()!;
		this.current = item;
		try {
			this.proc!.stdin!.write(JSON.stringify(item.req) + "\n");
		} catch (err) {
			this.current = null;
			this.settle(item, {
				ok: false,
				stdout: "",
				stderr: "",
				result: null,
				error: `Failed to write to kernel: ${(err as Error).message}`,
			});
			this.pump();
		}
	}

	/** 结算一条请求（幂等；清定时器）。 */
	private settle(item: PendingRequest, res: EvalWorkerResult): void {
		if (item.done) return;
		item.done = true;
		clearTimeout(item.timer);
		item.resolve(res);
	}

	/** 只杀进程（保留 workdir）：超时路径用，之后可原样重启内核。 */
	private killProc(): void {
		if (this.rl) {
			this.rl.close();
			this.rl = null;
		}
		if (this.proc) {
			killProcessTree(this.proc);
			this.proc = null;
		}
		this.stderrTail = "";
	}

	dispose(): void {
		this.closed = true;
		if (this.current) {
			const item = this.current;
			this.current = null;
			this.settle(item, { ok: false, stdout: "", stderr: "", result: null, error: "Eval kernel disposed" });
		}
		const queued = this.queue.splice(0);
		for (const item of queued) {
			this.settle(item, { ok: false, stdout: "", stderr: "", result: null, error: "Eval kernel disposed" });
		}
		this.killProc();
		try {
			rmSync(this.workdir, { recursive: true, force: true });
		} catch {}
	}
}

/** 会话级内核池（convId -> { py, js }）。 */
const sessionKernels = new Map<string, Map<string, EvalKernel>>();

function getKernel(sessionId: string, language: "py" | "js" | "ts", cwd: string): EvalKernel {
	let langMap = sessionKernels.get(sessionId);
	if (!langMap) {
		langMap = new Map();
		sessionKernels.set(sessionId, langMap);
	}
	const normLang = language === "ts" ? "js" : language;
	let kernel = langMap.get(normLang);
	if (!kernel) {
		kernel = new EvalKernel(normLang, cwd);
		langMap.set(normLang, kernel);
	}
	return kernel;
}

/** 销毁指定会话的求值沙箱进程。 */
export function disposeEvalSession(sessionId: string): void {
	const langMap = sessionKernels.get(sessionId);
	if (langMap) {
		for (const kernel of langMap.values()) {
			kernel.dispose();
		}
		sessionKernels.delete(sessionId);
	}
}

/** 清理全部求值沙箱。 */
export function disposeAllEvalKernels(): void {
	for (const langMap of sessionKernels.values()) {
		for (const kernel of langMap.values()) {
			kernel.dispose();
		}
	}
	sessionKernels.clear();
}

export function makeEvalTool(opts: { cwd: string; ownerId?: string; lang?: () => ServerLang }): ToolDefinition {
	const getLang = opts.lang ?? (() => "en");
	const sessionId = (opts.ownerId ?? "default").trim() || "default";

	return defineTool({
		name: EVAL_TOOL_NAME,
		label: "Execute code in persistent sandbox",
		description:
			"Execute Python or JavaScript/TypeScript code in an isolated evaluation sandbox. " +
			"Variables and imported modules persist across calls within the conversation. " +
			"Ideal for quick calculations, data transformations, algorithm verification, and inspecting outputs without creating temporary script files.",
		promptSnippet: "evaluate Python or JS/TS code with persistent state",
		parameters: Type.Object({
			code: Type.String({
				description: "The code snippet to evaluate. Top-level variables and functions are preserved across calls.",
			}),
			language: Type.Optional(
				Type.Unsafe<"py" | "js" | "ts">({
					type: "string",
					enum: ["py", "js", "ts"],
					description: 'Target language: "py" for Python (default), "js" or "ts" for Node.js sandbox.',
				}),
			),
			title: Type.Optional(
				Type.String({
					description: 'Optional short label for this step (e.g. "Calculate metrics", "Parse payload").',
				}),
			),
			timeout: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_TIMEOUT_SECONDS,
					description: `Execution timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}, maximum: ${MAX_TIMEOUT_SECONDS}).`,
				}),
			),
			reset: Type.Optional(
				Type.Boolean({
					description: "Whether to reset the sandbox environment before executing (clears all previous variables).",
				}),
			),
		}),
		execute: async (_id, params) => {
			const lang = getLang();
			let language: string = params.language ?? "py";
			if (language === "python") language = "py"; // 常见笔误别名（issue #462）
			if (language !== "py" && language !== "js" && language !== "ts") {
				// schema 已声明 enum(["py","js","ts"])（#417），但那只影响提示不拦运行时；
				// getKernel 的 normLang 只映射 ts，其余任意值会原样建出名为它的 Node 内核，
				// Python 代码被 node 执行报 JS 语法错且模型无从知道是键写错。
				const text = pick(
					lang,
					`错误：language 仅支持 py / js / ts，收到「${language}」。`,
					`Error: language must be one of py / js / ts; got "${language}".`,
				);
				return {
					content: [{ type: "text", text }],
					details: {
						language,
						durationMs: 0,
						ok: false,
						stdout: "",
						stderr: "",
						result: null,
						error: text,
						reset: params.reset ?? false,
					},
				};
			}
			const timeoutSec = Math.min(Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS);
			const timeoutMs = timeoutSec * 1000;
			const startTime = Date.now();

			try {
				const kernel = getKernel(sessionId, language, opts.cwd);
				const res = await kernel.execute(params.code, timeoutMs, params.reset ?? false);
				const durationMs = Date.now() - startTime;

				let text = "";
				const titlePart = params.title ? ` - ${params.title}` : "";
				if (!res.ok) {
					text = pick(
						lang,
						`[eval:${language} 出错 (${durationMs}ms)${titlePart}]\n${res.error || res.stderr || "执行异常"}`,
						`[eval:${language} error (${durationMs}ms)${titlePart}]\n${res.error || res.stderr || "Execution failed"}`,
					);
				} else {
					const parts: string[] = [];
					if (res.stdout.trim()) {
						parts.push(res.stdout.trim());
					}
					if (res.result !== null && res.result !== undefined) {
						parts.push(`=> ${res.result}`);
					}
					if (parts.length === 0) {
						parts.push(pick(lang, "（执行成功，无输出）", "(Completed with no output)"));
					}
					text = `[eval:${language} (${durationMs}ms)${titlePart}]\n` + parts.join("\n");
				}

				if (text.length > MAX_OUTPUT_CHARS) {
					text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… [${text.length - MAX_OUTPUT_CHARS} chars truncated]`;
				}

				const maxDetailChars = MAX_OUTPUT_CHARS;
				const truncateDetail = (s: string) =>
					s && s.length > maxDetailChars ? s.slice(0, maxDetailChars) + `\n… [truncated]` : s;

				return {
					content: [{ type: "text", text }],
					details: {
						language,
						durationMs,
						ok: res.ok,
						stdout: truncateDetail(res.stdout),
						stderr: truncateDetail(res.stderr),
						result: res.result,
						error: res.error,
						reset: params.reset ?? false,
					},
				};
			} catch (err) {
				const durationMs = Date.now() - startTime;
				let errMsg = (err as Error).message;
				if (errMsg.includes("Python executable not found in PATH")) {
					errMsg = pick(
						lang,
						"未在系统 PATH 中找到 Python 可执行程序，请安装 Python 或使用 language: 'js'。",
						"Python executable not found in PATH. Please install Python or use language: 'js'.",
					);
				}
				const text = `${pick(lang, `[eval:${language} 出错 (${durationMs}ms)]`, `[eval:${language} error (${durationMs}ms)]`)}\n${errMsg}`;
				return {
					content: [{ type: "text", text }],
					details: {
						language,
						durationMs,
						ok: false,
						stdout: "",
						stderr: "",
						result: null,
						error: errMsg,
						reset: params.reset ?? false,
					},
				};
			}
		},
	});
}
