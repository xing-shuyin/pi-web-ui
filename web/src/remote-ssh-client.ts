import { appSend } from "./app-globals";
import type {
	RemoteSshDirItem,
	RemoteSshProbeParams,
	RemoteSshProfileSummary,
	RemoteSshSystemInfo,
	RemoteSshToolsInfo,
	ServerMessage,
} from "./types";

type RemoteSshListener = (msg: ServerMessage) => void;
const listeners = new Set<RemoteSshListener>();

export function subscribeRemoteSsh(fn: RemoteSshListener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function dispatchRemoteSshMessage(msg: ServerMessage): void {
	for (const l of listeners) {
		try {
			l(msg);
		} catch (err) {
			console.error("[remote-ssh-client] listener error:", err);
		}
	}
}

export function formatRemoteWorkspaceUri(username: string, host: string, port: number, remotePath: string): string {
	const normPath = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
	return `ssh://${username}@${host}:${port}${normPath}`;
}

export function isRemoteWorkspaceUri(uri?: string): boolean {
	return Boolean(uri && uri.startsWith("ssh://"));
}

export function parseRemoteWorkspaceUri(uri: string): {
	username: string;
	host: string;
	port: number;
	remotePath: string;
} | null {
	if (!isRemoteWorkspaceUri(uri)) return null;
	const match = /^ssh:\/\/([^@]+)@([^:]+):(\d+)(\/.*)$/.exec(uri);
	if (!match) return null;
	return {
		username: match[1],
		host: match[2],
		port: parseInt(match[3], 10),
		remotePath: match[4],
	};
}

let nextReqId = 1;

export function requestRemoteProbe(params: RemoteSshProbeParams): Promise<{
	ok: boolean;
	connectionId?: string;
	error?: string;
	system?: RemoteSshSystemInfo;
	tools?: RemoteSshToolsInfo;
	packageManager?: string;
	suggestedInstall?: string[];
}> {
	const reqId = `probe_${Date.now()}_${nextReqId++}`;
	return new Promise((resolve) => {
		const cleanup = subscribeRemoteSsh((msg) => {
			if (msg.type === "remote_ssh_probe_result" && msg.reqId === reqId) {
				cleanup();
				resolve({
					ok: msg.ok,
					connectionId: msg.connectionId,
					error: msg.error,
					system: msg.system,
					tools: msg.tools,
					packageManager: msg.packageManager,
					suggestedInstall: msg.suggestedInstall,
				});
			}
		});

		const sent = appSend({
			type: "remote_ssh_probe",
			reqId,
			params,
		});

		if (!sent) {
			cleanup();
			resolve({ ok: false, error: "WebSocket 连接不可用，请稍候重试" });
		}
	});
}

export function requestRemoteListDir(
	connectionId: string,
	dirPath?: string,
): Promise<{
	ok: boolean;
	connectionId: string;
	path: string;
	parentPath?: string | null;
	items: RemoteSshDirItem[];
	error?: string;
}> {
	const reqId = `listdir_${Date.now()}_${nextReqId++}`;
	return new Promise((resolve) => {
		const cleanup = subscribeRemoteSsh((msg) => {
			if (msg.type === "remote_ssh_list_dir_result" && msg.reqId === reqId) {
				cleanup();
				resolve({
					ok: msg.ok,
					connectionId: msg.connectionId,
					path: msg.path,
					parentPath: msg.parentPath,
					items: msg.items,
					error: msg.error,
				});
			}
		});

		const sent = appSend({
			type: "remote_ssh_list_dir",
			reqId,
			connectionId,
			path: dirPath,
		});

		if (!sent) {
			cleanup();
			resolve({
				ok: false,
				connectionId,
				path: dirPath || "/",
				items: [],
				error: "WebSocket 连接不可用",
			});
		}
	});
}

export function requestRemoteInstallTools(
	connectionId: string,
	tools: string[],
): Promise<{
	ok: boolean;
	connectionId: string;
	tool: string;
	output?: string;
	error?: string;
}> {
	const reqId = `install_${Date.now()}_${nextReqId++}`;
	return new Promise((resolve) => {
		const cleanup = subscribeRemoteSsh((msg) => {
			if (msg.type === "remote_ssh_install_result" && msg.reqId === reqId) {
				cleanup();
				resolve({
					ok: msg.ok,
					connectionId: msg.connectionId,
					tool: msg.tool,
					output: msg.output,
					error: msg.error,
				});
			}
		});

		const sent = appSend({
			type: "remote_ssh_install_tools",
			reqId,
			connectionId,
			tools,
		});

		if (!sent) {
			cleanup();
			resolve({
				ok: false,
				connectionId,
				tool: tools[0] || "",
				error: "WebSocket 连接不可用",
			});
		}
	});
}

export function requestRemoteProfiles(): Promise<RemoteSshProfileSummary[]> {
	const reqId = `profiles_${Date.now()}_${nextReqId++}`;
	return new Promise((resolve) => {
		const cleanup = subscribeRemoteSsh((msg) => {
			if (msg.type === "remote_ssh_profiles_result" && msg.reqId === reqId) {
				cleanup();
				resolve(msg.profiles);
			}
		});

		const sent = appSend({
			type: "remote_ssh_list_profiles",
			reqId,
		});

		if (!sent) {
			cleanup();
			resolve([]);
		}
	});
}

export function deleteRemoteProfile(name: string): void {
	appSend({
		type: "remote_ssh_delete_profile",
		name,
	});
}
