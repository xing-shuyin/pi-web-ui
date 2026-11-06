export function isNativeCliRemoteCwd(cwd: string): boolean {
	return /^ssh:\/\//i.test(cwd.trim());
}

export function nativeCliArgumentLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => line.length > 0);
}
