import { useSyncExternalStore } from "react";

export const COST_CURRENCY_STORAGE_KEY = "pi-web-ui:cost-currency";
export const DEFAULT_COST_CURRENCY_SYMBOL = "$";

export interface CostDisplayParts {
	symbol: string;
	value: string;
	tooltip?: string;
}

export type CostFormatterResult = string | CostDisplayParts;

export type CostFormatter = (cost: number, ctx: { defaultSymbol: string; defaultValue: string }) => CostFormatterResult;

let customFormatter: CostFormatter | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
	version += 1;
	// oxlint-disable-next-line unicorn/no-useless-spread -- deliberate snapshot
	for (const fn of [...listeners]) {
		try {
			fn();
		} catch {}
	}
}

export function subscribeCostFormat(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshotVersion(): number {
	return version;
}

export function formatDefaultCostValue(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}

export function getCostCurrencySymbol(): string {
	try {
		if (typeof localStorage !== "undefined") {
			const raw = localStorage.getItem(COST_CURRENCY_STORAGE_KEY);
			if (typeof raw === "string" && raw.trim().length > 0) {
				return raw.trim().slice(0, 8);
			}
		}
	} catch {}
	return DEFAULT_COST_CURRENCY_SYMBOL;
}

export function setCostCurrencySymbol(symbol: string | null | undefined): void {
	try {
		if (typeof localStorage !== "undefined") {
			const trimmed = typeof symbol === "string" ? symbol.trim().slice(0, 8) : "";
			if (!trimmed || trimmed === DEFAULT_COST_CURRENCY_SYMBOL) {
				localStorage.removeItem(COST_CURRENCY_STORAGE_KEY);
			} else {
				localStorage.setItem(COST_CURRENCY_STORAGE_KEY, trimmed);
			}
		}
	} catch {}
	notify();
}

export function registerCostFormatter(formatter: CostFormatter | null): () => void {
	if (typeof formatter !== "function") {
		customFormatter = null;
		notify();
		return () => {};
	}
	customFormatter = formatter;
	notify();
	return () => {
		if (customFormatter === formatter) {
			customFormatter = null;
			notify();
		}
	};
}

function splitFormattedCostString(raw: string, fallbackSymbol: string): CostDisplayParts {
	const text = String(raw ?? "").trim();
	if (!text) return { symbol: fallbackSymbol, value: "0" };
	const m = text.match(/^([^\d<>+-]+)\s*(.+)$/);
	if (m) {
		return { symbol: m[1], value: m[2] };
	}
	return { symbol: "", value: text };
}

export function formatCostDisplay(cost: number, opts?: { fixedDigits?: number }): CostDisplayParts {
	const safeCost = typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
	const defaultSymbol = getCostCurrencySymbol();
	const defaultValue =
		typeof opts?.fixedDigits === "number" ? safeCost.toFixed(opts.fixedDigits) : formatDefaultCostValue(safeCost);

	if (customFormatter) {
		try {
			const out = customFormatter(safeCost, { defaultSymbol, defaultValue });
			if (typeof out === "string") {
				return splitFormattedCostString(out, defaultSymbol);
			}
			if (out && typeof out === "object" && typeof out.value === "string") {
				return {
					symbol: typeof out.symbol === "string" ? out.symbol : defaultSymbol,
					value: out.value,
					tooltip: typeof out.tooltip === "string" ? out.tooltip : undefined,
				};
			}
		} catch (err) {
			console.error("[cost-format] custom cost formatter threw:", err);
		}
	}

	return { symbol: defaultSymbol, value: defaultValue };
}

export function useFormattedCost(cost: number, opts?: { fixedDigits?: number }): CostDisplayParts {
	useSyncExternalStore(subscribeCostFormat, getSnapshotVersion, getSnapshotVersion);
	return formatCostDisplay(cost, opts);
}
