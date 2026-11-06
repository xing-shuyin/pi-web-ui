export function formatBytes(bytes?: number | null, decimals = 1): string {
	if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(decimals)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}

export function formatSize(bytes?: number | null): string {
	if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
