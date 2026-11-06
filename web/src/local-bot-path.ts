export function resolveBotCwd(value: string, base: string): string {
	const path = value.trim().replace(/\\/g, "/");
	if (!path) return "";
	const absolute = /^(?:[a-z]:\/|\/)/i.test(path) ? path : `${base.replace(/\\/g, "/").replace(/\/$/, "")}/${path}`;
	const root = absolute.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0];
	if (!root) return path;
	const segments: string[] = [];
	for (const segment of absolute.slice(root.length).split("/")) {
		if (segment === "..") segments.pop();
		else if (segment && segment !== ".") segments.push(segment);
	}
	return root.replace(/\/$/, "") + "/" + segments.join("/");
}
