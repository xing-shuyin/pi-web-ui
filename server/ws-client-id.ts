export const MAX_CLIENT_ID_LEN = 128;

const CLIENT_ID_RE = /^[A-Za-z0-9:_-]+$/;

export function validateClientId(input: unknown): string | null {
	if (typeof input !== "string") return null;
	if (input.length < 1 || input.length > MAX_CLIENT_ID_LEN) return null;
	if (!CLIENT_ID_RE.test(input)) return null;
	return input;
}
