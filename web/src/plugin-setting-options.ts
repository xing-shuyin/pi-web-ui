import { THINKING_VALUES } from "./thinking-levels";
import type { UiSelectOption } from "./types";

export interface PluginSelectModel {
	provider: string;
	id: string;
	label: string;
}

export function pluginSelectValues(
	field: { options?: (string | UiSelectOption)[]; optionsFrom?: "models" | "thinkingLevels" },
	models: readonly PluginSelectModel[] = [],
	current?: unknown,
): string[] {
	const out: string[] = [];
	const push = (v: string): void => {
		if (!out.includes(v)) out.push(v);
	};
	if (field.optionsFrom) push("");
	for (const o of field.options ?? []) {
		const val = typeof o === "string" ? o : o.value;
		push(val);
	}
	if (field.optionsFrom === "models") {
		for (const m of models) push(`${m.provider}/${m.id}`);
	} else if (field.optionsFrom === "thinkingLevels") {
		for (const v of THINKING_VALUES) push(v);
	}
	const cur = typeof current === "string" ? current : current === undefined || current === null ? "" : String(current);
	if (cur) push(cur);
	return out;
}
