import type { UiPluginInfo } from "./types.js";

export type PluginPhase = "active" | "disabled" | "failed" | "idle";

export function pluginPhase(p: Pick<UiPluginInfo, "error" | "active">, disabled: boolean): PluginPhase {
	if (p.error) return "failed";
	if (disabled) return "disabled";
	if (p.active === true) return "active";
	return "idle";
}

export function countPluginPhases(
	plugins: Pick<UiPluginInfo, "id" | "error" | "active">[],
	disabledIds: ReadonlySet<string>,
): Record<PluginPhase, number> {
	const out: Record<PluginPhase, number> = { active: 0, disabled: 0, failed: 0, idle: 0 };
	for (const p of plugins) out[pluginPhase(p, disabledIds.has(p.id))] += 1;
	return out;
}
