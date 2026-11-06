export interface PromptBaseRecord {
	system: string;
	append: readonly string[];
}

const EMPTY: PromptBaseRecord = { system: "", append: [] };

const store = new WeakMap<object, PromptBaseRecord>();

function writeRecord(loader: object | undefined, record: { system?: unknown; append?: unknown }): void {
	if (!loader) return;
	store.set(loader, {
		system: typeof record.system === "string" ? record.system : "",
		append: Array.isArray(record.append) ? (record.append as string[]).slice() : [],
	});
}

export function readPromptBase(loader: object | undefined): PromptBaseRecord {
	if (!loader) return EMPTY;
	return store.get(loader) ?? EMPTY;
}

export function recordPromptBaseLoader(loader: object | undefined, record: PromptBaseRecord): void {
	writeRecord(loader, record);
}

export interface PromptBaseObservers {
	systemPromptOverride: (base?: string) => string | undefined;
	appendSystemPromptOverride: (base: string[]) => string[];
	bind(loader: object | undefined): void;
}

export function createPromptBaseObservers(
	handlers: {
		system?: (base: string | undefined) => string | undefined;
		append?: (base: string[]) => string[];
	} = {},
): PromptBaseObservers {
	const observed: { system: string; append: string[] } = { system: "", append: [] };
	let loader: object | undefined;
	return {
		systemPromptOverride: (base?: string) => {
			observed.system = typeof base === "string" ? base : "";
			writeRecord(loader, observed);
			return handlers.system ? handlers.system(base) : base;
		},
		appendSystemPromptOverride: (base: string[]) => {
			observed.append = base.slice();
			writeRecord(loader, observed);
			return handlers.append ? handlers.append(base) : base;
		},
		bind: (next: object | undefined) => {
			loader = next;
			writeRecord(loader, observed);
		},
	};
}
