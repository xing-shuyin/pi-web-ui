import { describe, expect, it } from "vitest";
import {
	buildRemoteWorkspaceUri,
	normalizeRemotePath,
} from "../../plugins/remote-workbench/client/lib/workspace-uri.mjs";
import { isRemoteWorkspaceUri, parseRemoteWorkspaceUri } from "../../server/remote-ssh-service.js";

describe("remote-workbench workspace uri & path normalization", () => {
	it("正确解析 root 用户的默认家目录", () => {
		expect(normalizeRemotePath("root", "")).toBe("/root");
		expect(normalizeRemotePath("root", "~")).toBe("/root");
		expect(normalizeRemotePath("root", "~/app")).toBe("/root/app");
		expect(normalizeRemotePath("root", "~\\workspace")).toBe("/root/workspace");
	});

	it("正确解析普通用户的默认家目录", () => {
		expect(normalizeRemotePath("ubuntu", "")).toBe("/home/ubuntu");
		expect(normalizeRemotePath("ubuntu", "~")).toBe("/home/ubuntu");
		expect(normalizeRemotePath("ubuntu", "~/project")).toBe("/home/ubuntu/project");
	});

	it("规范化无前导斜杠或多余末尾斜杠的路径", () => {
		expect(normalizeRemotePath("root", "/var/www/")).toBe("/var/www");
		expect(normalizeRemotePath("root", "var/www")).toBe("/var/www");
		expect(normalizeRemotePath("root", "/")).toBe("/");
		expect(normalizeRemotePath("root", "\\opt\\service\\")).toBe("/opt/service");
	});

	it("组装完整的远程工作区 URI 并兼容后端的 isRemoteWorkspaceUri / parseRemoteWorkspaceUri", () => {
		const host = {
			username: "ubuntu",
			host: "198.51.100.10",
			port: 22,
		};
		const uri = buildRemoteWorkspaceUri(host, "~/my-project");
		expect(uri).toBe("ssh://ubuntu@198.51.100.10:22/home/ubuntu/my-project");
		expect(isRemoteWorkspaceUri(uri)).toBe(true);

		const parsed = parseRemoteWorkspaceUri(uri);
		expect(parsed).not.toBeNull();
		expect(parsed?.username).toBe("ubuntu");
		expect(parsed?.host).toBe("198.51.100.10");
		expect(parsed?.port).toBe(22);
		expect(parsed?.remotePath).toBe("/home/ubuntu/my-project");
	});

	it("处理未指定端口及根目录边界情况", () => {
		const host = {
			username: "root",
			host: "203.0.113.10",
		};
		const uri = buildRemoteWorkspaceUri(host, "/");
		expect(uri).toBe("ssh://root@203.0.113.10:22/");
		expect(isRemoteWorkspaceUri(uri)).toBe(true);

		const parsed = parseRemoteWorkspaceUri(uri);
		expect(parsed?.username).toBe("root");
		expect(parsed?.host).toBe("203.0.113.10");
		expect(parsed?.port).toBe(22);
		expect(parsed?.remotePath).toBe("/");
	});
});
