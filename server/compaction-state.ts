import { readFileSync, rmSync } from "node:fs";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface CompactionState {
	reason: string;
	startedAt: number;
}

type SessionFile = string | null | undefined;

function sidecar(file: SessionFile): string | undefined {
	return file ? `${file}.compaction-state.json` : undefined;
}

function isState(value: unknown): value is CompactionState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<CompactionState>;
	return (
		typeof state.reason === "string" &&
		state.reason.length > 0 &&
		typeof state.startedAt === "number" &&
		Number.isFinite(state.startedAt) &&
		state.startedAt >= 0
	);
}

export function mark(file: SessionFile, state: CompactionState): boolean {
	const path = sidecar(file);
	if (!path) return false;
	if (!isState(state)) throw new Error("Invalid compaction state");
	writeJsonAtomicSync(path, {
		version: 1,
		reason: state.reason,
		startedAt: state.startedAt,
	});
	return true;
}

export function finish(file: SessionFile): boolean {
	const path = sidecar(file);
	if (!path) return false;
	try {
		rmSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function consumeInterrupted(file: SessionFile): CompactionState | undefined {
	const path = sidecar(file);
	if (!path) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const state: unknown = JSON.parse(raw);
	if (!isState(state) || (state as CompactionState & { version?: unknown }).version !== 1) {
		throw new Error(`Invalid compaction state: ${path}`);
	}
	if (!finish(file)) return undefined;
	return { reason: state.reason, startedAt: state.startedAt };
}
