import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface ToolOverrideSpec {
	name: string;
	fallback: () => AnyToolDefinition;
	composeWith?: (base: AnyToolDefinition) => AnyToolDefinition;
}

export interface OverrideSessionLike {
	extensionRunner?: {
		getAllRegisteredTools?: () => Array<{ definition: AnyToolDefinition }>;
	};
	_customTools?: AnyToolDefinition[];
	_refreshToolRegistry?: () => void;
}

export function extensionToolDefinition(session: OverrideSessionLike, name: string): AnyToolDefinition | undefined {
	const tools = session.extensionRunner?.getAllRegisteredTools?.();
	return tools?.find((tool) => tool.definition?.name === name)?.definition;
}

export function isExtensionToolProvided(session: OverrideSessionLike, name: string): boolean {
	return Boolean(extensionToolDefinition(session, name));
}

export interface InstallToolOverridesOptions {
	onComposed?: (name: string, base: AnyToolDefinition) => void;
}

export function installToolOverrides(
	session: OverrideSessionLike,
	specs: readonly ToolOverrideSpec[],
	options?: InstallToolOverridesOptions,
): string[] | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const names = new Set(specs.map((s) => s.name));
	const injected: AnyToolDefinition[] = [];
	for (const spec of specs) {
		const extensionTool = extensionToolDefinition(session, spec.name);
		if (extensionTool) {
			if (spec.composeWith) {
				injected.push(spec.composeWith(extensionTool));
				try {
					options?.onComposed?.(spec.name, extensionTool);
				} catch {}
			}
			continue;
		}
		injected.push(spec.fallback());
	}
	session._customTools = [...injected, ...session._customTools.filter((t) => !names.has(t.name))];
	session._refreshToolRegistry();
	return [...names];
}

export function syncSubagentOverride(
	session: OverrideSessionLike,
	subagentDisabled: boolean,
	builtinSubagentTool?: (name: string) => AnyToolDefinition,
): void {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return;
	let changed = false;
	for (const name of ["conversation", "subagent"]) {
		if (!extensionToolDefinition(session, name)) continue;
		const idx = session._customTools.findIndex((t) => t.name === name);
		if (subagentDisabled && idx !== -1) {
			session._customTools = session._customTools.filter((t) => t.name !== name);
			changed = true;
		} else if (!subagentDisabled && idx === -1 && builtinSubagentTool) {
			session._customTools = [builtinSubagentTool(name), ...session._customTools];
			changed = true;
		}
	}
	if (changed) session._refreshToolRegistry();
}
