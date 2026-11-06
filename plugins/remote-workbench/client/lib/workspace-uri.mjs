/**
 * 规范化用户输入的远程目录绝对路径。
 * - 空输入或 "~" 解析为主机用户的默认家目录（root 为 /root，普通用户为 /home/<username>）；
 * - "~/..." 解析为家目录下的相对路径；
 * - 统一正斜杠，确保前导 /，去除多余末尾 /（根目录 / 保留）。
 *
 * @param {string} username 用户名
 * @param {string} [rawPath] 用户输入的原始路径
 * @returns {string} 规范的 POSIX 绝对路径
 */
export function normalizeRemotePath(username, rawPath) {
	const user = (username || "root").trim();
	const homeDir = user === "root" ? "/root" : `/home/${user}`;
	let raw = (rawPath ?? "").trim();
	if (!raw || raw === "~") {
		raw = homeDir;
	} else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
		raw = `${homeDir.replace(/\/+$/, "")}/${raw.slice(2).replace(/\\/g, "/")}`;
	}
	raw = raw.replace(/\\/g, "/");
	if (!raw.startsWith("/")) raw = `/${raw}`;
	if (raw.length > 1 && raw.endsWith("/")) raw = raw.slice(0, -1);
	return raw;
}

/**
 * 组装规范的远程工作区 SSH URI：ssh://username@host:port/remote/path
 *
 * @param {{ username: string; host: string; port?: number }} h 主机信息
 * @param {string} [inputPath] 目标远程路径
 * @returns {string} 符合 parseRemoteWorkspaceUri 规范的 URI
 */
export function buildRemoteWorkspaceUri(h, inputPath) {
	const username = (h.username || "root").trim();
	const host = (h.host || "127.0.0.1").trim();
	const port = parseInt(h.port, 10) || 22;
	const pathVal = normalizeRemotePath(username, inputPath);
	return `ssh://${username}@${host}:${port}${pathVal}`;
}
