/** Explicit migration origins authorize only existing credential-based device traffic. */
export function legacyHubHosts(origins: string[] = []): Set<string> {
	if (!Array.isArray(origins) || origins.length > 8) throw new Error("Invalid legacy Hub origins");
	return new Set(
		origins.map((value) => {
			const url = new URL(value);
			if (url.origin !== value || url.protocol !== "http:" || url.username || url.password)
				throw new Error("Legacy Hub origins must be canonical HTTP origins");
			return url.host;
		}),
	);
}
