import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { documentKey, fileVersion, resolvePreviewPath, safeWorkspacePath, writeDocumentAtomic } from "./runtime.mjs";
import { registerRemoteCanvas } from "./remote-service.mjs";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GATEWAY_ENTRY = join(__dirname, "artifacts", "gateway.cjs");
const WORKER_ENTRY = join(__dirname, "artifacts", "unit-content-worker.mjs");
const VIEWER_ROOT = join(__dirname, "artifacts", "viewer");
const PLUGIN_NODE_MODULES = join(__dirname, "node_modules");

const UNIVER_ASSET_SPEC = {
	id: "univer-runtime",
	targetDir: "artifacts",
	urls: [
		process.env.PI_WEB_UNIVER_RUNTIME_URL,
		"https://github.com/xing-shuyin/pi-web-ui/releases/download/v0.111.0/univer-artifacts.tar.gz",
		"https://github.com/xing-shuyin/pi-web-ui/releases/download/v0.110.0/univer-artifacts.tar.gz",
	].filter(Boolean),
	sha256: "9d172e72dc9ca657967434b9cf7b4dd89df7f7eb25dcf7ab1f1ea8592014f196",
	testFile: "gateway.cjs",
	size: 35380332,
	description: "Univer Office 1:1 Canvas runtime rendering and editing gateway",
};

