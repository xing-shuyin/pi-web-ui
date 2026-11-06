import coreZh from "./messages/core/zh.json";
import coreEn from "./messages/core/en.json";
import canvasZh from "./messages/canvas/zh.json";
import canvasEn from "./messages/canvas/en.json";
import canvasRuntimeZh from "./messages/canvas-runtime/zh.json";
import canvasRuntimeEn from "./messages/canvas-runtime/en.json";
import nativeCliSessionZh from "./messages/native-cli-session/zh.json";
import nativeCliSessionEn from "./messages/native-cli-session/en.json";

interface MessageModule {
	name: string;
	zh: Readonly<Record<string, string>>;
	en: Readonly<Record<string, string>>;
}

type ModuleKey<T> = T extends MessageModule ? keyof T["zh"] : never;

function placeholders(value: string): string {
	return JSON.stringify(
		[...value.matchAll(/\$\{[\w$]+\}|\{\{[\w$]+\}\}|\{\$?[\w]+\}|\[\[[a-z_/-]+/g)].map((match) => match[0]).sort(),
	);
}

/** Merge built-in sources, retaining the literal key union used by Translate/useT. */
export function createCatalog<const T extends readonly MessageModule[]>(modules: T) {
	type Key = ModuleKey<T[number]>;
	const zh: Record<string, string> = Object.create(null);
	const en: Record<string, string> = Object.create(null);
	const owners = new Map<string, string>();
	for (const module of modules) {
		const keys = Object.keys(module.zh);
		const enKeys = Object.keys(module.en);
		if (keys.length !== enKeys.length || keys.some((key, index) => enKeys[index] !== key)) {
			throw new Error(`i18n ${module.name}: zh/en keys or order differ`);
		}
		for (const key of keys) {
			if (owners.has(key)) throw new Error(`i18n duplicate key ${key}: ${owners.get(key)} and ${module.name}`);
			if (
				typeof module.zh[key] !== "string" ||
				!module.zh[key] ||
				typeof module.en[key] !== "string" ||
				!module.en[key]
			) {
				throw new Error(`i18n ${module.name}: ${key} must be a nonempty string`);
			}
			if (placeholders(module.zh[key]) !== placeholders(module.en[key])) {
				throw new Error(`i18n ${module.name}: placeholder mismatch for ${key}`);
			}
			owners.set(key, module.name);
			zh[key] = module.zh[key];
			en[key] = module.en[key];
		}
	}
	return { zh: zh as Record<Key, string>, en: en as Record<Key, string> };
}

// Keep this list explicit: JSON imports preserve key types and bundle only built-in zh/en.
// Tooling discovers all modules through scripts/lib/i18n-catalog.mjs in the same order.
export const { zh, en } = createCatalog([
	{ name: "core", zh: coreZh, en: coreEn },
	{ name: "canvas", zh: canvasZh, en: canvasEn },
	{ name: "canvas-runtime", zh: canvasRuntimeZh, en: canvasRuntimeEn },
	{ name: "native-cli-session", zh: nativeCliSessionZh, en: nativeCliSessionEn },
]);

export type MessageKey = keyof typeof zh;
