import type { DispatchSession } from "../../engine-service.js";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import { DISPATCH_SURFACE, type DispatchSessionMember } from "./dispatch-surface.js";

export type DispatchHandler = (...args: never[]) => unknown;

export type NonFunctionMember = {
	[K in keyof DispatchSession]-?: NonNullable<DispatchSession[K]> extends DispatchHandler ? never : K;
}[keyof DispatchSession];

export type DispatchFunctionMember = Exclude<DispatchSessionMember, NonFunctionMember>;

/** 非函数成员没法用「调用即抛」顶替，只能由接入方显式提供真实值。 */
export const DISPATCH_VALUE_MEMBERS = ["cwd", "workspaceRoots"] as const satisfies readonly NonFunctionMember[];

export type DispatchHandlers = Pick<DispatchSession, NonFunctionMember> &
	Partial<Record<DispatchFunctionMember, DispatchHandler>>;

export type DispatchValueMembers = Pick<DispatchSession, NonFunctionMember>;

function isValueMember(member: DispatchSessionMember): member is NonFunctionMember {
	return (DISPATCH_VALUE_MEMBERS as readonly string[]).includes(member);
}

function notImplemented(member: DispatchSessionMember): never {
	throw new CoreEngineNotReadyError(`dispatch.${member}`);
}

/**
 * 值成员（`cwd` / `workspaceRoots`）**每次现读**：换工作区之后宿主拿到的必须是新目录，
 * 否则附件 / 文件 / SCM 还会按旧根解析。所以可以给一个取值口，而不是在构造期抄一份。
 */
export function createDispatchSurfaceAdapter(
	handlers: DispatchHandlers,
	values?: () => DispatchValueMembers,
): DispatchSession {
	const surface: Record<string, unknown> = {};
	for (const member of DISPATCH_VALUE_MEMBERS) {
		Object.defineProperty(surface, member, {
			get: () => (values ? values()[member] : handlers[member]),
			enumerable: true,
			configurable: false,
		});
	}
	for (const member of DISPATCH_SURFACE) {
		if (isValueMember(member)) continue;
		surface[member] = handlers[member] ?? (() => notImplemented(member));
	}
	return surface as unknown as DispatchSession;
}
