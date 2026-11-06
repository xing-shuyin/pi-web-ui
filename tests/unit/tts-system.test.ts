import { describe, expect, it } from "vitest";
import { runAudioProcess } from "../../server/tts-system.js";

describe("system speech subprocess boundary", () => {
	it("passes Unicode and shell syntax as stdin data", async () => {
		const input = '你好 "quoted"; $(Write-Output injected) `literal`\n第二行';
		const output = await runAudioProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input });
		expect(output.toString()).toBe(input);
	});
	it("captures a nonzero exit and missing program", async () => {
		await expect(
			runAudioProcess(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(2)"]),
		).rejects.toThrow(/failed/);
		await expect(runAudioProcess("pi-tts-missing-command-test", [])).rejects.toHaveProperty("code", "ENOENT");
	});
	it("kills cancelled speech subprocesses", async () => {
		const controller = new AbortController();
		const pending = runAudioProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			signal: controller.signal,
		});
		const expected = expect(pending).rejects.toThrow(/cancelled/);
		controller.abort(new Error("cancelled"));
		await expected;
	});
	it("times out a stalled subprocess", async () => {
		await expect(
			runAudioProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
		).rejects.toThrow();
	});
});
