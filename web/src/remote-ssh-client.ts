/**
 * remote-ssh-client.ts — 前端与远程 SSH 服务端的通信桥梁与请求辅助。
 *
 * 提供：
 * 1. 远程 SSH 消息分发与监听机制；
 * 2. 基于 Promise 的请求/响应封装（probe, listDir, installTools, listProfiles, deleteProfile）；
 * 3. 辅助解析远程工作区路径标识（例如 ssh://user@host:port/path）。
 */

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

/** 规范化远程工作区 URI：ssh://user@host:port/remote/path */
export function formatRemoteWorkspaceUri(username: string, host: string, port: number, remotePath: string): string {
	const normPath = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
	return `ssh://${username}@${host}:${port}${normPath}`;
}

/** 检查路径是否是远程 SSH 工作区路径 */
export function isRemoteWorkspaceUri(uri?: string): boolean {
	return Boolean(uri && uri.startsWith("ssh://"));
}

/** 解析远程工作区 URI */
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

/** 发起远程连接与深度探针 */
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

/** 浏览远程目录 */
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

/** 远程安装必要工具 */
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

/** 列出已保存的 SSH Profiles */
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

/** 删除已保存的 SSH Profile */
export function deleteRemoteProfile(name: string): void {
	appSend({
		type: "remote_ssh_delete_profile",
		name,
	});
}
