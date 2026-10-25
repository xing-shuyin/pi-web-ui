/**
 * office 服务端运行时 —— 基于 Univer Canvas 引擎的高保真 Office 原生预览与编辑插件。
 *
 * 架构：
 * 1. 采用纯插件化解耦设计，不随 npm 发布大体积二进制包；
 * 2. 首次使用时支持按需自动流式下载解压 ~34MB 运行时资产（artifacts）；
 * 3. 激活时拉起本地隔离的 Univer Gateway 守护进程（动态端口）；
 * 4. 注册 fileHandlers 接管 .pptx / .docx / .xlsx 文件的 1:1 Canvas 渲染与双向编辑；
 * 5. 注册 AI 专属工具 office，支持结构化表格查询、读写与无损写回磁盘。
 */
import { execSync, spawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GATEWAY_ENTRY = join(__dirname, "artifacts", "gateway.cjs");
const WORKER_ENTRY = join(__dirname, "artifacts", "unit-content-worker.mjs");
const VIEWER_ROOT = join(__dirname, "artifacts", "viewer");
const PLUGIN_NODE_MODULES = join(__dirname, "node_modules");

const DEFAULT_RUNTIME_URL =
	process.env.PI_WEB_UNIVER_RUNTIME_URL ||
	"https://github.com/xing-shuyin/pi-web-ui/releases/download/v0.111.0/univer-artifacts.tar.gz";

/** 工作区边界：relPath/targetPath 解析后必须落在 cwd 内，防越界读写
 *  （`../../secret` 之类可借路由读写工作区外任意文件）。 */
export function assertInWorkspace(absPath, cwd) {
	const root = resolve(cwd);
	const abs = resolve(absPath);
	if (abs !== root && !abs.startsWith(root + sep)) {
		const err = new Error("路径超出工作区范围");
		err.statusCode = 403;
		throw err;
	}
	return abs;
}

function getUnitTypeAndFormat(extOrPath) {
	const ext = extname(extOrPath).toLowerCase();
	switch (ext) {
		case ".xlsx":
		case ".xlsm":
		case ".xls":
			return { unitType: 2, format: "xlsx" };
		case ".docx":
		case ".doc":
			return { unitType: 1, format: "docx" };
		case ".pptx":
		case ".pptm":
		case ".ppsx":
		case ".potx":
		case ".ppt":
			return { unitType: 3, format: "pptx" };
		case ".csv":
			return { unitType: 2, format: "csv" };
		case ".tsv":
			return { unitType: 2, format: "tsv" };
		default:
			return { unitType: 2, format: "xlsx" };
	}
}

function getFreePort(start = 9520) {
	return new Promise((resolvePort) => {
		const s = createServer();
		s.listen(start, "127.0.0.1", () => {
			const port = s.address().port;
			s.close(() => resolvePort(port));
		});
		s.on("error", () => resolvePort(getFreePort(start + 1)));
	});
}

async function waitForGateway(origin, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) });
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

