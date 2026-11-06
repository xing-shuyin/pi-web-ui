import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const DIAGNOSTIC_LIMIT = 64 * 1024;
const sensitiveKey =
	/pass(?:word|wd)?|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key|(?:^|[^a-z])auth(?:[^a-z]|$)|session[_-]?(?:id|key)/i;

export function createDiagnosticRedactor(environment = process.env) {
	const secrets = new Set();
	const add = (value) => {
		if (typeof value !== "string" || !value) return;
		secrets.add(value);
		secrets.add(encodeURIComponent(value));
	};
	const remember = (value) => {
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			if (sensitiveKey.test(key)) add(item);
			if (item && typeof item === "object") remember(item);
		}
	};
	remember(environment);
	const text = (value) => {
		let result = String(value);
		for (const secret of [...secrets].sort((a, b) => b.length - a.length))
			result = result.split(secret).join("[REDACTED]");
		return result
			.replace(
				/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
				"[REDACTED PRIVATE KEY]",
			)
			.replace(/\b(?:Bearer|Basic)\s+[^\s\"',;]+/gi, "[REDACTED AUTHORIZATION]")
			.replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, "[REDACTED opaque value]")
			.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
			.split("\n")
			.map((line) => (sensitiveKey.test(line) ? "[REDACTED sensitive line]" : line))
			.join("\n");
	};
	const json = (value) => {
		if (typeof value === "string") return text(value);
		if (Array.isArray(value)) return value.map(json);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : json(item)]),
			);
		return value;
	};
	return { add, remember, text, json };
}

// Exclude requestedBy, instance identity and any future credential-bearing fields.
export function summarizeUpgradeJob(job) {
	if (!job || typeof job !== "object") return null;
	return Object.fromEntries(
		[
			"schemaVersion",
			"id",
			"state",
			"phase",
			"createdAt",
			"updatedAt",
			"startedAt",
			"finishedAt",
			"fromVersion",
			"fromBootId",
			"targetVersion",
			"version",
			"bootId",
			"error",
		]
			.filter((key) => ["string", "number"].includes(typeof job[key]))
			.map((key) => [key, job[key]]),
	);
}

// launchctl print includes inherited/default/service environments and potentially credentials.
// Only retain top-level runtime fields, never a raw print/list dump or the service configuration.
export function summarizeLaunchctl(output) {
	return output
		.split(/\r?\n/)
		.filter(
			(line) =>
				/^(?:\t| {4})(?:state|path|program|type|domain|pid|runs|last exit code|last terminating signal|reason|active count|execution context|spawn type|stdout path|stderr path) = /.test(
					line,
				) || /^\t"(?:PID|LastExitStatus|Label)" = /.test(line),
		)
		.join("\n");
}

export async function readLogTail(path, limit = DIAGNOSTIC_LIMIT) {
	let handle;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - limit);
		const buffer = Buffer.alloc(Math.min(size, limit));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
		// A partial first line may omit a sensitive field name. Never export that fragment.
		if (start) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
		return { text, truncated: start > 0, bytes: size };
	} finally {
		await handle?.close();
	}
}

export function diagnosticCommand(file, args, { timeout = 10_000, limit = DIAGNOSTIC_LIMIT } = {}) {
	return new Promise((done) => {
		let stdout = Buffer.alloc(0),
			stderr = Buffer.alloc(0),
			truncated = false;
		const append = (current, chunk) => {
			const next = Buffer.concat([current, chunk]);
			if (next.length > limit) truncated = true;
			return next.subarray(0, limit);
		};
		const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = append(stderr, chunk);
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeout);
		child.once("error", (error) => {
			clearTimeout(timer);
			done({ code: null, error: error.message });
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, signal, timedOut, truncated, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
		});
	});
}

export function submittedUpgradeJob({ status, body, persistedJob, previousJobId, expectedState }) {
	// Submission may return 503 when the worker fails before launchUpgradeJob observes "running".
	// Only the deliberately broken paths may accept that response, and only for a new failed job.
	const job =
		status === 202 && body.ok
			? body.job
			: expectedState === "failed" && status === 503 && persistedJob?.state === "failed"
				? persistedJob
				: undefined;
	if (!job || !/^[a-f0-9-]{36}$/.test(job.id) || job.id === previousJobId)
		throw new Error(
			`Browser upgrade submission HTTP ${status} did not create a new ${expectedState} job: ${typeof body.error === "string" ? body.error : "invalid or reused upgrade job"}`,
		);
	return summarizeUpgradeJob(job);
}

export async function observeUpgradeTerminal({
	jobId,
	expectedState,
	readJob,
	readConnection,
	onObservation = () => {},
	timeout = 10 * 60_000,
	now = Date.now,
	sleep = delay,
}) {
	if (!/^[a-f0-9-]{36}$/.test(jobId) || !["succeeded", "failed"].includes(expectedState))
		throw new Error("Invalid upgrade observation target");
	const deadline = now() + timeout;
	let job,
		connection = "";
	while (now() < deadline) {
		const current = await readJob();
		if (current?.id === jobId) {
			job = summarizeUpgradeJob(current);
			await onObservation({ job, connection });
			if (["failed", "succeeded"].includes(current.state) && current.state !== expectedState)
				throw new Error(
					`Hub upgrade ${jobId} unexpectedly ${current.state} in phase ${current.phase ?? "unknown"}: ${current.error || "no job error"}; last UI: ${connection}`,
				);
		}
		connection = await readConnection();
		await onObservation({ job, connection });
		if (current?.id === jobId) {
			if (expectedState === "succeeded" && connection.includes("升级失败"))
				throw new Error(
					`Hub upgrade ${jobId}: UI reports failure; job ${current.state}/${current.phase}: ${current.error || connection}`,
				);
			if (
				current.state === expectedState &&
				connection.includes(expectedState === "succeeded" ? "升级成功" : "升级失败")
			)
				return job;
		} else if (current && current.id !== jobId) {
			// An older job may be visible briefly; a later job must never satisfy this attempt.
			if (job) throw new Error(`Hub upgrade ${jobId} was replaced by ${current.id}`);
		}
		await sleep(250);
	}
	throw new Error(
		`Hub upgrade ${jobId} timed out waiting for ${expectedState}; last job ${job?.state ?? "not observed"}/${job?.phase ?? "unknown"}: ${job?.error || "no job error"}; UI: ${connection}`,
	);
}
