import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as helpers from "../lib/hub-upgrade-release.mjs";
const {
	createDiagnosticRedactor,
	summarizeUpgradeJob,
	summarizeLaunchctl,
	readLogTail,
	diagnosticCommand,
	observeUpgradeTerminal,
	submittedUpgradeJob,
} = helpers as any;
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function observer(sequence: any[], connection = "升级成功", expectedState = "succeeded") {
	const jobId = randomUUID();
	let time = 0,
		index = 0;
	const readJob = vi.fn(async () => {
		const value = sequence[Math.min(index++, sequence.length - 1)];
		return value ? { id: jobId, ...value } : undefined;
	});
	const readConnection = vi.fn(async () => connection);
	const sleep = vi.fn(async (ms: number) => {
		time += ms;
	});
	const onObservation = vi.fn();
	return { jobId, readJob, readConnection, sleep, onObservation, expectedState, timeout: 1000, now: () => time };
}

describe("Hub release acceptance terminal observation", () => {
	it("binds normal submissions to a new job and rejects reused or missing job ids", () => {
		const job = { id: randomUUID(), state: "queued" };
		const previousJobId = randomUUID();
		expect(
			submittedUpgradeJob({ status: 202, body: { ok: true, job }, previousJobId, expectedState: "succeeded" }),
		).toEqual(job);
		expect(() =>
			submittedUpgradeJob({ status: 202, body: { ok: true, job }, previousJobId: job.id, expectedState: "succeeded" }),
		).toThrow(/did not create a new/);
		expect(() =>
			submittedUpgradeJob({
				status: 202,
				body: { ok: true },
				persistedJob: job,
				previousJobId,
				expectedState: "succeeded",
			}),
		).toThrow(/did not create a new/);
	});

	it("accepts an early 503 only for a deliberately failed path with a new durable failed job", () => {
		const job = { id: randomUUID(), state: "failed", error: "package missing" };
		const input = {
			status: 503,
			body: { error: "package missing" },
			persistedJob: job,
			previousJobId: randomUUID(),
			expectedState: "failed",
		};
		expect(submittedUpgradeJob(input)).toEqual(job);
		expect(() => submittedUpgradeJob({ ...input, expectedState: "succeeded" })).toThrow(/package missing/);
		expect(() => submittedUpgradeJob({ ...input, previousJobId: job.id })).toThrow(/did not create a new/);
		expect(() => submittedUpgradeJob({ ...input, persistedJob: { ...job, state: "running" } })).toThrow(
			/did not create a new/,
		);
		expect(() => submittedUpgradeJob({ ...input, status: 409 })).toThrow(/did not create a new/);
	});
	it("rejects this job's failure before polling a potentially unavailable browser", async () => {
		const options = observer([{ state: "failed", phase: "failed", error: "Worker did not start" }]);
		await expect(observeUpgradeTerminal(options)).rejects.toThrow(/unexpectedly failed.*Worker did not start/);
		expect(options.sleep).not.toHaveBeenCalled();
		expect(options.readConnection).not.toHaveBeenCalled();
		expect(options.onObservation.mock.calls[0][0].job.id).toBe(options.jobId);
	});

	it("does not accept a previous job's terminal result or stale success text", async () => {
		const options = observer([
			{ id: randomUUID(), state: "succeeded" },
			{ state: "running", phase: "installing" },
			{ state: "succeeded", phase: "completed", bootId: "new-boot" },
		]);
		await expect(observeUpgradeTerminal(options)).resolves.toMatchObject({ id: options.jobId, bootId: "new-boot" });
		expect(options.sleep).toHaveBeenCalledTimes(2);
	});

	it("requires a new failed job for expected failure even when the UI already says failed", async () => {
		const options = observer(
			[
				{ id: randomUUID(), state: "failed", error: "previous attempt" },
				{ state: "queued", phase: "queued" },
				{ state: "failed", error: "missing package" },
			],
			"升级失败",
			"failed",
		);
		await expect(observeUpgradeTerminal(options)).resolves.toMatchObject({
			id: options.jobId,
			error: "missing package",
		});
		expect(options.sleep).toHaveBeenCalledTimes(2);
	});

	it("rejects an unexpected success in the deliberately broken release path", async () => {
		const options = observer([{ state: "succeeded" }], "升级成功", "failed");
		await expect(observeUpgradeTerminal(options)).rejects.toThrow(/unexpectedly succeeded/);
		expect(options.sleep).not.toHaveBeenCalled();
	});

	it("requires the expected UI terminal message as well as the job result", async () => {
		const options = observer([{ state: "succeeded", phase: "completed" }], "正在连接");
		await expect(observeUpgradeTerminal(options)).rejects.toThrow(/timed out.*succeeded\/completed.*正在连接/);
	});

	it("does not let a replacement job finish an observed attempt", async () => {
		const options = observer([{ state: "running" }, { id: randomUUID(), state: "succeeded" }]);
		await expect(observeUpgradeTerminal(options)).rejects.toThrow(/was replaced by/);
	});

	it("reports a UI failure without waiting ten minutes for the job file to catch up", async () => {
		const options = observer([{ state: "running", phase: "restarting" }], "升级失败：worker exited");
		await expect(observeUpgradeTerminal(options)).rejects.toThrow(/UI reports failure/);
		expect(options.sleep).not.toHaveBeenCalled();
	});
});

