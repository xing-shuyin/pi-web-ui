import { promises as fsPromises, statSync } from "node:fs";
import {
	healthyRepairResult,
	isTranscriptHealthyCached,
	rememberHealthyTranscriptSig,
	repairSessionFileFromText,
	type SessionFileRepair,
} from "./compaction-markers.js";
import {
	forgetHealthyDangling,
	healDanglingToolCallsInText,
	isDanglingHealthyCached,
	rememberHealthyDangling,
	type DanglingCause,
} from "./dangling-tools.js";

export interface PreparedTranscript {
	repair: SessionFileRepair | null;
	healed: number;
	read: boolean;
}

function sigOf(st: { mtimeMs: number; size: number }): string {
	return `${st.mtimeMs}:${st.size}`;
}

export async function prepareTranscriptForOpen(
	filePath: string,
	cause: DanglingCause = "generic",
): Promise<PreparedTranscript> {
	let sig: string;
	try {
		sig = sigOf(await fsPromises.stat(filePath));
	} catch {
		return { repair: null, healed: 0, read: false };
	}
	const repairHealthy = isTranscriptHealthyCached(filePath, sig);
	const danglingHealthy = isDanglingHealthyCached(filePath, sig);
	if (repairHealthy && danglingHealthy) {
		return { repair: healthyRepairResult(filePath), healed: 0, read: false };
	}

	let raw: string;
	try {
		raw = await fsPromises.readFile(filePath, "utf8");
	} catch {
		return { repair: null, healed: 0, read: false };
	}

	const repair = repairHealthy ? healthyRepairResult(filePath) : repairSessionFileFromText(filePath, raw);
	if (!repair) return { repair: null, healed: 0, read: true };
	if (repair.changed) {
		forgetHealthyDangling(filePath);
		return { repair, healed: 0, read: true };
	}

	let healed = 0;
	if (!danglingHealthy) {
		try {
			healed = healDanglingToolCallsInText(filePath, raw, cause);
		} catch {
			healed = 0;
		}
	}

	if (healed >= 0) {
		try {
			const finalSig = healed > 0 ? sigOf(statSync(filePath)) : sig;
			rememberHealthyDangling(filePath, finalSig);
			rememberHealthyTranscriptSig(filePath, finalSig);
		} catch {}
	} else {
		forgetHealthyDangling(filePath);
	}
	return { repair, healed, read: true };
}
