export function resolveBotCwd(value: string, base: string): string {
	const trimmed = value.trim();
	// SSH 智能体：直连设备工作区原样透传（ssh://user@host:port/path），由服务端规范化。
	if (/^ssh:\/\//i.test(trimmed)) return trimmed;
	const path = trimmed.replace(/\\/g, "/");
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
