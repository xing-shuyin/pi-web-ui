export const BUILTIN_MODULE_IDS = ["superagent"] as const;

export function isBuiltinModule(id: string): boolean {
	return BUILTIN_MODULE_IDS.some((moduleId) => moduleId === id);
}

export function excludeBuiltinModules<T extends { id: string }>(entries: readonly T[]): T[] {
	return entries.filter((entry) => !isBuiltinModule(entry.id));
}
