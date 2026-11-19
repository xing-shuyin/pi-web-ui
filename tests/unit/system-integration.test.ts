import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_CLIENT_KEY,
	BROWSER_PROG_ID,
	CAPABILITIES_KEY,
	DEFAULT_ASSOCIATION_EXTENSIONS,
	INTEGRATION_APP_NAME,
	applyRegistryActions,
	browserRegistrationActions,
	browserRemovalActions,
	collectOpenTargets,
	extractExeFromCommand,
	fileProgId,
	fileRegistrationActions,
	normalizeExtension,
	normalizeExtensions,
	parseRegQueryValue,
	parseRegQueryValueNames,
	planIntegrationActions,
	readIntegrationState,
	reconcileIntegrationSelection,
	refreshStaleRegistration,
	registryArgs,
	removalActions,
	shellCommand,
	type RegistryRunner,
} from "../../desktop/system-integration.js";

/** reg query 的真实输出形状：键行 + 缩进的值行。 */
function regOutput(key: string, rows: Array<[string, string]>): string {
	const lines = [`\r\nHKEY_CURRENT_USER\\${key}\r\n`];
	for (const [name, value] of rows) lines.push(`    ${name}    REG_SZ    ${value}\r\n`);
	return lines.join("");
}

const EXE = "C:\\Program Files\\Pi Web UI\\pi-web-ui-desktop.exe";

/** 只给指定 key 返回注册表值，其它 query 一律当作「键不存在」。 */
function queryRunner(rowsByKey: Record<string, Array<[string, string]>>): RegistryRunner {
	return async (args) => {
		if (args[0] !== "query") return { ok: true, stdout: "", stderr: "" };
		const key = (args[1] ?? "").replace(/^HKCU\\/i, "").toLowerCase();
		const rows = rowsByKey[key];
		return rows
			? { ok: true, stdout: regOutput(key, rows), stderr: "" }
			: { ok: false, stdout: "", stderr: "not found" };
	};
}

const BROWSER_COMMAND_KEY = `software\\classes\\${BROWSER_PROG_ID.toLowerCase()}\\shell\\open\\command`;
const CLIENT_COMMAND_KEY = `${BROWSER_CLIENT_KEY.toLowerCase()}\\shell\\open\\command`;
const PDF_COMMAND_KEY = `software\\classes\\${fileProgId(".pdf").toLowerCase()}\\shell\\open\\command`;
const PDF_OPEN_WITH_KEY = "software\\classes\\.pdf\\openwithprogids";

describe("扩展名归一化", () => {
	it("补点、小写、去重，非法值丢掉", () => {
		expect(normalizeExtension("PDF")).toBe(".pdf");
		expect(normalizeExtension(" .Docx ")).toBe(".docx");
		expect(normalizeExtension("../../etc")).toBe(null);
		expect(normalizeExtension("")).toBe(null);
		expect(normalizeExtensions([".PDF", "pdf", ".xlsx", "bad/ext", ".pdf"])).toEqual([".pdf", ".xlsx"]);
	});

	it("每个扩展名一个 ProgId，命令用引号包住 exe", () => {
		expect(fileProgId(".pdf")).toBe("PiWebUI.Desktop.pdf");
		expect(shellCommand(EXE)).toBe(`"${EXE}" "%1"`);
	});

	it("默认关联含内置预览的 PDF 与 Office 插件接管的三种主流格式", () => {
		expect(DEFAULT_ASSOCIATION_EXTENSIONS).toEqual([".pdf", ".docx", ".xlsx", ".pptx"]);
	});
});

describe("注册表命令行", () => {
	it("set 默认值走 /ve，具名值走 /v", () => {
		expect(registryArgs({ op: "set", key: "Software\\Classes\\X", name: null, value: "v" })).toEqual([
			"add",
			"HKCU\\Software\\Classes\\X",
			"/ve",
			"/t",
			"REG_SZ",
			"/d",
			"v",
			"/f",
		]);
		expect(registryArgs({ op: "set", key: "Software\\Classes\\X", name: "Icon", value: "i" })).toEqual([
			"add",
			"HKCU\\Software\\Classes\\X",
			"/v",
			"Icon",
			"/t",
			"REG_SZ",
			"/d",
			"i",
			"/f",
		]);
	});

	it("删除键/值都带 /f", () => {
		expect(registryArgs({ op: "deleteKey", key: "Software\\PiWebUI" })).toEqual([
			"delete",
			"HKCU\\Software\\PiWebUI",
			"/f",
		]);
		expect(registryArgs({ op: "deleteValue", key: "Software\\PiWebUI", name: "x" })).toEqual([
			"delete",
			"HKCU\\Software\\PiWebUI",
			"/v",
			"x",
			"/f",
		]);
	});

	it("文件关联只登记 OpenWithProgids，不改 .ext 默认值（Win10+ 也不允许程序改）", () => {
		const actions = fileRegistrationActions(EXE, [".pdf"]);
		const hasDefaultExtWrite = actions.some(
			(action) => action.op === "set" && action.key === "Software\\Classes\\.pdf" && action.name === null,
		);
		expect(hasDefaultExtWrite).toBe(false);
		expect(
			actions.some(
				(action) =>
					action.op === "set" &&
					action.key === "Software\\Classes\\.pdf\\OpenWithProgids" &&
					action.name === fileProgId(".pdf"),
			),
		).toBe(true);
		expect(
			actions.some(
				(action) =>
					action.op === "set" &&
					action.key === `${CAPABILITIES_KEY}\\FileAssociations` &&
					action.name === ".pdf" &&
					action.value === fileProgId(".pdf"),
			),
		).toBe(true);
	});
});