describe("Hub release safe failure diagnostics", () => {
	it("removes known credentials even when printed without a field name, and drops unknown sensitive lines", () => {
		const redact = createDiagnosticRedactor({ BUILD_SECRET: "env-value-for-test", PATH: "ordinary-path" });
		redact.remember({
			password: "account-pass-for-test",
			device: { credential: "device-value-for-test" },
			pollToken: "poll-value-for-test",
		});
		redact.add("session=value-for-test");
		redact.add("value-for-test");
		const result = redact.text(
			[
				"Service worker failed with exit code 5",
				"env-value-for-test account-pass-for-test device-value-for-test poll-value-for-test",
				"session=value-for-test",
				"UNEXPECTED_API_KEY=not-in-parent-environment",
				"//registry.example/:_auth=unknown-short-auth",
				"Authorization: Bearer otherwise-unknown-value",
				"https://user:" + "url-value-for-test" + "@example.org/package.tgz",
			].join("\n"),
		);
		expect(result).toContain("Service worker failed with exit code 5");
		for (const value of [
			"env-value-for-test",
			"account-pass-for-test",
			"device-value-for-test",
			"poll-value-for-test",
			"value-for-test",
			"not-in-parent-environment",
			"otherwise-unknown-value",
			"unknown-short-auth",
			"url-value-for-test",
		])
			expect(result).not.toContain(value);
		expect(redact.json({ message: "env-value-for-test", nested: { token: "unrecognized" } })).toEqual({
			message: "[REDACTED]",
			nested: { token: "[REDACTED]" },
		});
	});

	it("redacts multiline private keys and unnamed long opaque credentials", () => {
		const redact = createDiagnosticRedactor({});
		const body = "x".repeat(64);
		const pem = ["-----BEGIN TEST" + " PRIVATE KEY-----", body, "-----END TEST" + " PRIVATE KEY-----"].join("\n");
		const result = redact.text(`before\n${pem}\nafter`);
		expect(result).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
		expect(redact.text(body)).not.toContain(body);
	});

	it("projects upgrade jobs instead of copying account identity or arbitrary new fields", () => {
		const job = {
			id: randomUUID(),
			state: "failed",
			phase: "failed",
			error: "launch failed",
			targetVersion: "0.118.0",
			requestedBy: "account-identity",
			instanceId: "private-identity",
			futureCredential: "never-copy",
			environment: { ANYTHING: "not-exported" },
		};
		expect(summarizeUpgradeJob(job)).toEqual({
			id: job.id,
			state: "failed",
			phase: "failed",
			error: "launch failed",
			targetVersion: "0.118.0",
		});
	});

	it("keeps launchd runtime facts while excluding all environments and arguments", () => {
		const raw = [
			"gui/501/com.example = {",
			"\tstate = exited",
			"\tprogram = /opt/node/bin/node",
			"\targuments = {",
			"\t\t/path/with-private-argument",
			"\t}",
			"\tinherited environment = {",
			"\t\tUNRECOGNIZED_NAME => private-value",
			"\t\tpid = private-in-nested-environment",
			"\t}",
			"\tenvironment = {",
			"\t\tAPI_KEY => another-private-value",
			"\t}",
			"\tpid = 123",
			"\tlast exit code = 5",
			"}",
		].join("\n");
		expect(summarizeLaunchctl(raw)).toBe(
			"\tstate = exited\n\tprogram = /opt/node/bin/node\n\tpid = 123\n\tlast exit code = 5",
		);
		expect(
			summarizeLaunchctl(
				'{\n\t"PID" = 12;\n\t"LastExitStatus" = 5;\n\t"Label" = "test";\n\t"EnvironmentVariables" = {};\n}',
			),
		).toContain('"LastExitStatus" = 5');
	});

	it("reads a bounded tail and discards any partial first line that lost its sensitive key", async () => {
		const root = await mkdtemp(join(process.platform === "win32" ? "E:/tmp" : tmpdir(), "hub-release-diagnostics-"));
		roots.push(root);
		const path = join(root, "worker.log");
		await writeFile(path, `API_KEY=${"private".repeat(40)}\nlast failure\n`);
		const tail = await readLogTail(path, 40);
		expect(tail.truncated).toBe(true);
		expect(tail.text).toBe("last failure\n");
		await writeFile(path, "secret-fragment-without-newline".repeat(10));
		expect((await readLogTail(path, 16)).text).toBe("");
	});

	it("bounds command output without inheriting stdio or launching a service", async () => {
		const result = await diagnosticCommand(
			process.execPath,
			["-e", 'process.stdout.write("x".repeat(4096)); process.stderr.write("failed")'],
			{ limit: 128 },
		);
		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBe(128);
		expect(result.stderr).toBe("failed");
	});
});
