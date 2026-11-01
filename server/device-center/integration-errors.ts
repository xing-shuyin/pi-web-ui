// Only these fixed integration failures may cross the device RPC boundary.
// Raw Git stderr, paths, command lines and arbitrary error messages stay local.
const integrationErrors = {
	INTEGRATION_TARGET_CHECKED_OUT: {
		status: 409,
		message:
			"Target branch is currently checked out in a worktree; please switch away from target branch before applying integration",
	},
	INTEGRATION_TARGET_MOVED: {
		status: 409,
		message: "Target branch moved from the prepared SHA; prepare a new integration against its current SHA",
	},
	INTEGRATION_CUSTOM_DRIVER: {
		status: 422,
		message:
			"Custom filter/merge driver is forbidden for isolated integration; remove external driver configuration before preparing again",
	},
} as const;

export function integrationError(code: keyof typeof integrationErrors): Error {
	const { status, message } = integrationErrors[code];
	return Object.assign(new Error(message), { code, status });
}

export function integrationErrorFromCode(code: unknown): Error | undefined {
	if (typeof code !== "string" || !Object.hasOwn(integrationErrors, code)) return undefined;
	return integrationError(code as keyof typeof integrationErrors);
}
