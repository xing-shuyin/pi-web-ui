import type { DispatchSession } from "../../../../../server/engine-service.js";
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

function isValueMember(member: DispatchSessionMember): member is NonFunctionMember {
	return (DISPATCH_VALUE_MEMBERS as readonly string[]).includes(member);
}

function notImplemented(member: DispatchSessionMember): never {
	throw new CoreEngineNotReadyError(`dispatch.${member}`);
}

export function createDispatchSurfaceAdapter(handlers: DispatchHandlers): DispatchSession {
	const surface: Record<string, unknown> = { cwd: handlers.cwd, workspaceRoots: handlers.workspaceRoots };
	for (const member of DISPATCH_SURFACE) {
		if (isValueMember(member)) continue;
		surface[member] = handlers[member] ?? (() => notImplemented(member));
	}
	return surface as unknown as DispatchSession;
}
