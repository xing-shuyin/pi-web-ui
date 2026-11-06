import type { UiPresetPluginDependency, UiPluginInfo, UiPluginCatalogEntry } from "./types";
import type { PluginJobState } from "./use-chat";
import { portablePresetPluginSource } from "../../server/preset-plugin-dependencies.js";

export function presetPluginDependency(
	plugin: UiPresetPluginDependency,
	catalog: readonly UiPluginCatalogEntry[],
): UiPresetPluginDependency | undefined {
	const source = portablePresetPluginSource(plugin.source ?? catalog.find((entry) => entry.id === plugin.id)?.source);
	if (!source) return undefined;
	return { id: plugin.id, name: plugin.name, version: plugin.version, source };
}

export function presetPluginStatus(
	dependency: UiPresetPluginDependency,
	installed: readonly UiPluginInfo[],
	disabledPlugins: readonly string[] = [],
) {
	const plugin = installed.find((entry) => entry.id === dependency.id);
	return {
		plugin,
		missing: !plugin,
		disabled: !!plugin && disabledPlugins.includes(plugin.id),
		versionMismatch: !!plugin && !!dependency.version && plugin.version !== dependency.version,
	};
}

export function pendingPresetPluginJob(id: string, jobs: Record<string, PluginJobState>) {
	return Object.values(jobs).find((job) => job.pluginId === id && job.phase !== "done");
}

export function clearsPresetField(value: unknown): boolean {
	return !!value && typeof value === "object" && Object.keys(value).length === 0;
}
