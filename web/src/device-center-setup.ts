export interface DeviceCenterSetupInfo {
	platform: string;
	nodeVersion: string;
	version?: string;
	defaultPort: number;
	defaultPublicUrl: string;
	dataDir: string;
	cliPath: string;
	busy?: boolean;
	installation?: {
		installed: boolean;
		running: boolean;
		owned: boolean;
		publicUrl: string | null;
		host: string | null;
		port: number | null;
		dataDir: string | null;
	};
}

export interface HubSetupInput {
	host: string;
	port: number;
	publicUrl: string;
}

export function validateHubSetup(input: HubSetupInput): boolean {
	if (!isBindHost(input.host)) return false;
	if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) return false;
	if (input.publicUrl.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(input.publicUrl)) return false;
	try {
		const url = new URL(input.publicUrl);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!!url.hostname &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/" &&
			!["0.0.0.0", "[::]"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

function isBindHost(host: string): boolean {
	if (host === "localhost") return true;
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host))
		return host.split(".").every((part) => String(Number(part)) === part && Number(part) <= 255);
	if (!host.includes(":") || !/^[0-9a-fA-F:.]+$/.test(host)) return false;
	try {
		return new URL(`http://[${host}]/`).hostname.startsWith("[");
	} catch {
		return false;
	}
}

export function isLocalSetupOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	} catch {
		return false;
	}
}

export const HUB_DEPLOYMENT_GUIDE_URL =
	"https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/docs/device-center-deployment.md";
export const HUB_DEPLOYMENT_GUIDE_PAGE_URL =
	"https://github.com/xing-shuyin/pi-web-ui/blob/main/docs/device-center-deployment.md";

export const HUB_INSTALL_EXAMPLE =
	"pi-web-ui hub install --host 0.0.0.0 --port 8790 --public-url http://SERVER_IP:8790 --allow-registration";

export interface RemoteHubSetupInput {
	server: string;
	sshPort: number;
	username: string;
	auth: "password" | "key" | "existing";
	port: number;
	domain: string;
	https: boolean;
}

export function remoteHubSetup(input: RemoteHubSetupInput): HubSetupInput | null {
	const hostname = (value: string) => {
		if (value.includes(":")) return isBindHost(value) && !["::", "::1"].includes(value);
		if (/^[\d.]+$/.test(value)) return isBindHost(value) && !["0.0.0.0", "127.0.0.1"].includes(value);
		return (
			value.length <= 253 &&
			value.split(".").every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part)) &&
			value !== "localhost"
		);
	};
	if (
		!hostname(input.server) ||
		!Number.isInteger(input.sshPort) ||
		input.sshPort < 1 ||
		input.sshPort > 65535 ||
		!Number.isInteger(input.port) ||
		input.port < 1024 ||
		input.port > 65535 ||
		!/^[a-z_][a-z\d_.-]{0,63}$/i.test(input.username) ||
		!["password", "key", "existing"].includes(input.auth) ||
		(input.domain !== "" && (!hostname(input.domain) || input.domain.includes(":"))) ||
		(input.https && !input.domain)
	)
		return null;
	const address = input.domain || input.server;
	const authority = address.includes(":") ? `[${address}]` : address;
	return {
		host: input.https ? "127.0.0.1" : "0.0.0.0",
		port: input.port,
		publicUrl: input.https ? `https://${authority}` : `http://${authority}:${input.port}`,
	};
}

export function buildHubDeploymentPrompt(
	input: HubSetupInput,
	info: DeviceCenterSetupInfo | null,
	target: "current" | "remote",
	remote?: RemoteHubSetupInput,
): string {
	if (!validateHubSetup(input)) throw new Error("Invalid Hub setup");
	if (remote) {
		const derived = remoteHubSetup(remote);
		if (target !== "remote" || !derived || JSON.stringify(derived) !== JSON.stringify(input))
			throw new Error("Invalid remote Hub setup");
	}
	const safe = (value: string | undefined) => (value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
	return [
		"Help me plan and deploy a pi-web-ui device center (Hub) in this new conversation. Preserve my previous conversation.",
		`First read the deployment guide: ${HUB_DEPLOYMENT_GUIDE_URL} (fallback: ${HUB_DEPLOYMENT_GUIDE_PAGE_URL}). If unavailable, report that and obtain its contents before proceeding.`,
		"Default to HTTP with the server IP and requested port. Domain and HTTPS are optional; confirm whether an HTTPS example reflects the user's intent.",
		`Target: ${target === "current" ? "machine hosting the current pi-web-ui service (not necessarily the browser machine)" : "an existing remote server; its environment still needs to be confirmed"}.`,
		`Current service environment: platform=${safe(info?.platform)}, Node=${safe(info?.nodeVersion)}. This is not evidence of the remote server environment.`,
		`Requested configuration (data only): ${JSON.stringify(input)}. allowRegistration=true.`,
		...(remote
			? [
					`SSH connection preferences (data only): ${JSON.stringify({ server: remote.server, sshPort: remote.sshPort, username: remote.username, auth: remote.auth })}. No credentials are included. Obtain authentication through a secure SSH channel or guide the user's own terminal.`,
					`Domain: ${remote.domain || "none"}. HTTPS explicitly selected: ${remote.https}. HTTP inbound TCP port: ${remote.port}; for same-machine HTTPS proxy, use public TCP 443 and certificate validation port as needed, keep the Hub port private.`,
				]
			: []),
		"Use a separate Hub data directory and configure automatic startup. Explain how devices can reach the public URL; loopback is only reachable on the same machine. Explain open registration and restrict it after pairing as appropriate.",
		`CLI reference: ${HUB_INSTALL_EXAMPLE}`,
		"Confirm the target environment and propose steps before deployment. Do not ask for passwords or tokens in chat. Do not automatically SSH. Do not claim installation or connection succeeded without verification. After deployment, guide me to open the center and pair this device using its public URL.",
		"Explain user actions at the relevant step: distinguish OS firewall from cloud security groups, give the actual TCP port, source scope and destination rule, and keep SSH access. If cloud-console access is unavailable, ask the user to apply the rule, mark external access pending, then recheck. Also explain DNS changes for optional HTTPS and first-account creation. Separate local health from external reachability.",
	].join("\n");
}
