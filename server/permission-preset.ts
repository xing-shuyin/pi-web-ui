export function readPlanModeFromSession(sm: unknown): boolean {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return false;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { customType?: string; data?: { enabled?: unknown } } | undefined;
			if (e?.customType === "plan/mode" && typeof e.data?.enabled === "boolean") return e.data.enabled;
		}
	} catch {}
	return false;
}

export function readDelegateModeFromSession(sm: unknown): boolean {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return false;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { customType?: string; data?: { enabled?: unknown } } | undefined;
			if (e?.customType === "delegate/mode" && typeof e.data?.enabled === "boolean") return e.data.enabled;
		}
	} catch {}
	return false;
}

export function readPermissionFromSession(sm: unknown): string | undefined {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return undefined;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: { preset?: string } } | undefined;
			if (e?.type === "custom" && e.customType === "permission/preset" && typeof e.data?.preset === "string") {
				return e.data.preset;
			}
		}
	} catch {}
	return undefined;
}

export function readPlanFromSession(sm: unknown): import("./protocol.js").PlanState | null {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return null;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as
				| {
						type?: string;
						customType?: string;
						data?: { plan?: import("./protocol.js").PlanState };
				  }
				| undefined;
			if (
				e?.type === "custom" &&
				(e.customType === "plan/update" || e.customType === "pi-web-ui/plan") &&
				e.data?.plan &&
				Array.isArray(e.data.plan.steps)
			) {
				return e.data.plan;
			}
		}
	} catch {}
	return null;
}
