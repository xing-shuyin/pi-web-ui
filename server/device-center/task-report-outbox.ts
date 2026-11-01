import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { createTaskReportStore, MAX_TASK_FULL_REPORT_BYTES, type TaskReportMeta } from "./task-report.js";
import { checkedUrl } from "./relay.js";

export interface ReportTaskBinding {
	id: string;
	attemptId: string;
	roomId: string;
	botId: string;
	botRevision?: number;
}
export interface TaskReportUploadEntry extends ReportTaskBinding {
	reportRef?: string;
	sha256?: string;
	totalBytes: number;
	uploadPending: boolean;
	missing: boolean;
	rejected: boolean;
	lastError?: string;
}
export const REPORT_OUTBOX_MAX_ENTRIES = 128;
export const REPORT_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
const ACCEPTED_RETENTION = 32;
const errors = new Set(["Report exceeds 4 MiB quota", "Executor supplied no full report", "Report upload pending"]);
const bindingKeys = ["id", "attemptId", "roomId", "botId"] as const;
function binding(task: ReportTaskBinding): ReportTaskBinding {
	for (const field of bindingKeys)
		if (typeof task[field] !== "string" || !task[field] || task[field].length > 256)
			throw new Error("Invalid report binding");
	if (task.botRevision !== undefined && (!Number.isSafeInteger(task.botRevision) || task.botRevision < 1))
		throw new Error("Invalid report Bot revision");
	return {
		id: task.id,
		attemptId: task.attemptId,
		roomId: task.roomId,
		botId: task.botId,
		...(task.botRevision ? { botRevision: task.botRevision } : {}),
	};
}
function validEntry(value: unknown): value is TaskReportUploadEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const e = value as TaskReportUploadEntry;
	try {
		binding(e);
	} catch {
		return false;
	}
	const allowed = new Set([
		...bindingKeys,
		"botRevision",
		"reportRef",
		"sha256",
		"totalBytes",
		"uploadPending",
		"missing",
		"rejected",
		"lastError",
	]);
	return (
		Object.keys(e).every((key) => allowed.has(key)) &&
		Number.isSafeInteger(e.totalBytes) &&
		e.totalBytes >= 0 &&
		["uploadPending", "missing", "rejected"].every(
			(key) => typeof e[key as keyof TaskReportUploadEntry] === "boolean",
		) &&
		(e.sha256 === undefined || /^[a-f0-9]{64}$/.test(e.sha256)) &&
		(e.reportRef === undefined || /^[a-f0-9]{32,64}$/.test(e.reportRef)) &&
		(e.lastError === undefined || errors.has(e.lastError)) &&
		(!e.uploadPending || (!e.rejected && !!e.sha256 && e.totalBytes <= MAX_TASK_FULL_REPORT_BYTES)) &&
		(e.rejected || e.missing || (!!e.sha256 && !!e.reportRef))
	);
}