describe("reg 输出解析", () => {
	it("按值名取值（键名里带空格也不误伤）", () => {
		const out = regOutput("Software\\Classes\\PiWebUI.Desktop.Html\\shell\\open\\command", [
			[`(默认)`, shellCommand(EXE)],
		]);
		expect(parseRegQueryValue(out, "(默认)")).toBe(shellCommand(EXE));
	});

	it("列出所有值名（Capabilities 的 FileAssociations 就是这么读的）", () => {
		const out = regOutput(`${CAPABILITIES_KEY}\\FileAssociations`, [
			[".pdf", fileProgId(".pdf")],
			[".docx", fileProgId(".docx")],
		]);
		expect(parseRegQueryValueNames(out)).toEqual([".pdf", ".docx"]);
	});

	it("从命令行里取 exe；没有引号时按第一个空格切", () => {
		expect(extractExeFromCommand(`"${EXE}" "%1"`)).toBe(EXE);
		expect(extractExeFromCommand("C:\\pi.exe %1")).toBe("C:\\pi.exe");
		expect(extractExeFromCommand(null)).toBe(null);
	});
});

describe("argv → 待打开目标", () => {
	const exists = (p: string) => p === "C:\\Users\\cc\\Downloads\\a.docx" || p === "C:\\Users\\cc\\Downloads\\a.pdf";
	const isFile = (p: string) => exists(p);

	it("跳过命令行开关与不存在的路径，URL 单独归一类", () => {
		const targets = collectOpenTargets(
			[
				EXE,
				"--inspect=5858",
				"C:\\Users\\cc\\Downloads\\a.docx",
				"C:\\Users\\cc\\Downloads\\missing.docx",
				"https://example.com/x",
			],
			{ exists, isFile, cwd: "C:\\Users\\cc\\Downloads" },
		);
		expect(targets.files).toEqual(["C:\\Users\\cc\\Downloads\\a.docx"]);
		expect(targets.urls).toEqual(["https://example.com/x"]);
	});

	it("相对路径按工作目录解析；目录不当作文件", () => {
		const targets = collectOpenTargets(["pi.exe", "a.pdf", "folder"], {
			exists: (p) => p.endsWith("a.pdf") || p.endsWith("folder"),
			isFile: (p) => p.endsWith("a.pdf"),
			cwd: "C:\\Users\\cc\\Downloads",
		});
		expect(targets.files).toEqual(["C:\\Users\\cc\\Downloads\\a.pdf"]);
	});

	it("GBK 字节被当成 Latin-1 的中文名会修好，正常 UTF-8 不受影响", () => {
		// "序标" 的 GBK 字节 D0 F2 B1 EA 被按 Latin-1 读成 Ðò±ê
		const mangled = "C:\\Users\\cc\\Downloads\\Ðò±ê.xlsx";
		const utf8 = "C:\\Users\\cc\\Downloads\\序标.xlsx";
		const exists = (p: string) => p === mangled || p === utf8;
		const targets = collectOpenTargets(["pi.exe", mangled, utf8], { exists, isFile: () => true });
		expect(targets.files).toEqual([utf8]);
	});
});

