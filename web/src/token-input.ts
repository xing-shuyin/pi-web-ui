export function parseTokenInput(v: unknown): number {
	if (v === null || v === undefined) return 0;
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v <= 0) return 0;
		const n = Math.floor(v);
		if (n <= 1000) return n * 1000;
		return Math.min(10_000_000, n);
	}
	const s = String(v)
		.trim()
		.toLowerCase()
		.replace(/[,_\s]/g, "");
	if (!s) return 0;
	const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!m) return 0;
	const num = parseFloat(m[1]);
	if (!Number.isFinite(num) || num <= 0) return 0;
	const unit = m[2];
	let tokens: number;
	if (unit === "k") {
		tokens = Math.floor(num * 1_000);
	} else if (unit === "m") {
		tokens = Math.floor(num * 1_000_000);
	} else {
		tokens = Math.floor(num);
		if (tokens <= 1000) tokens *= 1000;
	}
	return Math.min(10_000_000, Math.max(0, tokens));
}

export function formatTokenDraft(n: number | null | undefined): string {
	if (!n || n <= 0 || !Number.isFinite(n)) return "";
	if (n >= 1_000_000 && n % 100_000 === 0) {
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000 && n % 1_000 === 0) {
		return `${n / 1_000}k`;
	}
	return String(n);
}
