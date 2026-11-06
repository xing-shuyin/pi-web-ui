import type { UiPluginFileHandler, UiPluginInfo } from "./types";
import { loadPluginBundleModule, type PluginFileHandler, type PluginFileHandlerModule } from "./plugin-loader";

export type FileHandlerDeclaration = UiPluginFileHandler;

export type FileHandlerPlugin = UiPluginInfo & { fileHandlers?: FileHandlerDeclaration[] };

interface RegisteredFileHandler {
	plugin: FileHandlerPlugin;
	declaration: FileHandlerDeclaration;
}

let registry = new Map<string, RegisteredFileHandler[]>();
let epoch = -1;

function normalizeExtension(value: string): string {
	const ext = value.trim().toLowerCase();
	return ext.startsWith(".") ? ext : `.${ext}`;
}

export function fileExtension(name: string): string {
	const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
	const i = base.lastIndexOf(".");
	return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function syncFileHandlers(plugins: UiPluginInfo[], nextEpoch: number): void {
	if (epoch !== nextEpoch) epoch = nextEpoch;
	const next = new Map<string, RegisteredFileHandler[]>();
	for (const raw of plugins) {
		const plugin = raw as FileHandlerPlugin;
		if (plugin.error || !plugin.hasClient || !Array.isArray(plugin.fileHandlers)) continue;
		for (const declaration of plugin.fileHandlers) {
			if (!declaration || !declaration.id || !Array.isArray(declaration.extensions)) continue;
			for (const rawExt of declaration.extensions) {
				if (typeof rawExt !== "string") continue;
				const ext = normalizeExtension(rawExt);
				if (!/^\.[a-z0-9][a-z0-9._-]*$/.test(ext)) continue;
				const rows = next.get(ext) ?? [];
				rows.push({ plugin, declaration });
				next.set(ext, rows);
			}
		}
	}
	for (const rows of next.values()) {
		rows.sort((a, b) => b.declaration.priority - a.declaration.priority || a.plugin.id.localeCompare(b.plugin.id));
	}
	registry = next;
}

export function findFileHandler(name: string): RegisteredFileHandler | null {
	return registry.get(fileExtension(name))?.[0] ?? null;
}

export async function loadFileHandler(
	entry: RegisteredFileHandler,
): Promise<{ handler: PluginFileHandler; pluginId: string } | null> {
	const mod = await loadPluginBundleModule(entry.plugin, epoch);
	if (!mod) return null;
	const handlers = mod.fileHandlers;
	let candidate: PluginFileHandler | undefined;
	if (Array.isArray(handlers)) {
		candidate = handlers.find((x) => x && x.id === entry.declaration.id);
		if (!candidate && handlers.length === 1 && typeof handlers[0]?.mount === "function") {
			candidate = handlers[0];
		}
	} else if (handlers && typeof handlers === "object") {
		candidate = (handlers as Record<string, PluginFileHandler>)[entry.declaration.id];
		const values = Object.values(handlers as Record<string, PluginFileHandler>);
		if (!candidate && values.length === 1 && typeof values[0]?.mount === "function") {
			candidate = values[0];
		}
	}
	if (!candidate || typeof candidate.mount !== "function") return null;
	return { handler: candidate, pluginId: entry.plugin.id };
}

export type { PluginFileHandler, PluginFileHandlerModule };
