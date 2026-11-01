import { createHash } from "node:crypto";
import { checkedUrl } from "./relay.js";
import type { TaskReportMeta } from "./task-report.js";
import type { TaskReportUploadEntry } from "./task-report-outbox.js";

/** 16 KiB raw text remains below the authenticated 128 KiB JSON budget even after escaping. */
export async function uploadTaskReport(options: {
	hubUrl: string;
	deviceId: string;
	credential: string;
	entry: TaskReportUploadEntry;
	text: string;
	signal?: AbortSignal;
}): Promise<void> {
	const { entry } = options;
	const bytes = Buffer.from(options.text, "utf8");
	if (bytes.length !== entry.totalBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
		throw new Error("Full report integrity mismatch before upload");
	const chunks: string[] = [];
	for (let start = 0; start < bytes.length;) {
		let end = Math.min(start + 16 * 1024, bytes.length);
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		chunks.push(bytes.subarray(start, end).toString("utf8"));
		start = end;
	}
	if (!chunks.length) chunks.push("");
	let receipt: TaskReportMeta | undefined;
	for (let index = 0; index < chunks.length; index++) {
		const text = chunks[index];
		const res = await fetch(
			`${checkedUrl(options.hubUrl).href.replace(/\/$/, "")}/api/agent/rooms/${encodeURIComponent(entry.roomId)}/tasks/${encodeURIComponent(entry.id)}/report`,
			{
				method: "POST",
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					"X-Device-Id": options.deviceId,
					Authorization: `Bearer ${options.credential}`,
				},
				body: JSON.stringify({
					taskId: entry.id,
					attemptId: entry.attemptId,
					botId: entry.botId,
					chunkIndex: index,
					totalChunks: chunks.length,
					text,
					isFinal: index === chunks.length - 1,
					sha256: createHash("sha256").update(text).digest("hex"),
					fullSha256: entry.sha256,
					totalBytes: entry.totalBytes,
				}),
				signal: options.signal
					? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
					: AbortSignal.timeout(15000),
			},
		);
		if (!res.ok) throw new Error(`Report upload rejected: HTTP ${res.status}`);
		const body = (await res.json()) as { meta?: TaskReportMeta };
		receipt = body.meta;
		if (
			!receipt ||
			receipt.taskId !== entry.id ||
			receipt.attemptId !== entry.attemptId ||
			receipt.roomId !== entry.roomId ||
			receipt.rejected ||
			receipt.quotaExceeded
		)
			throw new Error("Report upload receipt binding mismatch");
	}
	if (
		!receipt?.complete ||
		receipt.sha256 !== entry.sha256 ||
		receipt.totalBytes !== bytes.length ||
		receipt.receivedChunks !== chunks.length
	)
		throw new Error("Hub did not acknowledge the complete report hash and byte count");
}
