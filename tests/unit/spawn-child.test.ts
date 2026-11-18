import { describe, expect, it } from "vitest";
import { spawnChild } from "../../server/spawn-child.js";
import { pidAlive } from "../../server/process-utils.js";

const NODE = process.execPath;

function collect(child: { stdout: NodeJS.ReadableStream | null }) {
	const lines: string[] = [];
	child.stdout?.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
	return lines;
}

describe("spawnChild：常驻子进程单源", () => {
	it("起得来、能读流、退出后 pid 释放", async () => {
		const { child } = spawnChild({ cmd: NODE, args: ["-e", "console.log('hi')"] });
		const out = collect(child);
		await new Promise<void>((done) => child.once("close", () => done()));
		expect(out.join("")).toContain("hi");
		expect(pidAlive(child.pid!)).toBe(false);
	});

	it("stop() 杀掉整棵树并返回 true（长驻进程不会留在后台）", async () => {
		const { child, stop } = spawnChild({ cmd: NODE, args: ["-e", "setTimeout(() => {}, 60000)"] });
		await new Promise((done) => setTimeout(done, 150));
		expect(pidAlive(child.pid!)).toBe(true);
		expect(await stop({ timeoutMs: 5000 })).toBe(true);
		expect(pidAlive(child.pid!)).toBe(false);
	});

	it("stop({ graceMs }) 先给 SIGTERM 让进程自己退", async () => {
		const { child, stop } = spawnChild({
			cmd: NODE,
			args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000)"],
		});
		await new Promise((done) => setTimeout(done, 150));
		expect(await stop({ graceMs: 2000, timeoutMs: 5000 })).toBe(true);
	});

	it("注入 NO_COLOR（可关）并合并额外环境变量", async () => {
		const script =
			"process.stdout.write(JSON.stringify({c: process.env.NO_COLOR ?? null, x: process.env.PWU_X ?? null}))";
		const withDefaults = spawnChild({ cmd: NODE, args: ["-e", script], env: { PWU_X: "1" } });
		const out = collect(withDefaults.child);
		await new Promise<void>((done) => withDefaults.child.once("close", () => done()));
		expect(JSON.parse(out.join(""))).toEqual({ c: "1", x: "1" });

		const keepColor = spawnChild({ cmd: NODE, args: ["-e", script], keepColor: true });
		const out2 = collect(keepColor.child);
		await new Promise<void>((done) => keepColor.child.once("close", () => done()));
		expect(JSON.parse(out2.join("")).c).toBe(null);
	});

	it("inheritEnv 替换基底（隔离环境，不继承父进程变量）", async () => {
		const marker = "PWU_INHERIT_MARKER";
		process.env[marker] = "leaked";
		try {
			const { child } = spawnChild({
				cmd: NODE,
				args: ["-e", `process.stdout.write(String(process.env.${marker} ?? "absent"))`],
				inheritEnv: { PATH: process.env.PATH },
				keepColor: true,
			});
			const out = collect(child);
			await new Promise<void>((done) => child.once("close", () => done()));
			expect(out.join("")).toBe("absent");
		} finally {
			delete process.env[marker];
		}
	});

	it.runIf(process.platform === "win32")("windowsShell 走 cmd.exe /d /s /c（.cmd 包装器）", async () => {
		const { child } = spawnChild({ cmd: NODE, args: ["-e", "console.log(1)"], windowsShell: true });
		const out = collect(child);
		await new Promise<void>((done) => child.once("close", () => done()));
		expect(out.join("").trim()).toBe("1");
	});
});