describe("勾选变化 → 注册表动作", () => {
	it("浏览器注册写 StartMenuInternet，解绑时删掉", () => {
		const added = browserRegistrationActions(EXE);
		expect(added).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "set", key: BROWSER_CLIENT_KEY, name: null, value: INTEGRATION_APP_NAME }),
				expect.objectContaining({
					op: "set",
					key: `${BROWSER_CLIENT_KEY}\\shell\\open\\command`,
					name: null,
					value: shellCommand(EXE),
				}),
			]),
		);
		const removed = browserRemovalActions();
		expect(removed.some((action) => action.op === "deleteKey" && action.key === BROWSER_CLIENT_KEY)).toBe(true);
	});

	it("新勾选的写进去，去掉的删掉", () => {
		const actions = planIntegrationActions(
			{ browser: false, extensions: [] },
			{ browser: true, extensions: [".pdf"] },
			EXE,
		);
		expect(
			actions.some((action) => action.op === "set" && action.key === `Software\\Classes\\${BROWSER_PROG_ID}`),
		).toBe(true);
		expect(
			actions.some(
				(action) =>
					action.op === "set" && action.key === `Software\\Classes\\${fileProgId(".pdf")}` && action.name === null,
			),
		).toBe(true);
	});

	it("全部取消时把 RegisteredApplications 登记与自己的键都收掉", () => {
		const actions = planIntegrationActions(
			{ browser: true, extensions: [".pdf"] },
			{ browser: false, extensions: [] },
			EXE,
		);
		expect(
			actions.some((action) => action.op === "deleteKey" && action.key === `Software\\Classes\\${BROWSER_PROG_ID}`),
		).toBe(true);
		expect(
			actions.some(
				(action) =>
					action.op === "deleteValue" &&
					action.key === "Software\\RegisteredApplications" &&
					action.name === INTEGRATION_APP_NAME,
			),
		).toBe(true);
		expect(actions.some((action) => action.op === "deleteValue" && action.name === fileProgId(".pdf"))).toBe(true);
		expect(actions.some((action) => action.op === "deleteKey" && action.key === "Software\\PiWebUI")).toBe(true);
	});

	it("removalActions 覆盖浏览器与每个扩展名", () => {
		const actions = removalActions([".pdf", ".docx"]);
		expect(actions.filter((action) => action.op === "deleteKey").length).toBeGreaterThanOrEqual(3);
		expect(actions.some((action) => action.op === "deleteValue" && action.name === fileProgId(".docx"))).toBe(true);
	});
});

