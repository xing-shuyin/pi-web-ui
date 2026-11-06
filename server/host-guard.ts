export function hostWithoutPort(authority: string): string {
	let a = authority.trim().toLowerCase();
	if (a.startsWith("[")) {
		const end = a.indexOf("]");
		if (end === -1) return "";
		return a.slice(1, end);
	}
	const colon = a.lastIndexOf(":");
	if (colon !== -1 && a.indexOf(":") === colon) a = a.slice(0, colon);
	return a;
}

function isIpv4Literal(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		octets.push(n);
	}
	return octets;
}

function unwrapIpv4Mapped(host: string): string {
	const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
	return m ? m[1] : host;
}

export function isLoopbackHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const h = unwrapIpv4Mapped(host);
	if (h.includes(":")) return h === "::1";
	const o = isIpv4Literal(h);
	return o !== null && o[0] === 127;
}

export function isPrivateLanHost(host: string): boolean {
	const h = unwrapIpv4Mapped(host);
	if (h.includes(":")) {
		return /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
	}
	const o = isIpv4Literal(h);
	if (!o) return false;
	const [a, b] = o;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

export function httpHostAllowed(
	hostHeader: string,
	opts: { allowHosts: readonly string[]; hasAuthToken: boolean },
): boolean {
	if (opts.hasAuthToken) return true;
	const host = hostWithoutPort(hostHeader);
	if (!host) return false;
	if (opts.allowHosts.length > 0) return opts.allowHosts.includes(host);
	return isLoopbackHost(host) || isPrivateLanHost(host);
}
