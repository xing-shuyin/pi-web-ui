import { createHash } from "node:crypto";
import * as processes from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runVerificationCommand,
	validateLocalVerificationPlan,
} from "../../server/device-center/local-verification.js";
import { canonicalizeJson } from "../../server/device-center/work-contract.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function cwd() {
	const dir = await mkdtemp(join(tmpdir(), "local-verification-"));
	dirs.push(dir);
	return dir;
}

describe("local verification foreground runner", () => {
	it("hashes the complete emitted output while bounding the preview", async () => {
		const output = "x".repeat(32 * 1024);
		const result = await runVerificationCommand("node -e \"process.stdout.write('x'.repeat(32768))\"", {
			cwd: await cwd(),
			env: process.env,
		});
		expect(result.status).toBe("passed");
		expect(result.exitCode).toBe(0);
		expect(result.outputPreview).toBe(output.slice(0, 16 * 1024));
		expect(result.outputDigest).toBe(createHash("sha256").update(output).digest("hex"));
	});
	it("reports the real nonzero command exit code", async () => {
		const root = await cwd();
		const failed = await runVerificationCommand("node -e \"process.stdout.write('bad');process.exit(7)\"", {
			cwd: root,
			env: process.env,
		});
		expect(failed).toMatchObject({ status: "failed", exitCode: 7, outputPreview: "bad" });
	});
	it.skipIf(process.platform !== "win32")(
		"normalizes a real Windows DWORD exit code without losing confirmed stop",
		async () => {
			const result = await runVerificationCommand('node -e "process.exit(-1)"', { cwd: await cwd(), env: process.env });
			expect(result).toMatchObject({ status: "failed", exitCode: -1 });
		},
	);
	it("never calls excess output successful", async () => {
		const root = await cwd();
		const excess = await runVerificationCommand(
			"node -e \"process.stdout.write('a'.repeat(2097152));setTimeout(()=>{},10000)\"",
			{ cwd: root, env: process.env },
		);
		expect(excess.status).toBe("failed");
		expect(excess.outputPreview.length).toBe(16 * 1024);
	});
	it.skipIf(process.platform !== "win32")(
		"rejects a successful shell that leaves a detached child in its Windows Job",
		async () => {
			const root = await cwd();
			await writeFile(join(root, "child.cjs"), "setTimeout(()=>require('fs').writeFileSync('escaped','yes'),1000)");
			await writeFile(
				join(root, "parent.cjs"),
				"require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore',detached:true}).unref()",
			);
			const result = await runVerificationCommand("node parent.cjs", { cwd: root, env: process.env });
			expect(result.status).toBe("failed");
			expect(result.exitCode).not.toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 1100));
			expect(existsSync(join(root, "escaped"))).toBe(false);
		},
	);
	it.skipIf(process.platform !== "win32")("rejects a forged receipt sent to an enumerated Windows pipe", async () => {
		const root = await cwd();
		const actualSpawn = vi.mocked(processes.spawn).getMockImplementation()!;
		vi.mocked(processes.spawn).mockImplementationOnce(((...args: any[]) => {
			const env = args[2].env;
			args[2].env = { ...env, PI_TEST_PIPE: env.PI_LOCAL_VERIFICATION_PIPE };
			return Reflect.apply(actualSpawn, processes, args);
		}) as any);
		await writeFile(
			join(root, "forge.cjs"),
			String.raw`const fs=require('fs'),net=require('net'); const base='\\\\.\\pipe\\'; const name=process.env.PI_TEST_PIPE; if(!fs.readdirSync(base).includes(name)) throw Error('supervisor pipe absent'); const socket=net.connect(base+name,()=>socket.end('0\n')); socket.on('error',()=>{});`,
		);
		await expect(
			runVerificationCommand("node forge.cjs", { cwd: root, env: process.env, stopTimeoutMs: 1000 }),
		).rejects.toMatchObject({ stopUnconfirmed: true });
	});
	it("times out and confirms termination of a real foreground shell tree", async () => {
		const result = await runVerificationCommand('node -e "setTimeout(()=>{},10000)"', {
			cwd: await cwd(),
			env: process.env,
			timeoutMs: 150,
		});
		expect(result.status).toBe("failed");
		expect(result.exitCode).not.toBe(0);
	});
	it("waits for real cancellation before rejecting", async () => {
		const controller = new AbortController();
		const operation = runVerificationCommand('node -e "setTimeout(()=>{},10000)"', {
			cwd: await cwd(),
			env: process.env,
			signal: controller.signal,
		});
		const timer = setTimeout(() => controller.abort(new Error("test cancelled")), 150);
		try {
			await expect(operation).rejects.toThrow("test cancelled");
		} finally {
			clearTimeout(timer);
		}
	});
	it("rejects empty, changed and unauthorized plans even with producer checks", () => {
		const commands = ['node -e "process.exit(0)"'];
		const plan = {
			commands,
			digest: createHash("sha256").update(canonicalizeJson({ commands })).digest("hex"),
			authorizedByAccountId: "owner",
			authorizedAt: Date.now(),
		};
		expect(validateLocalVerificationPlan(plan)).toEqual(plan);
		expect(() => validateLocalVerificationPlan({ ...plan, commands: [] })).toThrow("Owner-authorized");
		expect(() => validateLocalVerificationPlan({ ...plan, commands: ['node -e "process.exit(9)"'] })).toThrow(
			"Owner-authorized",
		);
		expect(() => validateLocalVerificationPlan({ commands, digest: plan.digest })).toThrow("Owner-authorized");
	});
});