describe("执行器", () => {
	it("删不存在的键不算失败，set 失败才上报", async () => {
		const runner = vi.fn<RegistryRunner>(async (args) => {
			if (args[0] === "delete") return { ok: false, stdout: "", stderr: "not found" };
			if (args.includes("/v") && args.includes("Bad")) return { ok: false, stdout: "", stderr: "boom" };
			return { ok: true, stdout: "", stderr: "" };
		});
		const result = await applyRegistryActions(
			[
				{ op: "deleteKey", key: "Software\\Classes\\Missing" },
				{ op: "set", key: "Software\\Classes\\X", name: "Bad", value: "v" },
			],
			runner,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("boom");
		expect(result.failed).toHaveLength(1);
	});

	it("读状态：注册项指向当前 exe → registered 且不 stale；换目录后可识别", async () => {
		const queryOut = (key: string, name: string | null): string => {
			const lower = key.toLowerCase();
			if (
				lower.endsWith(`${BROWSER_PROG_ID.toLowerCase()}\\shell\\open\\command`) ||
				lower.endsWith(`${BROWSER_CLIENT_KEY.toLowerCase()}\\shell\\open\\command`)
			)
				return regOutput(key, [["(默认)", shellCommand(EXE)]]);
			if (lower.endsWith("urlassociations\\https\\userchoice")) return regOutput(key, [["ProgId", BROWSER_PROG_ID]]);
			if (lower === "software\\registeredapplications")
				return regOutput(key, [[INTEGRATION_APP_NAME, CAPABILITIES_KEY]]);
			if (lower === CAPABILITIES_KEY.toLowerCase()) return regOutput(key, [["ApplicationName", INTEGRATION_APP_NAME]]);
			if (lower === `${CAPABILITIES_KEY.toLowerCase()}\\fileassociations`)
				return regOutput(key, [[".pdf", fileProgId(".pdf")]]);
			if (lower.endsWith(`\\${fileProgId(".pdf").toLowerCase()}\\shell\\open\\command`))
				return regOutput(key, [["(默认)", shellCommand(EXE)]]);
			if (lower.endsWith("openwithprogids")) return regOutput(key, [[fileProgId(".pdf"), ""]]);
			if (lower.endsWith("userchoice")) return regOutput(key, [["ProgId", fileProgId(".pdf")]]);
			return "";
		};
		const runner: RegistryRunner = async (args) => {
			const key = (args[1] ?? "").replace(/^HKCU\\/i, "");
			if (args[0] !== "query") return { ok: true, stdout: "", stderr: "" };
			const valueIndex = args.indexOf("/v");
			const name = valueIndex >= 0 ? (args[valueIndex + 1] ?? null) : null;
			const stdout = queryOut(key, name);
			return { ok: stdout !== "", stdout, stderr: "" };
		};

		const same = await readIntegrationState({ runner, exePath: EXE, extensions: [".pdf"] });
		expect(same.supported).toBe(process.platform === "win32");
		if (!same.supported) return;
		expect(same.registered).toBe(true);
		expect(same.stale).toBe(false);
		expect(same.browser.registered).toBe(true);
		expect(same.browser.isDefault).toBe(true);
		expect(same.files[0]).toMatchObject({ ext: ".pdf", registered: true, isDefault: true });

		const moved = await readIntegrationState({ runner, exePath: "D:\\Portable\\pi.exe", extensions: [".pdf"] });
		expect(moved.stale).toBe(true);
		expect(moved.files[0]?.registered).toBe(false);
	});

	it("stale 时刷新会把 ProgId 重写到当前 exe", async () => {
		const runner = vi.fn<RegistryRunner>(async () => ({ ok: true, stdout: "", stderr: "" }));
		const refreshed = await refreshStaleRegistration(
			{
				supported: true,
				platform: "win32",
				packaged: true,
				exePath: "D:\\Portable\\pi.exe",
				registered: true,
				stale: true,
				registeredExe: EXE,
				browser: { progId: BROWSER_PROG_ID, registered: true, isDefault: false },
				files: [{ ext: ".pdf", progId: fileProgId(".pdf"), registered: false, isDefault: false }],
			},
			runner,
		);
		expect(refreshed).toBe(true);
		expect(runner.mock.calls.some((call) => call[0].some((arg) => arg.includes('"D:\\Portable\\pi.exe"')))).toBe(true);
	});
});

describe("本地记录与真实注册表对齐", () => {
	const storedEmpty = { browser: false, extensions: [] };
	const nextEmpty = { browser: false, extensions: [] };
	/** 用户在系统里手动注册了浏览器 + .pdf，但本地 system-integration.json 一个字都没记。 */
	const manuallyRegistered = () =>
		queryRunner({
			[BROWSER_COMMAND_KEY]: [["(默认)", shellCommand(EXE)]],
			[CLIENT_COMMAND_KEY]: [["(默认)", shellCommand(EXE)]],
			[PDF_OPEN_WITH_KEY]: [[fileProgId(".pdf"), ""]],
			[PDF_COMMAND_KEY]: [["(默认)", shellCommand(EXE)]],
		});
	const readRegistered = () =>
		readIntegrationState({
			runner: manuallyRegistered(),
			exePath: EXE,
			extensions: DEFAULT_ASSOCIATION_EXTENSIONS,
			platform: "win32",
		});

	it("手动注册但无本地记录 → 回显勾选", async () => {
		const state = await readRegistered();
		expect(state.browser.registered).toBe(true);
		expect(reconcileIntegrationSelection(storedEmpty, state)).toEqual({ browser: true, extensions: [".pdf"] });
	});

	it("回读后的 current 取消勾选 → 生成删除动作", async () => {
		const state = await readRegistered();
		const current = reconcileIntegrationSelection(storedEmpty, state);
		// 只用本地文件当 current 时，真实存在的 .pdf 注册会被漏删。
		const naive = planIntegrationActions(storedEmpty, nextEmpty, EXE);
		expect(naive.some((action) => action.op === "deleteValue" && action.name === fileProgId(".pdf"))).toBe(false);

		const actions = planIntegrationActions(current, nextEmpty, EXE);
		expect(
			actions.some((action) => action.op === "deleteKey" && action.key === `Software\\Classes\\${BROWSER_PROG_ID}`),
		).toBe(true);
		expect(actions.some((action) => action.op === "deleteKey" && action.key === BROWSER_CLIENT_KEY)).toBe(true);
		expect(actions.some((action) => action.op === "deleteValue" && action.name === fileProgId(".pdf"))).toBe(true);
	});

	it("旧版缺 StartMenuInternet command 仍算浏览器已注册；只剩它也能识别 stale", async () => {
		const oldProgIdOnly = await readIntegrationState({
			runner: queryRunner({ [BROWSER_COMMAND_KEY]: [["(默认)", shellCommand(EXE)]] }),
			exePath: EXE,
			extensions: [],
			platform: "win32",
		});
		expect(oldProgIdOnly.browser.registered).toBe(true);
		expect(oldProgIdOnly.registeredExe).toBe(EXE);
		expect(oldProgIdOnly.stale).toBe(false);

		const oldExe = "D:\\Old\\pi.exe";
		const clientOnly = await readIntegrationState({
			runner: queryRunner({ [CLIENT_COMMAND_KEY]: [["(默认)", shellCommand(oldExe)]] }),
			exePath: EXE,
			extensions: [],
			platform: "win32",
		});
		expect(clientOnly.browser.registered).toBe(true);
		expect(clientOnly.registeredExe).toBe(oldExe);
		expect(clientOnly.stale).toBe(true);
	});
});