/** Separate from terminal-result ACKs: a result never acknowledges report bytes. */
export function createTaskReportOutbox(dataDir: string | undefined, deviceId: string, hubUrl = "") {
	const scope = { deviceId, hubUrl: hubUrl ? checkedUrl(hubUrl).href.replace(/\/$/, "") : "" };
	const scopeKey = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 32);
	// Scope both the queue and report bytes, so rebinding never replays another Hub's reports.
	const scopedDir = dataDir ? join(dataDir, "task-report-outboxes", scopeKey) : undefined;
	const store = scopedDir ? createTaskReportStore(scopedDir, "device") : undefined;
	const file = scopedDir ? join(scopedDir, "outbox.json") : undefined;
	let entries: TaskReportUploadEntry[] = [];
	const memory = new Map<string, string>();
	const key = (task: ReportTaskBinding) => `${task.id}:${task.attemptId}`;
	const bytes = (items: TaskReportUploadEntry[]) => items.reduce((sum, e) => sum + (e.rejected ? 0 : e.totalBytes), 0);
	if (file) {
		try {
			const document = JSON.parse(readFileSync(file, "utf8"));
			if (
				document.version !== 1 ||
				document.deviceId !== scope.deviceId ||
				document.hubUrl !== scope.hubUrl ||
				!Array.isArray(document.entries) ||
				!document.entries.every(validEntry) ||
				document.entries.length > REPORT_OUTBOX_MAX_ENTRIES ||
				bytes(document.entries) > REPORT_OUTBOX_MAX_BYTES ||
				new Set(document.entries.map(key)).size !== document.entries.length
			)
				throw new Error("Invalid report outbox");
			entries = document.entries;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	function update(entry: TaskReportUploadEntry) {
		if (!validEntry(entry)) throw new Error("Invalid report outbox entry");
		const next = entries.filter((e) => key(e) !== key(entry)).concat(entry);
		const removable = next.filter((e) => !e.uploadPending && !e.missing && !e.rejected && key(e) !== key(entry));
		const removed: TaskReportUploadEntry[] = [];
		while (
			removable.length &&
			(next.length > REPORT_OUTBOX_MAX_ENTRIES ||
				bytes(next) > REPORT_OUTBOX_MAX_BYTES ||
				next.filter((e) => !e.uploadPending && !e.missing && !e.rejected).length > ACCEPTED_RETENTION)
		) {
			const old = removable.shift()!;
			next.splice(next.indexOf(old), 1);
			removed.push(old);
		}
		if (next.length > REPORT_OUTBOX_MAX_ENTRIES || bytes(next) > REPORT_OUTBOX_MAX_BYTES)
			throw new Error("Report outbox capacity exceeded; pending reports retained");
		// Delete bytes before dropping their registry entry; a failed cleanup stays discoverable.
		for (const old of removed) {
			store?.removeReport(old.id, old.attemptId, deviceId, old.roomId);
			memory.delete(key(old));
		}
		if (file) writeJsonAtomicSync(file, { version: 1, ...scope, entries: next });
		entries = next;
		return { ...entry };
	}
	return {
		capture(taskInput: ReportTaskBinding, text: string): TaskReportUploadEntry {
			const task = binding(taskInput);
			let meta: TaskReportMeta | undefined;
			const totalBytes = Buffer.byteLength(text);
			const sha256 = createHash("sha256").update(text).digest("hex");
			const previous = entries.find((e) => key(e) === key(task));
			if (
				previous &&
				(previous.roomId !== task.roomId ||
					previous.botId !== task.botId ||
					previous.botRevision !== task.botRevision ||
					(previous.sha256 && previous.sha256 !== sha256))
			)
				throw new Error("Report attempt content or binding conflict");
			if (previous && previous.sha256 === sha256 && !previous.missing) return { ...previous };
			if (totalBytes > MAX_TASK_FULL_REPORT_BYTES)
				return update({
					...task,
					sha256,
					totalBytes,
					uploadPending: false,
					missing: true,
					rejected: true,
					lastError: "Report exceeds 4 MiB quota",
				});
			// Commit intent first; recovery can read the store if interrupted after its atomic write.
			update({
				...task,
				reportRef: store
					? createHash("sha256").update(`${task.id}:${task.attemptId}`).digest("hex").slice(0, 32)
					: sha256,
				sha256,
				totalBytes,
				uploadPending: true,
				missing: true,
				rejected: false,
			});
			meta = store?.saveFullReport(task.id, task.attemptId, task.roomId, deviceId, text);
			if (!store) memory.set(key(task), text);
			return update({
				...task,
				reportRef: meta?.storageLocation.reportRef ?? sha256,
				sha256,
				totalBytes,
				uploadPending: true,
				missing: false,
				rejected: false,
			});
		},
		get(task: ReportTaskBinding) {
			const entry = entries.find((e) => key(e) === key(task));
			return entry ? { ...entry } : undefined;
		},
		markMissing(taskInput: ReportTaskBinding) {
			const task = binding(taskInput);
			const previous = entries.find((e) => key(e) === key(task));
			return previous
				? { ...previous }
				: update({
						...task,
						totalBytes: 0,
						uploadPending: false,
						missing: true,
						rejected: false,
						lastError: "Executor supplied no full report",
					});
		},
		pending() {
			return entries.filter((e) => e.uploadPending && !e.rejected).map((e) => ({ ...e }));
		},
		read(entry: TaskReportUploadEntry): string {
			let text = memory.get(key(entry));
			if (store) {
				let offset = 0;
				const parts: string[] = [];
				do {
					const page = store.getReport(entry.id, entry.attemptId, deviceId, entry.roomId, { offset, limit: 262144 });
					if (!page || page.text === undefined) throw new Error("Local full report missing");
					parts.push(page.text);
					if (!page.hasMore) break;
					if (!page.nextOffset || page.nextOffset <= offset) throw new Error("Invalid local report pagination");
					offset = page.nextOffset;
				} while (offset < entry.totalBytes);
				text = parts.join("");
			}
			if (
				text === undefined ||
				Buffer.byteLength(text) !== entry.totalBytes ||
				createHash("sha256").update(text).digest("hex") !== entry.sha256
			)
				throw new Error("Local full report is missing or failed integrity verification");
			return text;
		},
		accepted(entry: TaskReportUploadEntry) {
			return update({ ...entry, uploadPending: false, missing: false, lastError: undefined });
		},
		failed(entry: TaskReportUploadEntry, _error: unknown) {
			return update({ ...entry, uploadPending: true, lastError: "Report upload pending" });
		},
	};
}
export type TaskReportOutbox = ReturnType<typeof createTaskReportOutbox>;
