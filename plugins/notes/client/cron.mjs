const MONTH_NAMES = {
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
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseCronField(raw, min, max, names) {
	const src = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!src) return null;
	const out = new Set();
	const num = (tok) => {
		const t = String(tok ?? "").trim();
		if (!t) return null;
		if (names && t in names) return names[t];
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
			const every = num(step[1]);
			if (every === null || every <= 0) return null;
			let lo = min;
			let hi = max;
			if (step[0] !== "" && step[0] !== "*") {
				const range = step[0].split("-");
				if (range.length > 2) return null;
				const a = num(range[0]);
				if (a === null) return null;
				lo = a;
				if (range.length === 2) {
					const b = num(range[1]);
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
			const a = num(range[0]);
			const b = num(range[1]);
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

export function parseCron(spec) {
	const fields = String(spec ?? "")
		.trim()
		.split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0], 0, 59);
	const hour = parseCronField(fields[1], 0, 23);
	const dom = parseCronField(fields[2], 1, 31);
	const month = parseCronField(fields[3], 1, 12, MONTH_NAMES);
	const dow = parseCronField(fields[4], 0, 6, DOW_NAMES);
	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

function isFull(values, min, max) {
	return values.length === max - min + 1;
}

export function nextCronFire(parts, fromMs) {
	const p = typeof parts === "string" ? parseCron(parts) : parts;
	if (!p) return null;
	const from = Number(fromMs);
	if (!Number.isFinite(from)) return null;
	const startMs = Math.floor(from / 60000) * 60000 + 60000;
	const base = new Date(startMs);
	const hours = p.hour;
	const minutes = p.minute;
	const domRestricted = !isFull(p.dom, 1, 31);
	const dowRestricted = !isFull(p.dow, 0, 6);
	const domSet = new Set(p.dom);
	const dowSet = new Set(p.dow);
	const monthSet = new Set(p.month);
	for (let day = 0; day < 800; day++) {
		const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
		if (!monthSet.has(d.getMonth() + 1)) continue;
		const domHit = domSet.has(d.getDate());
		const dowHit = dowSet.has(d.getDay());
		const dayHit = domRestricted && dowRestricted ? domHit || dowHit : domHit && dowHit;
		if (!dayHit) continue;
		for (const h of hours) {
			for (const m of minutes) {
				const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
				if (at >= startMs) return at;
			}
		}
	}
	return null;
}

export function scheduleText(schedule) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return "（无效）";
	switch (s.type) {
		case "once":
			return `一次性 ${String(s.at ?? "").replace("T", " ")}`;
		case "daily":
			return `每天 ${s.time}`;
		case "weekly":
			return `每周 ${(Array.isArray(s.dow) ? s.dow : []).map((d) => "日一二三四五六"[d] ?? d).join("")} ${s.time}`;
		case "monthly":
			return `每月 ${s.dom} 日 ${s.time}`;
		case "every":
			return everyText(s.minutes);
		case "cron":
			return `cron ${s.spec}`;
		default:
			return "（无效）";
	}
}

export function everyText(minutes) {
	const n = Number(minutes);
	if (!Number.isFinite(n) || n <= 0) return "（无效）";
	if (n < 60) return `每 ${n} 分钟`;
	if (n % 1440 === 0) return `每 ${n / 1440} 天`;
	if (n % 60 === 0) return `每 ${n / 60} 小时`;
	return `每 ${Math.floor(n / 60)} 小时 ${n % 60} 分`;
}

const fireCache = new Map();
export function nextFire(spec, fromMs = Date.now()) {
	const key = `${spec}|${Math.floor(fromMs / 60000)}`;
	if (fireCache.has(key)) return fireCache.get(key);
	const at = nextCronFire(parseCron(spec), fromMs);
	if (fireCache.size > 500) fireCache.clear();
	fireCache.set(key, at);
	return at;
}

export function parseHM(raw) {
	const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(raw ?? ""));
	if (!m) return null;
	const h = Number(m[1]);
	const mi = Number(m[2]);
	if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
	return { h, m: mi };
}

const pad2 = (n) => String(n).padStart(2, "0");

export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 10_080;

export function isSupportedEvery(minutes) {
	const n = Number(minutes);
	return Number.isInteger(n) && n >= MIN_EVERY_MINUTES && n <= MAX_EVERY_MINUTES;
}

export function scheduleToCron(schedule) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return null;
	switch (s.type) {
		case "once": {
			const at = new Date(String(s.at ?? ""));
			if (Number.isNaN(at.getTime())) return null;
			return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
		}
		case "daily": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			return `${hm.m} ${hm.h} * * *`;
		}
		case "weekly": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			const dows = (Array.isArray(s.dow) ? s.dow : [])
				.map((x) => Number(x))
				.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
			if (!dows.length) return null;
			return `${hm.m} ${hm.h} * * ${[...new Set(dows)].sort().join(",")}`;
		}
		case "monthly": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			const dom = Number(s.dom);
			if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
			return `${hm.m} ${hm.h} ${dom} * *`;
		}
		case "every": {
			const n = Number(s.minutes);
			if (!isSupportedEvery(n)) return null;
			if (60 % n === 0 && n < 60) return `*/${n} * * * *`;
			if (n >= 60 && n % 60 === 0 && n / 60 <= 24) {
				const hours = n / 60;
				return hours === 24 ? "0 0 * * *" : hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
			}
			return null;
		}
		case "cron":
			return parseCron(s.spec) ? String(s.spec).trim().replace(/\s+/g, " ") : null;
		default:
			return null;
	}
}

export function nextScheduleFire(schedule, fromMs = Date.now()) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return null;
	if (s.type === "every") {
		if (!isSupportedEvery(s.minutes)) return null;
		return Number(fromMs) + Number(s.minutes) * 60_000;
	}
	const spec = scheduleToCron(s);
	if (!spec) return null;
	return nextFire(spec, fromMs);
}

export function occurrencesBetween(schedule, fromMs, toMs, limit = 200) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	const from = Number(fromMs);
	const to = Number(toMs);
	if (!s || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
	const out = [];
	if (s.type === "every") {
		if (!isSupportedEvery(s.minutes)) return [];
		const step = Number(s.minutes) * 60_000;
		for (let t = from; t < to && out.length < limit; t += step) out.push(t);
		return out;
	}
	let cursor = from - 1;
	for (let i = 0; i < limit; i++) {
		const at = nextScheduleFire(s, cursor);
		if (at === null || at >= to) break;
		out.push(at);
		cursor = at;
	}
	return out;
}

export function toLocalInput(ms) {
	const d = new Date(Number(ms) || 0);
	if (Number.isNaN(d.getTime())) return "";
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fromLocalInput(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T09:00:00`) : new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.getTime();
}