export default {
	async activate(host) {
		const cacheDir = join(tmpdir(), "pi-univer-cache");
		mkdirSync(cacheDir, { recursive: true });

		let gatewayPort = 0;
		let gatewayOrigin = "";
		let gatewayProc = null;
		let gatewayReady = false;

		const provisioningState = {
			downloading: false,
			progress: 0,
			total: 0,
			downloaded: 0,
			error: null,
		};

		async function startGateway() {
			if (gatewayReady) return true;
			if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT)) {
				return false;
			}

			gatewayPort = await getFreePort();
			gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

			const childEnv = {
				...process.env,
				UNIVER_COLLAB_GATEWAY_PORT: String(gatewayPort),
				UNIVER_VIEW_ASSETS_ROOT: VIEWER_ROOT,
				NODE_PATH: [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(";"),
			};

			gatewayProc = spawn(process.execPath, [GATEWAY_ENTRY], {
				env: childEnv,
				// pipe 却不排水：子进程输出填满 OS 管道缓冲（约 4-64KB）后每次
				// console.log 都会阻塞，网关整体冻结且表现为"就绪后渲染全部超时"。
				// 网关日志量大，这里直接丢弃。
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});
			gatewayProc.on("error", (err) => {
				host.log(`Univer Gateway 进程错误: ${err.message}`);
			});

			gatewayReady = await waitForGateway(gatewayOrigin);
			if (gatewayReady) {
				host.log(`Univer 真实画布渲染网关已就绪: ${gatewayOrigin}`);
			} else {
				host.log(`Univer Gateway 启动超时 (port: ${gatewayPort})`);
			}
			return gatewayReady;
		}

		// 检查本地已有资产并尝试自启
		if (existsSync(GATEWAY_ENTRY) && existsSync(VIEWER_ROOT)) {
			await startGateway();
		} else {
			host.log("Univer 运行时资产尚未就绪，将在首次需要时按需下载（约 34MB）");
		}

		let activeDownloadPromise = null;

		/** 流式下载并解压运行时压缩包 */
		async function downloadAndExtractRuntime() {
			if (existsSync(GATEWAY_ENTRY) && existsSync(VIEWER_ROOT)) {
				await startGateway();
				return { ok: true, message: "Runtime already present" };
			}
			if (activeDownloadPromise) {
				return await activeDownloadPromise;
			}

			activeDownloadPromise = (async () => {
				provisioningState.downloading = true;
				provisioningState.progress = 0;
				provisioningState.error = null;

				const targetTar = join(__dirname, "univer-artifacts.tar.gz");
				try {
					host.log(`正在从 ${DEFAULT_RUNTIME_URL} 下载 Univer 运行时压缩包...`);
					// 停滞连接（对端不发 RST）会让裸 fetch 挂数分钟，期间
					// provisioningState.downloading 卡在 true，一键安装只回
					// "Download already in progress"——整体 10 分钟兜底超时。
					const fetchFn = typeof host.fetch === "function" ? host.fetch.bind(host) : fetch;
					const res = await fetchFn(DEFAULT_RUNTIME_URL, { timeoutMs: 600_000, signal: AbortSignal.timeout(600_000) });
					if (!res.ok) throw new Error(`下载 Univer 运行时失败: HTTP ${res.status}`);

					const total = Number(res.headers.get("content-length") || 0);
					provisioningState.total = total;

					const fileStream = createWriteStream(targetTar);
					// 写盘失败（磁盘满/权限）默认不会抛到 await 链，必须显式监听
					let streamError = null;
					fileStream.on("error", (e) => {
						streamError = e;
					});
					const reader = res.body?.getReader();
					if (!reader) throw new Error("无法读取响应体流");

					let downloaded = 0;
					while (true) {
						if (streamError) throw streamError;
						const { done, value } = await reader.read();
						if (done) break;
						if (value) {
							if (!fileStream.write(Buffer.from(value))) {
								await new Promise((r) => fileStream.once("drain", r));
							}
							downloaded += value.length;
							provisioningState.downloaded = downloaded;
							if (total > 0) {
								provisioningState.progress = Math.round((downloaded / total) * 100);
							}
						}
					}
					await new Promise((r) => fileStream.end(r));
					if (streamError) throw streamError;

					host.log("下载完成，正在解压 Univer 运行时组件...");
					// 解压到 staging 目录、成功后整体替换：tar 顺序解压中途失败（磁盘满/
					// 进程被杀/压缩包截断）会在 artifacts/ 留下 gateway.cjs 已解出而 viewer
					// 只解一半的半成品——所有 existsSync 门禁随即误判"已安装"，且下载
					// 函数开头 short-circuit，再无自愈通道，用户永远只看到"网关启动超时"。
					const stagingDir = join(__dirname, `.univer-staging-${Date.now()}`);
					mkdirSync(stagingDir, { recursive: true });
					try {
						execSync(`tar -xzf "${targetTar}" -C "${stagingDir}"`, { windowsHide: true });
						const extracted = existsSync(join(stagingDir, "artifacts")) ? join(stagingDir, "artifacts") : stagingDir;
						rmSync(join(__dirname, "artifacts"), { recursive: true, force: true });
						renameSync(extracted, join(__dirname, "artifacts"));
					} catch (e) {
						rmSync(join(__dirname, "artifacts"), { recursive: true, force: true });
						throw e;
					} finally {
						rmSync(stagingDir, { recursive: true, force: true });
					}
					try {
						unlinkSync(targetTar);
					} catch {}

					provisioningState.downloading = false;
					provisioningState.progress = 100;

					const started = await startGateway();
					if (!started) throw new Error("运行时解压成功但启动网关守护进程失败");

					host.log("Univer 运行时就绪且网关已成功拉起！");
					return { ok: true };
				} catch (err) {
					provisioningState.downloading = false;
					provisioningState.error = err.message || String(err);
					try {
						unlinkSync(targetTar);
					} catch {}
					host.log(`Univer 运行时自动安装失败: ${provisioningState.error}`);
					throw err;
				}
			})().finally(() => {
				activeDownloadPromise = null;
			});

			return await activeDownloadPromise;
		}

		// 内存缓存：filePath:mtime -> { univerPath, unitId }
		const conversionCache = new Map();

		/** 将工作区 Office 文件转换并注册为 Univer Unit */
		async function prepareUniverDoc(absPath) {
			if (!gatewayReady) {
				if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT)) {
					host.log("Univer 运行时资产未就绪，正在按需自动下载解压 (~34MB)...");
					await downloadAndExtractRuntime();
				} else {
					await startGateway();
				}
				if (!gatewayReady) {
					throw new Error("Univer 渲染网关尚未就绪，请先安装运行时组件");
				}
			}

			const st = statSync(absPath);
			const cacheKey = `${absPath}:${st.mtimeMs}`;
			if (conversionCache.has(cacheKey)) {
				return conversionCache.get(cacheKey);
			}

			const fileName = basename(absPath);
			const ext = extname(absPath).toLowerCase();
			const hash = Buffer.from(absPath).toString("hex").slice(0, 16);
			const univerPath = join(cacheDir, `doc_${hash}.univer`);

			try {
				unlinkSync(univerPath);
			} catch {}

			const fileKey = Buffer.from(univerPath, "utf8").toString("base64url");
			await fetch(`${gatewayOrigin}/uf/${fileKey}`, { method: "POST" });

			const fileBuf = readFileSync(absPath);
			const boundary = `----UniverUpload${Date.now()}`;
			const body = Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
				),
				fileBuf,
				Buffer.from(`\r\n--${boundary}--\r\n`),
			]);

			const uRes = await fetch(
				`${gatewayOrigin}/uf/${fileKey}/universer-api/stream/file/upload?source=1&size=${fileBuf.length}`,
				{
					method: "POST",
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
					body,
				},
			);
			const uData = await uRes.json();
			const fileID = uData.FileId || uData.fileID;
			if (!fileID) throw new Error("文件上传至 Univer 转换网关失败");

			const iRes = await fetch(`${gatewayOrigin}/uf/${fileKey}/universer-api/exchange/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fileID, outputType: 1 }),
			});
			const iData = await iRes.json();
			const taskID = iData.taskID;

			let unitId = null;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 150));
				const tRes = await fetch(`${gatewayOrigin}/uf/${fileKey}/universer-api/exchange/task/${taskID}`);
				const tData = await tRes.json();
				if (tData.status === "done") {
					unitId = tData.import?.unitID || tData.result?.unitID;
					break;
				}
			}

			if (!unitId) {
				const unitsRes = await fetch(`${gatewayOrigin}/uf/${fileKey}/units`);
				const unitsData = await unitsRes.json();
				unitId = unitsData.units?.[0]?.unitId;
			}

			if (!unitId) throw new Error("Univer 原生转换未生成有效单元");

			const { unitType, format } = getUnitTypeAndFormat(absPath);
			const result = {
				univerPath,
				unitId,
				viewerUrl: `${gatewayOrigin}/?file=${encodeURIComponent(univerPath)}&unit=${encodeURIComponent(unitId)}&mode=embedded&editable=true`,
				fileKey,
				unitType,
				format,
			};

			conversionCache.set(cacheKey, result);
			return result;
		}

		/** 将 Univer 单元反向编译导出写回磁盘文件 */
		async function saveUniverDoc(absPath, targetPath) {
			const doc = await prepareUniverDoc(absPath);
			const expRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/universer-api/exchange/${doc.unitType}/export`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ unitID: doc.unitId, format: doc.format }),
			});
			const expData = await expRes.json();
			if (!expData.taskID) {
				throw new Error(`Univer 导出任务创建失败: ${expData.error?.message || "未知原因"}`);
			}

			let expFileId = null;
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 120));
				const tRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/universer-api/exchange/task/${expData.taskID}`);
				const tData = await tRes.json();
				if (tData.status === "done") {
					expFileId = tData.export?.fileID || tData.result?.fileID || null;
					break;
				}
				if (tData.status === "failed") {
					throw new Error(`Univer 导出失败: ${tData.error?.message || "未知错误"}`);
				}
			}

			if (!expFileId) throw new Error("Univer 导出超时未生成文件");

			const dlRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/universer-api/file/${expFileId}/content`);
			if (!dlRes.ok) throw new Error(`下载 Univer 导出文件失败: HTTP ${dlRes.status}`);

			const buf = Buffer.from(await dlRes.arrayBuffer());
			const outPath = targetPath ? assertInWorkspace(resolve(host.cwd, targetPath)) : absPath;
			const tmpOut = `${outPath}.${Date.now()}.tmp`;
			writeFileSync(tmpOut, buf);
			renameSync(tmpOut, outPath);

			try {
				const newSt = statSync(outPath);
				conversionCache.set(`${absPath}:${newSt.mtimeMs}`, doc);
			} catch {}

			return { ok: true, path: outPath, size: buf.length };
		}

		/** 在独立子进程中执行 Univer Worker 请求 */
		async function runWorker(payload, timeoutMs = 20000) {
			if (!existsSync(WORKER_ENTRY)) throw new Error("缺少 unit-content-worker.mjs 资产");
			return new Promise((resolveResult, reject) => {
				const wp = spawn(process.execPath, [WORKER_ENTRY], {
					env: {
						...process.env,
						UNIVER_COLLAB_GATEWAY_PORT: String(gatewayPort),
						UNIVER_VIEW_ASSETS_ROOT: VIEWER_ROOT,
						NODE_PATH: [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(";"),
					},
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				let out = "";
				let err = "";
				const timer = setTimeout(() => {
					try {
						wp.kill();
					} catch {}
					reject(new Error(`Univer Worker 执行超时 (${timeoutMs}ms)`));
				}, timeoutMs);

				wp.stdout?.on("data", (d) => (out += String(d)));
				wp.stderr?.on("data", (d) => (err += String(d)));
				wp.on("close", (code) => {
					clearTimeout(timer);
					try {
						const res = JSON.parse(out);
						if (res.ok) resolveResult(res.result);
						else reject(new Error(res.error?.message || `Worker 失败 (code ${code}): ${err}`));
					} catch {
						reject(new Error(`Worker 解析失败 (code ${code}): ${out} ${err}`));
					}
				});
				wp.stdin?.write(JSON.stringify(payload));
				wp.stdin?.end();
			});
		}

		/** 结构化查询文档 */
		async function inspectUniverDoc(absPath, query) {
			const doc = await prepareUniverDoc(absPath);
			const defaultKind = doc.unitType === 2 ? "workbook" : doc.unitType === 1 ? "document" : "presentation";
			return await runWorker({
				operation: "inspect",
				gatewayOrigin,
				commitTimeoutMs: 10000,
				fileKey: doc.fileKey,
				filePath: doc.univerPath,
				unitId: doc.unitId,
				unitType: doc.unitType,
				query: query || { kind: defaultKind },
			});
		}

		/** 读取表格区域 */
		async function readSheetRange(absPath, params) {
			const query = {
				kind: "worksheet-range",
				ranges: [
					{
						range: params.range,
						worksheet: params.sheet ? { name: params.sheet } : { index: 0 },
					},
				],
			};
			const result = await inspectUniverDoc(absPath, query);
			const r = result?.ranges?.[0];
			return {
				sheet: r?.worksheet?.name || params.sheet || "Sheet1",
				range: r?.resolvedRange || params.range,
				values: r?.displayValues || [],
				cellData: r?.cellData || [],
			};
		}

		/** 在独立分支执行代码并 merge 写回 */
		async function executeOnUniverDoc(absPath, code, options) {
			const doc = await prepareUniverDoc(absPath);
			const wtRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/worktrees`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ agentId: "pi-agent", name: `edit-${Date.now()}` }),
			});
			const wtData = await wtRes.json();
			const worktreeId = wtData.worktreeId;
			if (!worktreeId) throw new Error("无法在 Univer 网关创建协作分支");

			try {
				const execResult = await runWorker({
					operation: "execute",
					gatewayOrigin,
					commitTimeoutMs: 15000,
					fileKey: doc.fileKey,
					filePath: doc.univerPath,
					unitId: doc.unitId,
					unitType: doc.unitType,
					worktreeId,
					code,
				});

				if (execResult?.committed === false) {
					try {
						await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/worktrees/${worktreeId}/discard`, { method: "POST" });
					} catch {}
					return { ok: true, revision: 0, value: execResult?.value ?? null, saved: false };
				}

				await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/worktrees/${worktreeId}/ready`, { method: "POST" });
				const mergeRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/worktrees/${worktreeId}/merge`, {
					method: "POST",
				});
				const mergeData = await mergeRes.json();
				if (!mergeData.ok) {
					throw new Error(`Univer 分支合并失败: ${mergeData.error?.message || "未知原因"}`);
				}

				let saved = false;
				let outPath;
				if (options?.autoSave !== false) {
					const saveRes = await saveUniverDoc(absPath, options?.targetPath);
					saved = saveRes.ok;
					outPath = saveRes.path;
				}

				return {
					ok: true,
					revision: execResult?.revision ?? 0,
					value: execResult?.value ?? null,
					saved,
					outPath,
				};
			} catch (err) {
				try {
					await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/worktrees/${worktreeId}/discard`, { method: "POST" });
				} catch {}
				throw err;
			}
		}

		/** 便捷修改工作表 */
		async function editSheetRange(absPath, params) {
			const lines = [];
			if (params.addSheet) {
				lines.push(`workbook.create(${JSON.stringify(params.addSheet)}, 100, 26);`);
			}
			const sheetSelector = params.sheet
				? `workbook.getSheetByName(${JSON.stringify(params.sheet)})`
				: `workbook.getActiveSheet()`;
			lines.push(`const targetSheet = ${sheetSelector};`);
			lines.push(
				`if (!targetSheet) throw new Error("Worksheet not found: " + ${JSON.stringify(params.sheet || "(active)")});`,
			);
			if (params.range && params.values && params.values.length > 0) {
				lines.push(`const r = targetSheet.getRange(${JSON.stringify(params.range)});`);
				lines.push(`r.setValues(${JSON.stringify(params.values)});`);
			}
			return await executeOnUniverDoc(absPath, lines.join("\n"), {
				autoSave: params.autoSave,
				targetPath: params.targetPath,
			});
		}

		// 路由：查询运行时就绪状态与下载进度
		function assertInWorkspaceLocal(absPath) {
			if (typeof host.resolveInWorkspace === "function") {
				return host.resolveInWorkspace(absPath);
			}
			return assertInWorkspace(absPath, host.cwd);
		}

		host.route("GET", "/status", async (_req, res) => {
			res.json({
				ok: true,
				ready: gatewayReady,
				origin: gatewayOrigin,
				port: gatewayPort,
				hasArtifacts: existsSync(GATEWAY_ENTRY) && existsSync(VIEWER_ROOT),
				...provisioningState,
			});
		});

		// 路由：一键下载并激活运行时
		host.route("POST", "/provision-runtime", async (_req, res) => {
			try {
				if (provisioningState.downloading) {
					return res.json({ ok: true, message: "Download already in progress", state: provisioningState });
				}
				const result = await downloadAndExtractRuntime();
				res.json(result);
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		// 路由：请求打开文件
		host.route("GET", "/open", async (req, res) => {
			try {
				const relPath = String(req.query?.path ?? "").trim();
				if (!relPath) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });

				const absPath = assertInWorkspaceLocal(resolve(host.cwd, relPath));
				if (!existsSync(absPath)) return void res.status(404).json({ ok: false, error: "文件不存在" });

				const docInfo = await prepareUniverDoc(absPath);
				res.json({ ok: true, ...docInfo });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		// 路由：保存写回磁盘
		host.route("POST", "/save", async (req, res) => {
			try {
				const relPath = String(req.body?.path ?? "").trim();
				if (!relPath) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });
				const absPath = assertInWorkspaceLocal(resolve(host.cwd, relPath));
				if (!existsSync(absPath)) return void res.status(404).json({ ok: false, error: "文件不存在" });

				const saved = await saveUniverDoc(absPath, req.body?.targetPath);
				res.json(saved);
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		// 路由：结构化检查
		host.route("POST", "/inspect", async (req, res) => {
			try {
				const relPath = String(req.body?.path ?? "").trim();
				if (!relPath) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });
				const absPath = assertInWorkspaceLocal(resolve(host.cwd, relPath));
				if (!existsSync(absPath)) return void res.status(404).json({ ok: false, error: "文件不存在" });

				const result = await inspectUniverDoc(absPath, req.body?.query);
				res.json({ ok: true, result });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		// 路由：结构化编辑或 Facade 脚本
		host.route("POST", "/edit", async (req, res) => {
			try {
				const relPath = String(req.body?.path ?? "").trim();
				if (!relPath) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });
				const absPath = assertInWorkspaceLocal(resolve(host.cwd, relPath));
				if (!existsSync(absPath)) return void res.status(404).json({ ok: false, error: "文件不存在" });

				const autoSave = req.body?.save !== false;
				if (typeof req.body?.code === "string" && req.body.code.trim().length > 0) {
					const result = await executeOnUniverDoc(absPath, req.body.code, { autoSave });
					res.json(result);
					return;
				}

				const result = await editSheetRange(absPath, {
					sheet: req.body?.sheet,
					range: req.body?.range,
					values: req.body?.values,
					addSheet: req.body?.addSheet,
					autoSave,
				});
				res.json(result);
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		// 路由：列出工作区支持的文件
		host.route("GET", "/list", async (_req, res) => {
			try {
				const supported = new Set([".pptx", ".pptm", ".ppsx", ".potx", ".xlsx", ".xlsm", ".docx"]);
				const files = [];
				for (const pat of ["*.pptx", "*.xlsx", "*.docx", "**/*.pptx", "**/*.xlsx", "**/*.docx"]) {
					try {
						for (const f of await host.fs.glob(pat)) {
							const ext = extname(f).toLowerCase();
							if (supported.has(ext)) files.push(f);
						}
					} catch {}
				}
				res.json({ ok: true, files: [...new Set(files)].sort() });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message });
			}
		});

		// 注册 AI Agent 专用工具：office
		host.registerTool?.({
			name: "office",
			description:
				"Inspect structure, read cells, batch update tables, or execute Univer scripts on Office files (.xlsx, .docx, .pptx) with lossless save back to disk.",
			promptSnippet: "inspect structure, read or edit cells and sheets in .xlsx/.docx/.pptx files",
			promptGuidelines: [
				"Use action='inspect' to discover sheets, dimensions, or outline structure before editing.",
				"Use action='read_sheet' with range (e.g. 'A1:C10') to inspect tabular data accurately.",
				"Use action='edit_sheet' to batch update cell values or formulas with automatic disk save.",
				"Use action='execute' to run advanced Univer Facade JavaScript for complex layouts or styles.",
			],
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["inspect", "read_sheet", "edit_sheet", "execute", "save"],
						description:
							"action to perform (inspect: structure; read_sheet: read cells; edit_sheet: update cells; execute: run Univer JS; save: export to disk).",
					},
					path: {
						type: "string",
						description: "workspace-relative path to the Office file (.xlsx, .docx, .pptx).",
					},
					sheet: {
						type: "string",
						description: "target worksheet name for tabular queries (defaults to active sheet).",
					},
					range: {
						type: "string",
						description: "cell range like 'A1:D10' or single cell like 'B2'.",
					},
					values: {
						type: "array",
						items: { type: "array" },
						description: "2D array of row values for batch cell updates.",
					},
					code: {
						type: "string",
						description: "JavaScript code executing on workbook/doc/presentation via Univer Facade API.",
					},
					save: {
						type: "boolean",
						description: "whether to export and write changes back to disk immediately (default true).",
					},
				},
				required: ["action", "path"],
			},
			async execute(args) {
				const relPath = String(args.path ?? "").trim();
				if (!relPath) return "Error: path parameter is required.";
				const absPath = resolve(host.cwd, relPath);
				if (!existsSync(absPath)) return `Error: file not found at ${relPath}`;

				const action = String(args.action ?? "").trim();
				try {
					switch (action) {
						case "inspect": {
							const res = await inspectUniverDoc(absPath);
							if (res?.kind === "workbook" && Array.isArray(res?.worksheets)) {
								const sheets = res.worksheets
									.map(
										(w) =>
											`- **${w.name}** (id: ${w.id}): ${w.rowCount} rows x ${w.columnCount} cols, used: ${w.valueUsedRanges?.join(", ") || "(empty)"}`,
									)
									.join("\n");
								return `### Workbook Structure: ${basename(absPath)}\n${sheets}\n\nRaw metadata:\n\`\`\`json\n${JSON.stringify(res, null, 2)}\n\`\`\``;
							}
							return `### Document Inspection: ${basename(absPath)}\n\`\`\`json\n${JSON.stringify(res, null, 2)}\n\`\`\``;
						}
						case "read_sheet": {
							const range = String(args.range ?? "").trim();
							if (!range) return "Error: range parameter is required for read_sheet (e.g. 'A1:D10').";
							const r = await readSheetRange(absPath, { sheet: args.sheet, range });
							const displayRows = Array.isArray(r.values) ? r.values : [];
							const mdTable =
								displayRows.length > 0
									? displayRows.map((row) => `| ${row.map((c) => String(c ?? "")).join(" | ")} |`).join("\n")
									: "(No data in range)";
							return `### Read Range: ${r.sheet}!${r.range}\n\n${mdTable}\n\nJSON:\n\`\`\`json\n${JSON.stringify(r.values, null, 2)}\n\`\`\``;
						}
						case "edit_sheet": {
							const values = Array.isArray(args.values) ? args.values : undefined;
							const range = typeof args.range === "string" ? args.range.trim() : undefined;
							if (!range && !values && !args.addSheet) {
								return "Error: edit_sheet requires at least range + values or addSheet.";
							}
							const res = await editSheetRange(absPath, {
								sheet: args.sheet,
								range,
								values,
								addSheet: args.addSheet,
								autoSave: args.save !== false,
							});
							return `Successfully updated ${relPath}:\n- Revision: ${res.revision}\n- Saved to disk: ${res.saved ? "Yes" : "No"}${res.outPath ? ` (${res.outPath})` : ""}`;
						}
						case "execute": {
							const code = String(args.code ?? "").trim();
							if (!code) return "Error: code parameter is required for execute.";
							const res = await executeOnUniverDoc(absPath, code, { autoSave: args.save !== false });
							return `Successfully executed Univer script on ${relPath}:\n- Revision: ${res.revision}\n- Saved: ${res.saved ? "Yes" : "No"}\n- Value: ${JSON.stringify(res.value)}`;
						}
						case "save": {
							const res = await saveUniverDoc(absPath);
							return `Successfully exported and saved ${relPath} (${res.size} bytes).`;
						}
						default:
							return `Error: unknown action '${action}'. Valid actions are: inspect, read_sheet, edit_sheet, execute, save.`;
					}
				} catch (err) {
					return `Error executing office tool: ${err.message || String(err)}`;
				}
			},
		});

		return () => {
			host.log("正在关闭 Univer Gateway 服务...");
			if (gatewayProc) {
				try {
					gatewayProc.kill();
				} catch {}
				gatewayProc = null;
				gatewayReady = false;
			}
		};
	},
};
