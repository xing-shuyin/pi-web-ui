import { existsSync, mkdirSync, statSync, renameSync, unlinkSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ApprovalAuditEntry {
	id: string;
	timestamp: number;
	isoTime: string;
	conversationId?: string;
	toolName: string;
	params?: unknown;
	decision: "approved" | "denied" | "edited";
	decisionSource:
		| "user_dialog"
		| "suppressed_category"
		| "suppressed_all"
		| "suppressed_disabled"
		| "rule_denied"
		| "batch_approved_policy"
		| "batch_approved_disabled";
	scope?: "once" | "category" | "all";
	userEdited?: boolean;
	ruleId?: string;
	categoryId?: string;
	reason?: string;
}

export type ToolAuditRecordFn = (entry: Omit<ApprovalAuditEntry, "id" | "timestamp" | "isoTime">) => void;

const MAX_AUDIT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_BACKUP_FILES = 3;

export function sanitizeAuditParams(params: unknown): unknown {
	if (params === null || params === undefined) return params;
	if (typeof params === "string") {
		return params.length > 1024 ? `${params.slice(0, 1024)}... [truncated ${params.length} chars]` : params;
	}
	if (typeof params !== "object") return params;
	if (Array.isArray(params)) {
		return params.slice(0, 20).map(sanitizeAuditParams);
	}
	const obj = params as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = sanitizeAuditParams(v);
	}
	return out;
}

export class ApprovalAuditLogger {
	private readonly logPath: string;
	private seq = 0;

	constructor(dataDir: string) {
		this.logPath = join(dataDir, "audit", "approvals.jsonl");
	}

	getFilePath(): string {
		return this.logPath;
	}

	record(entry: Omit<ApprovalAuditEntry, "id" | "timestamp" | "isoTime">): void {
		try {
			const now = Date.now();
			const fullEntry: ApprovalAuditEntry = {
				id: `audit-${now}-${++this.seq}`,
				timestamp: now,
				isoTime: new Date(now).toISOString(),
				...entry,
				params: sanitizeAuditParams(entry.params),
			};

			this.rotateIfNeeded();
			const dir = dirname(this.logPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			appendFileSync(this.logPath, JSON.stringify(fullEntry) + "\n", "utf8");
		} catch (err) {
			console.warn("[approval-audit] Failed to write audit log:", err);
		}
	}

	private rotateIfNeeded(): void {
		if (!existsSync(this.logPath)) return;
		try {
			const stat = statSync(this.logPath);
			if (stat.size < MAX_AUDIT_FILE_SIZE) return;

			for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
				const src = this.logPath.replace(/\.jsonl$/, `.${i}.jsonl`);
				const dst = this.logPath.replace(/\.jsonl$/, `.${i + 1}.jsonl`);
				if (existsSync(src)) {
					if (i === MAX_BACKUP_FILES - 1 && existsSync(dst)) {
						unlinkSync(dst);
					}
					renameSync(src, dst);
				}
			}
			const firstBackup = this.logPath.replace(/\.jsonl$/, ".1.jsonl");
			if (existsSync(firstBackup)) unlinkSync(firstBackup);
			renameSync(this.logPath, firstBackup);
		} catch (err) {
			console.warn("[approval-audit] Log rotation failed:", err);
		}
	}

	readRecentEntries(limit = 100): ApprovalAuditEntry[] {
		if (!existsSync(this.logPath)) return [];
		try {
			const content = readFileSync(this.logPath, "utf8");
			const lines = content.trim().split("\n").filter(Boolean);
			const out: ApprovalAuditEntry[] = [];
			for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
				try {
					out.push(JSON.parse(lines[i]));
				} catch {}
			}
			return out;
		} catch {
			return [];
		}
	}
}