export function assertInWorkspace(absPath, cwd) {
	return safeWorkspacePath(absPath, cwd);
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

async function waitForGateway(origin, signal, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (signal.aborted) return false;
		try {
			const r = await fetch(`${origin}/`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

export default {
	async activate(host) {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-univer-"));
		const lifecycle = new AbortController();
		const nativeFetch = globalThis.fetch;
		async function fetch(url, options = {}) {
			const response = await nativeFetch(url, {
				...options,
				signal: AbortSignal.any([
					lifecycle.signal,
					AbortSignal.timeout(60_000),
					...(options.signal ? [options.signal] : []),
				]),
			});
			if (!response.ok) throw new Error(`Office gateway HTTP ${response.status}`);
			return response;
		}
		let startPromise = null;
		let generation = 0;
		let activeOperations = 0;

		let gatewayPort = 0;
		let gatewayOrigin = "";
		let gatewayProc = null;
		let gatewayReady = false;
		let lastActivityTime = 0;
		let idleTimer = null;

		const IDLE_TIMEOUT_MS = Math.max(
			60_000,
			Number(process.env.PI_WEB_OFFICE_IDLE_TIMEOUT_MS ?? 15 * 60 * 1000) || 15 * 60 * 1000,
		);

		function touchActivity() {
			lastActivityTime = Date.now();
			if (!idleTimer) {
				idleTimer = setInterval(() => {
					if (!gatewayReady || !gatewayProc) return;
					if (activeOperations === 0 && Date.now() - lastActivityTime >= IDLE_TIMEOUT_MS) {
						stopGateway("idle");
					}
				}, 15_000);
			}
		}

		function stopGateway(reason = "manual") {
			generation++;
			if (gatewayProc) {
				try {
					gatewayProc.kill();
				} catch {}
				gatewayProc = null;
			}
			gatewayReady = false;
			if (reason === "idle") {
				host.log(`Univer Gateway 网关已进入空闲休眠（已释放系统内存与端口 ${gatewayPort}）`);
			}
			gatewayPort = 0;
			gatewayOrigin = "";
		}

		const provisioningState = {
			downloading: false,
			progress: 0,
			total: 0,
			downloaded: 0,
			error: null,
		};

		async function startGateway() {
			if (lifecycle.signal.aborted) throw new Error("Office plugin stopped");
			if (startPromise) return startPromise;
			startPromise = launchGateway().finally(() => {
				startPromise = null;
			});
			return startPromise;
		}

		async function launchGateway() {
			const currentGeneration = generation;
			touchActivity();
			if (gatewayReady) return true;
			if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT)) {
				return false;
			}

			gatewayPort = await getFreePort();
			if (lifecycle.signal.aborted || generation !== currentGeneration) return false;
			gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

			const childEnv = {
				...process.env,
				UNIVER_COLLAB_GATEWAY_PORT: String(gatewayPort),
				UNIVER_VIEW_ASSETS_ROOT: VIEWER_ROOT,
				UNIVER_ALLOWED_ROOT: cacheDir,
				NODE_PATH: [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(delimiter),
			};

			gatewayProc = spawn(process.execPath, ["--require", join(__dirname, "gateway-guard.cjs"), GATEWAY_ENTRY], {
				env: childEnv,
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});
			const child = gatewayProc;
			child.on("error", (err) => {
				host.log(`Univer Gateway 进程错误: ${err.message}`);
			});
			child.once("exit", () => {
				if (gatewayProc === child) {
					gatewayProc = null;
					gatewayReady = false;
				}
			});
			const ready = await waitForGateway(gatewayOrigin, lifecycle.signal);
			if (currentGeneration !== generation || gatewayProc !== child) return false;
			gatewayReady = ready;
			if (!ready) stopGateway("timeout");
			if (gatewayReady) {
				host.log(`Univer 真实画布渲染网关已就绪: ${gatewayOrigin}`);
			} else {
				host.log(`Univer Gateway 启动超时 (port: ${gatewayPort})`);
			}
			return gatewayReady;
		}

		if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT)) {
			host.log("Univer 运行时资产尚未就绪，将在首次需要时按需下载（约 34MB）");
		}

		let activeDownloadPromise = null;

		async function ensureRuntime() {
			lifecycle.signal.throwIfAborted();
			touchActivity();
			if (existsSync(GATEWAY_ENTRY) && existsSync(VIEWER_ROOT) && existsSync(WORKER_ENTRY)) return { ok: true };
			if (activeDownloadPromise) return activeDownloadPromise;
			if (!host.assets?.ensure)
				throw new Error(
					"Office requires a host with the verified asset installer. Update pi-web-ui before installing the runtime.",
				);
			activeDownloadPromise = (async () => {
				provisioningState.downloading = true;
				provisioningState.error = null;
				try {
					const result = await host.assets.ensure(UNIVER_ASSET_SPEC, {
						onProgress: (p) =>
							Object.assign(provisioningState, { downloaded: p.downloaded, total: p.total, progress: p.percent }),
					});
					lifecycle.signal.throwIfAborted();
					if (!result.ok) throw new Error(result.error || "Office runtime installation failed");
					if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT) || !existsSync(WORKER_ENTRY))
						throw new Error("Office runtime installation is incomplete");
					return result;
				} catch (error) {
					provisioningState.error = error.message;
					throw error;
				} finally {
					provisioningState.downloading = false;
				}
			})().finally(() => {
				activeDownloadPromise = null;
			});
			return activeDownloadPromise;
		}

		async function ensureGatewayReady() {
			touchActivity();
			if (gatewayReady) return true;
			if (!existsSync(GATEWAY_ENTRY) || !existsSync(VIEWER_ROOT)) {
				host.log("Univer 运行时资产未就绪，正在按需自动下载解压 (~34MB)...");
				await ensureRuntime();
			}
			const ok = await startGateway();
			if (!ok) {
				throw new Error("Univer 渲染网关尚未就绪，请先安装运行时组件");
			}
			return true;
		}

		const conversionCache = new Map();
		const operationContext = new AsyncLocalStorage();
		const operationQueues = new Map();
		async function withDocument(inputPath, task) {
			const path = resolvePreviewPath(inputPath, host.cwd);
			if (operationContext.getStore() === path) return task(path);
			const previous = operationQueues.get(path) || Promise.resolve();
			const pending = previous
				.catch(() => {})
				.then(async () => {
					lifecycle.signal.throwIfAborted();
					activeOperations++;
					touchActivity();
					try {
						return await operationContext.run(path, () => task(path));
					} finally {
						activeOperations--;
						touchActivity();
					}
				});
			operationQueues.set(path, pending);
			try {
				return await pending;
			} finally {
				if (operationQueues.get(path) === pending) operationQueues.delete(path);
			}
		}

		const pendingConversions = new Map();
		const MAX_FILE_BYTES = 64 * 1024 * 1024;
		const MAX_DOCUMENTS = 32;
		async function prepareUniverDoc(inputPath) {
			return withDocument(inputPath, prepareDocument);
		}
		async function prepareDocument(absPath) {
			if (pendingConversions.has(absPath)) return pendingConversions.get(absPath);
			const pending = convertDocument(absPath).finally(() => pendingConversions.delete(absPath));
			pendingConversions.set(absPath, pending);
			return pending;
		}
		async function convertDocument(absPath) {
			await ensureGatewayReady();
			const existing = conversionCache.get(absPath);
			if (existing) {
				if (existing.generation !== generation) {
					await fetch(`${gatewayOrigin}/uf/${existing.fileKey}`, { method: "POST" });
					existing.generation = generation;
					existing.viewerUrl = `${gatewayOrigin}/?file=${encodeURIComponent(existing.univerPath)}&unit=${encodeURIComponent(existing.unitId)}&mode=embedded&editable=true`;
				}
				return existing;
			}
			if (conversionCache.size >= MAX_DOCUMENTS)
				throw new Error("Office document limit reached (32). Close and reload the plugin to release documents.");
			const st = statSync(absPath);
			if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error("Office requires a regular file of at most 64 MiB");
			const version = fileVersion(absPath);
			if (![".xlsx", ".docx", ".pptx", ".csv", ".tsv"].includes(extname(absPath).toLowerCase()))
				throw new Error(
					"Unsupported format. Convert to .xlsx, .docx or .pptx first; macro and legacy formats cannot be safely round-tripped.",
				);
			const fileName = basename(absPath).replace(/[\r\n"\\]/g, "_");
			const hash = documentKey(absPath);
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
			if (!taskID) throw new Error("Office import did not return a task ID");

			let unitId = null;
			for (let i = 0; i < 200; i++) {
				await new Promise((r) => setTimeout(r, 150));
				const tRes = await fetch(`${gatewayOrigin}/uf/${fileKey}/universer-api/exchange/task/${taskID}`);
				const tData = await tRes.json();
				if (tData.status === "failed")
					throw new Error(`Office import failed: ${tData.error?.message || "unknown error"}`);
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
				version,
				generation,
				unitId,
				viewerUrl: `${gatewayOrigin}/?file=${encodeURIComponent(univerPath)}&unit=${encodeURIComponent(unitId)}&mode=embedded&editable=true`,
				fileKey,
				unitType,
				format,
			};

			if (JSON.stringify(fileVersion(absPath)) !== JSON.stringify(version))
				throw new Error("File changed during import; reopen the document");
			conversionCache.set(absPath, result);
			return result;
		}

		async function saveUniverDoc(absPath, targetPath) {
			return withDocument(absPath, (path) => exportDocument(path, targetPath));
		}
		async function exportDocument(absPath, targetPath) {
			const doc = await prepareUniverDoc(absPath);
			let options;
			if (["csv", "tsv"].includes(doc.format)) {
				const workbook = await inspectUniverDoc(absPath, { kind: "workbook" });
				const sheetId = workbook?.worksheets?.[0]?.id;
				if (!sheetId) throw new Error("Delimited export requires a worksheet");
				options = { sheet: { csv: { sheetId } } };
			}
			const expRes = await fetch(`${gatewayOrigin}/uf/${doc.fileKey}/universer-api/exchange/${doc.unitType}/export`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ unitID: doc.unitId, format: doc.format, ...(options ? { options } : {}) }),
			});
			const expData = await expRes.json();
			if (!expData.taskID) {
				throw new Error(`Univer 导出任务创建失败: ${expData.error?.message || "未知原因"}`);
			}

			let expFileId = null;
			for (let i = 0; i < 250; i++) {
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

			const chunks = [];
			let bytes = 0;
			for await (const chunk of dlRes.body) {
				bytes += chunk.length;
				if (bytes > MAX_FILE_BYTES) throw new Error("Office export exceeds 64 MiB");
				chunks.push(chunk);
			}
			const buf = Buffer.concat(chunks);
			const outPath = assertInWorkspaceLocal(targetPath ? resolve(host.cwd, targetPath) : absPath);
			if (extname(outPath).toLowerCase() !== extname(absPath).toLowerCase())
				throw new Error("Save As must preserve the document extension");
			const newVersion = writeDocumentAtomic(outPath, buf, {
				expectedVersion: outPath === absPath ? doc.version : null,
				overwrite: outPath === absPath,
			});
			if (outPath === absPath) doc.version = newVersion;

			return { ok: true, path: outPath, size: buf.length };
		}

		async function runWorker(payload, timeoutMs = 20000) {
			if (!existsSync(WORKER_ENTRY)) throw new Error("缺少 unit-content-worker.mjs 资产");
			return new Promise((resolveResult, reject) => {
				const wp = spawn(process.execPath, [WORKER_ENTRY], {
					env: {
						...process.env,
						UNIVER_COLLAB_GATEWAY_PORT: String(gatewayPort),
						UNIVER_VIEW_ASSETS_ROOT: VIEWER_ROOT,
						UNIVER_ALLOWED_ROOT: cacheDir,
						NODE_PATH: [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(delimiter),
					},
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				let out = "";
				let err = "";
				const cancel = () => {
					wp.kill();
					reject(new Error("Office operation cancelled"));
				};
				lifecycle.signal.addEventListener("abort", cancel, { once: true });
				if (lifecycle.signal.aborted) {
					cancel();
					return;
				}
				wp.once("error", (error) => {
					clearTimeout(timer);
					lifecycle.signal.removeEventListener("abort", cancel);
					reject(error);
				});
				const timer = setTimeout(() => {
					try {
						wp.kill();
					} catch {}
					reject(new Error(`Univer Worker 执行超时 (${timeoutMs}ms)`));
				}, timeoutMs);

				wp.stdout?.on("data", (d) => {
					out += String(d);
					if (out.length > 1_000_000) {
						wp.kill();
						reject(new Error("Office output too large; query a smaller range"));
					}
				});
				wp.stderr?.on("data", (d) => {
					err = (err + String(d)).slice(-8192);
				});
				wp.on("close", (code) => {
					clearTimeout(timer);
					lifecycle.signal.removeEventListener("abort", cancel);
					try {
						const res = JSON.parse(out);
						if (res.ok) resolveResult(res.result);
						else reject(new Error(res.error?.message || `Worker 失败 (code ${code}): ${err}`));
					} catch {
						reject(new Error(`Worker 解析失败 (code ${code}): ${out} ${err}`));
					}
				});
				wp.stdin?.on("error", (error) => {
					wp.kill();
					reject(error);
				});
				wp.stdin?.write(JSON.stringify(payload));
				wp.stdin?.end();
			});
		}

		async function inspectUniverDoc(absPath, query) {
			return withDocument(absPath, (path) => inspectDocument(path, query));
		}
		async function inspectDocument(absPath, query) {
			const doc = await prepareUniverDoc(absPath);
			const defaultKind = doc.unitType === 2 ? "workbook" : doc.unitType === 1 ? "document" : "presentation";
			const inspection = await runWorker({
				operation: "inspect",
				gatewayOrigin,
				commitTimeoutMs: 10000,
				fileKey: doc.fileKey,
				filePath: doc.univerPath,
				unitId: doc.unitId,
				unitType: doc.unitType,
				query: query || { kind: defaultKind },
			});
			if (inspection?.ok === false) throw new Error(inspection.error?.message || "Office inspection failed");
			return inspection?.ok === true && Object.hasOwn(inspection, "value") ? inspection.value : inspection;
		}

		async function readSheetRange(absPath, params) {
			if (!/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/i.test(params.range || ""))
				throw new Error("A bounded cell range such as A1:D100 is required");
			const cells = params.range
				.toUpperCase()
				.split(":")
				.map((cell) => {
					const [, col, row] = cell.match(/^([A-Z]+)(\d+)$/);
					return [Array.from(col).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), Number(row)];
				});
			const end = cells[1] || cells[0];
			if ((Math.abs(end[0] - cells[0][0]) + 1) * (Math.abs(end[1] - cells[0][1]) + 1) > 10_000)
				throw new Error("Query at most 10,000 cells at a time");
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

		async function executeOnUniverDoc(absPath, code, options) {
			return withDocument(absPath, (path) => executeDocument(path, code, options));
		}
		async function executeDocument(absPath, code, options) {
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

		async function editSheetRange(absPath, params) {
			if (
				params.values &&
				(params.values.length > 10_000 ||
					params.values.reduce((count, row) => count + (Array.isArray(row) ? row.length : 10_001), 0) > 10_000)
			)
				throw new Error("Edit at most 10,000 cells at a time");
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

		const remoteCanvas = registerRemoteCanvas(host, {
			prepare: (path) => prepareUniverDoc(resolve(host.cwd, path)),
			viewerRoot: VIEWER_ROOT,
			getOrigin: () => gatewayOrigin,
			signal: lifecycle.signal,
			touch: touchActivity,
		});

		function assertInWorkspaceLocal(absPath) {
			if (typeof host.resolveInWorkspace === "function") {
				const allowed = host.resolveInWorkspace(absPath);
				let ancestor = allowed;
				const suffix = [];
				while (true) {
					try {
						return host.resolveInWorkspace(join(realpathSync(ancestor), ...suffix));
					} catch (error) {
						if (error.code !== "ENOENT") throw error;
						try {
							lstatSync(ancestor);
							throw new Error("Cannot resolve existing Office path");
						} catch (statError) {
							if (statError.code !== "ENOENT") throw statError;
						}
						const parent = dirname(ancestor);
						if (parent === ancestor) throw error;
						suffix.unshift(basename(ancestor));
						ancestor = parent;
					}
				}
			}
			return assertInWorkspace(absPath, host.cwd);
		}

		host.route("GET", "/status", async (_req, res) => {
			const assetStatus = host.assets?.status
				? host.assets.status(UNIVER_ASSET_SPEC)
				: {
						ready: existsSync(GATEWAY_ENTRY) && existsSync(VIEWER_ROOT),
						downloading: provisioningState.downloading,
						progress: provisioningState.progress,
						downloaded: provisioningState.downloaded,
						total: provisioningState.total,
						error: provisioningState.error,
					};

			res.json({
				ok: true,
				ready: gatewayReady,
				origin: gatewayOrigin,
				port: gatewayPort,
				hasArtifacts: assetStatus.ready,
				downloading: assetStatus.downloading,
				progress: assetStatus.progress,
				total: assetStatus.total,
				downloaded: assetStatus.downloaded,
				error: assetStatus.error,
			});
		});

		host.route("POST", "/provision-runtime", async (_req, res) => {
			try {
				const current = host.assets?.status?.(UNIVER_ASSET_SPEC) || provisioningState;
				if (current.downloading) {
					return res.json({ ok: true, message: "Download already in progress", state: current });
				}
				await ensureRuntime();
				const started = await startGateway();
				if (!started) throw new Error("运行时解压成功但启动网关守护进程超时");
				res.json({ ok: true });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

		host.route("GET", "/open", async (req, res) => {
			try {
				const relPath = String(req.query?.path ?? "").trim();
				if (!relPath) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });

				const absPath = resolve(host.cwd, relPath);
				if (!existsSync(absPath)) return void res.status(404).json({ ok: false, error: "文件不存在" });

				const docInfo = await withDocument(absPath, async (path) => {
					if (req.query?.reload === "1") {
						const old = conversionCache.get(path);
						if (old) remoteCanvas.closeDocument(old.fileKey);
						conversionCache.delete(path);
						if (old) rmSync(old.univerPath, { force: true });
					}
					return prepareUniverDoc(path);
				});
				res.json({ ok: true, ...docInfo });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message || String(err) });
			}
		});

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

		host.route("POST", "/read-sheet", async (req, res) => {
			try {
				const path = assertInWorkspaceLocal(resolve(host.cwd, String(req.body?.path || "")));
				const result = await readSheetRange(path, { sheet: req.body?.sheet, range: req.body?.range });
				res.json({ ok: true, result });
			} catch (error) {
				res.status(error.statusCode || 500).json({ ok: false, error: error.message });
			}
		});

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

		host.route("GET", "/list", async (_req, res) => {
			try {
				const supported = new Set([".pptx", ".xlsx", ".docx", ".csv", ".tsv"]);
				const files = [];
				for (const pat of [...supported].map((ext) => `**/*${ext}`)) {
					try {
						for (const f of await host.fs.glob(pat)) {
							const ext = extname(f).toLowerCase();
							if (supported.has(ext) && files.length < 2000) files.push(f);
						}
					} catch (error) {
						host.log("warn", `Office list: ${error.message}`);
					}
				}
				res.json({ ok: true, files: [...new Set(files)].sort(), truncated: files.length >= 2000 });
			} catch (err) {
				res.status(err?.statusCode || 500).json({ ok: false, error: err.message });
			}
		});

		host.registerTool?.({
			name: "office",
			description:
				"Inspect structure, read cells, batch update tables, or execute Univer scripts on Office files (.xlsx, .docx, .pptx) with explicit export and conflict-checked save to disk.",
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
					addSheet: { type: "string", description: "Name of a new worksheet for edit_sheet." },
					targetPath: {
						type: "string",
						description: "New workspace-relative destination for save; must not exist and must preserve the extension.",
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
				let absPath;
				try {
					absPath = assertInWorkspaceLocal(resolve(host.cwd, relPath));
				} catch (error) {
					return `Error: ${error.message}`;
				}
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
								return `### Workbook Structure: ${basename(absPath)}\n${sheets}`;
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
							return `### Read Range: ${r.sheet}!${r.range}\n\n${mdTable}`;
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
							const res = await saveUniverDoc(absPath, args.targetPath);
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
			const child = gatewayProc;
			const closed =
				child && child.exitCode == null
					? new Promise((done) => {
							child.once("exit", done);
							const timer = setTimeout(done, 5000);
							timer.unref?.();
							child.once("exit", () => clearTimeout(timer));
						})
					: Promise.resolve();
			if (idleTimer) {
				clearInterval(idleTimer);
				idleTimer = null;
			}
			lifecycle.abort();
			stopGateway("shutdown");
			conversionCache.clear();
			void Promise.allSettled([closed, ...operationQueues.values(), ...pendingConversions.values()])
				.then(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
				.catch((error) => host.log("warn", `Office cache cleanup failed: ${error.message}`));
		};
	},
};
