import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";

export interface SdkExtensionFactoryEntry {
	name: string;
	factory: (pi: any) => void | Promise<void>;
	builtin?: boolean;
	replaceable?: boolean;
	hidden?: boolean;
}

let cachedEntries: SdkExtensionFactoryEntry[] | null = null;

export function resolveSdkExtensionsIndexPath(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const candidate = join(dirname(entry), "extensions", "index.js");
		if (existsSync(candidate)) return candidate;
	} catch {}
	return null;
}

export async function getSdkBuiltinExtensionFactories(): Promise<SdkExtensionFactoryEntry[]> {
	if (cachedEntries) return cachedEntries;

	const factories: SdkExtensionFactoryEntry[] = [];
	const indexPath = resolveSdkExtensionsIndexPath();

	if (indexPath) {
		try {
			const mod = (await import(pathToFileURL(indexPath).href)) as {
				builtInExtensions?: Array<{
					name: string;
					factory: (pi: any) => void | Promise<void>;
					builtin?: boolean;
					replaceable?: boolean;
				}>;
			};

			if (Array.isArray(mod.builtInExtensions)) {
				for (const ext of mod.builtInExtensions) {
					if (ext.name === "mcp") continue;

					factories.push({
						name: ext.name,
						factory: ext.factory,
						builtin: ext.builtin ?? true,
						replaceable: ext.replaceable ?? false,
						hidden: true,
					});
				}
			}
		} catch {}
	}

	if (factories.length === 0) {
		factories.push(
			{
				name: "codemode",
				hidden: true,
				replaceable: true,
				builtin: true,
				factory: createCodemodeExtension(),
			},
			{
				name: "tool-search",
				hidden: true,
				replaceable: true,
				builtin: true,
				factory: createToolSearchExtension(),
			},
		);
	}

	cachedEntries = factories;
	return factories;
}

export const SDK_DISABLED_BUILTIN_EXTENSIONS: string[] = ["mcp"];
