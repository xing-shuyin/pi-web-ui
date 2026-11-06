import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface CronParts {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	dow: number[];
}

const MONTH_NAMES: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};
const DOW_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

export function parseCronField(raw: string, min: number, max: number, names?: Record<string, number>): number[] | null {
	const src = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!src) return null;
	const out = new Set<number>();
	const num = (tok: string): number | null => {
		const t = tok.trim();
		if (!t) return null;
		if (names && t in names) return names[t]!;
		if (!/^\d+$/.test(t)) return null;
		let n = Number(t);
		if (n === 7 && min === 0 && max === 6) n = 0;
		if (!Number.isInteger(n) || n < min || n > max) return null;
		return n;
	};
	for (const part of src.split(",")) {
		const p = part.trim();
		if (!p) return null;
		const step = p.split("/");
		if (step.length === 2) {
			const every = num(step[1]!);
			if (every === null || every <= 0) return null;
			let lo = min;
			let hi = max;
			if (step[0] !== "" && step[0] !== "*") {
				const range = step[0]!.split("-");
				if (range.length > 2) return null;
				const a = num(range[0]!);
				if (a === null) return null;
				lo = a;
				if (range.length === 2) {
					const b = num(range[1]!);
					if (b === null || b < a) return null;
					hi = b;
				}
			}
			for (let v = lo; v <= hi; v += every) out.add(v);
			continue;
		}
		if (step.length > 2) return null;
		if (p === "*") {
			for (let v = min; v <= max; v++) out.add(v);
			continue;
		}
		if (p.includes("-")) {
			const range = p.split("-");
			if (range.length !== 2) return null;
			const a = num(range[0]!);
			const b = num(range[1]!);
			if (a === null || b === null || b < a) return null;
			for (let v = a; v <= b; v++) out.add(v);
			continue;
		}
		const n = num(p);
		if (n === null) return null;
		out.add(n);
	}
	if (out.size === 0) return null;
	return [...out].sort((a, b) => a - b);
}

export function parseCronSpec(spec: string): CronParts | null {
	const fields = String(spec ?? "")
		.trim()
		.split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0]!, 0, 59);
	const hour = parseCronField(fields[1]!, 0, 23);
	const dom = parseCronField(fields[2]!, 1, 31);
	const month = parseCronField(fields[3]!, 1, 12, MONTH_NAMES);
	const dow = parseCronField(fields[4]!, 0, 6, DOW_NAMES);
	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

function isFull(values: number[], min: number, max: number): boolean {
	return values.length === max - min + 1;
}

export function nextCronFire(parts: CronParts, fromMs: number): number | null {
	const minuteSet = new Set(parts.minute);
	const hourSet = new Set(parts.hour);
	const monthSet = new Set(parts.month);
	const domRestricted = !isFull(parts.dom, 1, 31);
	const dowRestricted = !isFull(parts.dow, 0, 6);
	const domSet = new Set(parts.dom);
	const dowSet = new Set(parts.dow);
	let t = Math.floor(Number(fromMs) / 60000) * 60000 + 60000;
	const limit = t + 366 * 24 * 60 * 60000;
	for (; t <= limit; t += 60000) {
		const d = new Date(t);
		if (!monthSet.has(d.getMonth() + 1)) continue;
		const domHit = domSet.has(d.getDate());
		const dowHit = dowSet.has(d.getDay());
		const dayHit =
			domRestricted && dowRestricted ? domHit || dowHit : domRestricted ? domHit : dowRestricted ? dowHit : true;
		if (!dayHit) continue;
		if (!hourSet.has(d.getHours())) continue;
		if (!minuteSet.has(d.getMinutes())) continue;
		return t;
	}
	return null;
}

export const MAX_TIMEOUT_MS = 2_147_483_647;

export function armDelay(nextAtMs: number, nowMs: number, maxChunkMs = 6 * 60 * 60 * 1000): number {
	const raw = Math.max(0, Number(nextAtMs) - Number(nowMs));
	if (!Number.isFinite(raw)) return 0;
	return Math.min(raw, Math.max(1, Math.min(maxChunkMs, MAX_TIMEOUT_MS)));
}

export interface PersistentScheduleRecord {
	spec: string;
	catchUp: "skip" | "once";
	label?: string;
	lastRun?: number;
	createdAt: number;
}

export function scheduleFile(pluginDir: string): string {
	return join(pluginDir, "schedules.json");
}

export function loadScheduleRecords(pluginDir: string): Record<string, PersistentScheduleRecord> {
	try {
		const parsed = JSON.parse(readFileSync(scheduleFile(pluginDir), "utf8")) as {
			v?: unknown;
			schedules?: unknown;
		};
		if (!parsed || typeof parsed !== "object" || parsed.schedules === null || typeof parsed.schedules !== "object") {
			return {};
		}
		const out: Record<string, PersistentScheduleRecord> = {};
		for (const [id, r] of Object.entries(parsed.schedules as Record<string, unknown>)) {
			if (!r || typeof r !== "object") continue;
			const rec = r as Record<string, unknown>;
			if (typeof rec.spec !== "string" || !rec.spec) continue;
			out[id] = {
				spec: rec.spec,
				catchUp: rec.catchUp === "once" ? "once" : "skip",
				...(typeof rec.label === "string" && rec.label ? { label: rec.label } : {}),
				...(typeof rec.lastRun === "number" && Number.isFinite(rec.lastRun) ? { lastRun: rec.lastRun } : {}),
				createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
			};
		}
		return out;
	} catch {
		return {};
	}
}

export function saveScheduleRecords(pluginDir: string, records: Record<string, PersistentScheduleRecord>): void {
	try {
		writeJsonAtomicSync(scheduleFile(pluginDir), { v: 1, schedules: records });
	} catch (err) {
		console.error(`[plugin-schedule] persist failed (${pluginDir}):`, err);
	}
}
