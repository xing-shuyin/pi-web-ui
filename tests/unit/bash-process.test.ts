import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchBashProcessSource, SHELL_WAIT_SOURCE, SENTINEL } from "../../server/patch-bash-process.js";

type WaitOptions = {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	timeoutMs?: number;
	kill: () => void;
};
const wait = new Function(`${SHELL_WAIT_SOURCE}; return waitForShellLifecycle;`)() as (
	child: ReturnType<typeof spawn>,
	options: WaitOptions,
) => Promise<number | null>;

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	}) as unknown as ReturnType<typeof spawn>;
}

afterEach(() => vi.useRealTimers());

describe("native bash lifecycle (#794)", () => {
	it("preserves exit status when descendants continuously inherit output, even across the execution deadline", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const kill = vi.fn();
		const output = vi.fn();
		const result = wait(child, { onData: output, timeout: 0.5, timeoutMs: 500, kill });
		child.emit("exit", 1);
		for (let i = 0; i < 20; i++) {
			child.stdout!.emit("data", Buffer.from("tick\n"));
			await vi.advanceTimersByTimeAsync(50);
		}
		expect(await result).toBe(1);
		expect(kill).not.toHaveBeenCalled();
		expect(child.stdout!.destroyed).toBe(true);
		expect(child.listenerCount("exit")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drains late stdout and stderr and finishes immediately on close", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const chunks: string[] = [];
		const result = wait(child, { onData: (data) => chunks.push(data.toString()), kill: vi.fn() });
		child.emit("exit", 7);
		await vi.advanceTimersByTimeAsync(75);
		child.stdout!.emit("data", Buffer.from("stdout tail"));
		child.stderr!.emit("data", Buffer.from("stderr tail"));
		child.emit("close", 7);
		expect(await result).toBe(7);
		expect(chunks).toEqual(["stdout tail", "stderr tail"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["timeout", "abort"])("settles %s even when killing produces neither exit nor close", async (reason) => {
		vi.useFakeTimers();
		const child = fakeChild();
		const controller = new AbortController();
		const kill = vi.fn();
		const result = wait(child, { onData: vi.fn(), signal: controller.signal, timeout: 0.1, timeoutMs: 100, kill });
		const rejection = expect(result).rejects.toThrow(reason === "timeout" ? "timeout:0.1" : "aborted");
		if (reason === "abort") controller.abort();
		await vi.advanceTimersByTimeAsync(1100);
		await rejection;
		expect(kill).toHaveBeenCalledTimes(1);
		expect(child.stdout!.destroyed).toBe(true);
		expect(child.listenerCount("error")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles cancellation during drain and synchronous exit from kill", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const result = wait(child, { onData: vi.fn(), signal: controller.signal, kill: () => child.emit("exit", null) });
		child.emit("exit", 0);
		controller.abort();
		await expect(result).rejects.toThrow("aborted");
	});

	it("propagates spawn failure and removes output listeners", async () => {
		const child = fakeChild();
		const result = wait(child, { onData: vi.fn(), kill: vi.fn() });
		child.emit("error", new Error("ENOENT"));
		await expect(result).rejects.toThrow("ENOENT");
		expect(child.stdout!.listenerCount("data")).toBe(0);
	});

	it("preserves large final output from a real child", async () => {
		const child = spawn(
			process.execPath,
			["-e", "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('end');process.exitCode=7"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let bytes = 0;
		const result = await wait(child, {
			onData: (data) => {
				bytes += data.length;
			},
			kill: () => child.kill(),
		});
		expect(result).toBe(7);
		expect(bytes).toBe(2 * 1024 * 1024 + 3);
	});

	it("returns the real exit code with a real descendant retaining inherited pipes", async () => {
		const descendant =
			"const t=setInterval(()=>console.log('tick'),20);setTimeout(()=>{clearInterval(t);process.exit()},1800)";
		const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});child.unref();setTimeout(()=>process.exit(1),50)`;
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		const start = Date.now();
		const kill = vi.fn(() => {
			child.kill();
		});
		const result = await wait(child, { onData: () => {}, timeout: 0.6, timeoutMs: 600, kill });
		expect(result).toBe(1);
		expect(Date.now() - start).toBeLessThan(1700);
		expect(kill).not.toHaveBeenCalled();
	}, 5000);
});

describe("SDK compatibility patch", () => {
	// 这条「新进程里打补丁」的用例，成本全在起 node + `--import tsx` 现场编译 TS，不在断言本身：
	// 本机约 3s，GitHub runner 实测 6.7–8.2s 波动。原来 execFile 只给 8s、用例 10s，等于把 runner
	// 快慢当成了断言，慢机就会把 main 偶发判红（断言一条没改，只是给启动成本留够余量）。
	it("patches the known upstream lifecycle and leaves surrounding shell setup intact", () => {
		const original = `import { waitForChildProcess } from "../../utils/child-process.js";
export async function createLocalShellOperations() {
            const child = spawn();
            let timedOut = false;
            let timeoutHandle;
            try { const exitCode = await waitForChildProcess(child); }
            finally {
                if (signal)
                    signal.removeEventListener("abort", onAbort);
            }
}`;
		const result = patchBashProcessSource(original);
		expect(result.status).toBe("patched");
		expect(result.code).toContain("const child = spawn();");
		expect(result.code).toContain("await waitForShellLifecycle(child");
		expect(result.code).not.toContain("waitForChildProcess");
		new Function(result.code.replace(/^export /gm, ""));
		expect(patchBashProcessSource(result.code).status).toBe("already");
	});

	it("patches the first SDK import in a fresh process without changing installed files", async () => {
		const descendant =
			"const t=setInterval(()=>console.log('tick'),20);setTimeout(()=>{clearInterval(t);process.exit()},1800)";
		const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});c.unref();setTimeout(()=>process.exit(1),50)`;
		const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
		const command = `${quote(process.execPath.replaceAll("\\\\", "/"))} -e ${quote(script)}`;
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const file = join(dirname(entry), "core", "tools", "bash.js");
		const before = readFileSync(file, "utf8");
		const longCommand = `${quote(process.execPath.replaceAll("\\\\", "/"))} -e ${quote("setInterval(()=>{},1000)")}`;
		const code = `
const {createLocalBashOperations}=await import('@earendil-works/pi-coding-agent');
const ops=createLocalBashOperations();
const r=await ops.exec(${JSON.stringify(command)},process.cwd(),{onData:()=>{},timeout:0.6});
if(r.exitCode!==1)throw Error(JSON.stringify(r));
console.log('exit=1');
for(const mode of ['timeout','abort']) {
 const controller=new AbortController();
 const timer=mode==='abort'?setTimeout(()=>controller.abort(),100):undefined;
 const start=Date.now();
 try { await ops.exec(${JSON.stringify(longCommand)},process.cwd(),{onData:()=>{},signal:controller.signal,timeout:mode==='timeout'?0.1:undefined});throw Error('unexpected success'); }
 catch(error) {if(error.message!==(mode==='timeout'?'timeout:0.1':'aborted'))throw error;}
 finally {clearTimeout(timer);}
 if(Date.now()-start>2500)throw Error('cleanup exceeded deadline');
 console.log(mode+'=ok');
}`;
		const result = await promisify(execFile)(
			process.execPath,
			["--import", "tsx", "--import", "./server/resolve-global-sdk.ts", "--input-type=module", "-e", code],
			{ cwd: process.cwd(), timeout: 20_000, env: { ...process.env, PI_WEB_SDK: "bundled" } },
		);
		expect(result.stdout).toContain("exit=1");
		expect(result.stdout).toContain("timeout=ok");
		expect(result.stdout).toContain("abort=ok");
		expect(readFileSync(file, "utf8")).toBe(before);
	}, 30_000);

	it("is applied to the resolved SDK and is idempotent", () => {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const source = readFileSync(join(dirname(entry), "core", "tools", "bash.js"), "utf8");
		const result = patchBashProcessSource(source);
		expect(result.code).toContain(SENTINEL);
		expect(result.code).not.toContain("let timedOut = false");
		expect(patchBashProcessSource(result.code)).toEqual({ code: result.code, status: "already" });
		new Function(result.code.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
	});

	it("does not rewrite unknown upstream implementations", () => {
		expect(patchBashProcessSource("new SDK implementation")).toEqual({
			code: "new SDK implementation",
			status: "unsupported",
		});
	});
});
