import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
	sanitizeHostHeader,
	safeTokenEqual,
	validateTaskTools,
	sanitizeMeshTo,
	isRestrictedBrowsePath,
} from "../../plugins/tunnel/index.mjs";

describe("sanitizeHostHeader", () => {
	it("合法 host 保持原样", () => {
		expect(sanitizeHostHeader("127.0.0.1:8765")).toBe("127.0.0.1:8765");
		expect(sanitizeHostHeader("my-server.lan:9000")).toBe("my-server.lan:9000");
		expect(sanitizeHostHeader("localhost:8765")).toBe("localhost:8765");
		expect(sanitizeHostHeader("  192.168.1.10:8765  ")).toBe("192.168.1.10:8765");
	});

	it("含注入字符（单引号/反斜杠/换行/代码片段）回落 fallback", () => {
		const fallback = "127.0.0.1:8765";
		expect(sanitizeHostHeader("localhost:8765'; alert(1); //", fallback)).toBe(fallback);
		expect(sanitizeHostHeader("evil.com\nnewline", fallback)).toBe(fallback);
		expect(sanitizeHostHeader('foo"bar', fallback)).toBe(fallback);
		expect(sanitizeHostHeader("<script>", fallback)).toBe(fallback);
		expect(sanitizeHostHeader("", fallback)).toBe(fallback);
		expect(sanitizeHostHeader(undefined as any, fallback)).toBe(fallback);
	});
});

describe("safeTokenEqual", () => {
	it("常时比较正确识别一致与不一致口令", () => {
		const token = "a1b2c3d4e5f6789012345678abcdef01";
		expect(safeTokenEqual(token, token)).toBe(true);
		expect(safeTokenEqual(token, "a1b2c3d4e5f6789012345678abcdef02")).toBe(false);
		expect(safeTokenEqual("short", token)).toBe(false);
		expect(safeTokenEqual(token, "short")).toBe(false);
	});

	it("边界情况（空值/非法类型）安全拒绝", () => {
		expect(safeTokenEqual("", "valid-token")).toBe(false);
		expect(safeTokenEqual("valid-token", "")).toBe(false);
		expect(safeTokenEqual(null as any, "valid-token")).toBe(false);
		expect(safeTokenEqual("valid-token", undefined as any)).toBe(false);
	});
});

describe("validateTaskTools (能力模型硬约束)", () => {
	it("只读权限下放行读取工具", () => {
		const res = validateTaskTools("read,grep,glob", { fsRead: true, fsWrite: false });
		expect(res.ok).toBe(true);
		expect(res.tools).toEqual(["read", "grep", "glob"]);
	});

	it("fsWrite=false 时拦截 bash/edit/write/patch 工具", () => {
		const resBash = validateTaskTools("read,grep,bash", { fsRead: true, fsWrite: false });
		expect(resBash.ok).toBe(false);
		expect(resBash.error).toContain("fsWrite=false");

		const resWrite = validateTaskTools("write", { fsRead: true, fsWrite: false });
		expect(resWrite.ok).toBe(false);

		const resEdit = validateTaskTools("read,edit", { fsRead: true, fsWrite: false });
		expect(resEdit.ok).toBe(false);
	});

	it("fsWrite=true 时允许写与执行工具", () => {
		const res = validateTaskTools("read,grep,glob,bash,edit,write", { fsRead: true, fsWrite: true });
		expect(res.ok).toBe(true);
		expect(res.tools).toContain("bash");
		expect(res.tools).toContain("write");
	});

	it("fsRead=false 时拦截读取类工具", () => {
		const res = validateTaskTools("read,grep", { fsRead: false, fsWrite: false });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("fsRead=false");
	});
});

describe("sanitizeMeshTo (Mesh 跨设备注入与路径穿越防御)", () => {
	it("合法标识符正常通过", () => {
		expect(sanitizeMeshTo("RemoteMacBook")).toBe("RemoteMacBook");
		expect(sanitizeMeshTo("agent-01_test")).toBe("agent-01_test");
	});

	it("包含路径穿越与非法字符被安全拒绝", () => {
		expect(sanitizeMeshTo("../../etc/passwd")).toBe("");
		expect(sanitizeMeshTo("agent/sub")).toBe("");
		expect(sanitizeMeshTo("agent\\evil")).toBe("");
		expect(sanitizeMeshTo("agent name with space")).toBe("");
		expect(sanitizeMeshTo("")).toBe("");
		expect(sanitizeMeshTo(null as any)).toBe("");
	});
});

describe("isRestrictedBrowsePath (目录浏览枚举边界)", () => {
	const home = os.homedir();

	it("允许用户主目录及子目录", () => {
		expect(isRestrictedBrowsePath(home, home)).toBe(false);
		expect(isRestrictedBrowsePath(path.join(home, "Downloads"), home)).toBe(false);
		expect(isRestrictedBrowsePath(path.join(home, "Projects", "repo"), home)).toBe(false);
	});

	it("禁止 Unix 系统敏感目录及根路径", () => {
		expect(isRestrictedBrowsePath("/", home)).toBe(true);
		expect(isRestrictedBrowsePath("/etc", home)).toBe(true);
		expect(isRestrictedBrowsePath("/etc/nginx", home)).toBe(true);
		expect(isRestrictedBrowsePath("/var", home)).toBe(true);
		expect(isRestrictedBrowsePath("/proc", home)).toBe(true);
		expect(isRestrictedBrowsePath("/sys", home)).toBe(true);
		expect(isRestrictedBrowsePath("/root", home)).toBe(true);
	});
});
