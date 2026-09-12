/**
 * image-toolkit 视图 —— 图片处理工作台。
 *
 * 约定：ESM 默认导出 { mount(container, ctx) → cleanup? }，纯 DOM 无依赖
 * （不 import npm 包，浏览器直接执行）。像素处理全在本地 Canvas 完成，
 * 只有「从工作区读」与「存回工作区」才走服务端路由。
 *
 * 结构：
 *   顶部工具条（导入 / 从工作区 / 语言）
 *   左：队列（每项一份自己的参数）
 *   中：画布（缩放、对比原图、裁剪选框）
 *   右：参数面板（压缩/裁剪/尺寸/旋转/水印/滤镜/信息）+ 导出动作
 *
 * 参数与像素分离：item.state 是纯数据（可 JSON 快照 → 撤销/重做、复制到全部），
 * 渲染是 state 的纯函数（renderToCanvas），所以预览、精确估算、导出、批量
 * 走的是同一套代码，参数一致的项结果一定一致。
 */
import { detectLang, makeT } from "./i18n.mjs";
import { clamp, copyImageToClipboard, debounce, downloadBlob, el, fmtBytes, fmtInt, makeZip, stem } from "./util.mjs";
import { drawHistogram, imageStats, parseExif, sniffType } from "./probe.mjs";
import * as ws from "./workspace.mjs";
import { createCropper } from "./crop.mjs";
import { shapeCommands, toPathD } from "./shapes.mjs";
import {
	DEFAULT_CROP_RADIUS,
	alphaFixForShape,
	RATIO_KEYS,
	baseSize,
	defaultState,
	encodeCanvas,
	encodeToTarget,
	extOfMime,
	isLossy,
	isOpaqueFormat,
	outputMime,
	ratioOf,
	renderToCanvas,
	supportsMime,
} from "./pipeline.mjs";

/** 预览渲染的像素预算：适应窗口时用小的（快），放大看细节时给更多（清楚）。
 *  实际渲染尺度还会按「屏幕需要的像素比」再收一次（见 currentPreview），所以这里是上限。 */
const PREVIEW_FIT_PIXELS = 2_600_000;
const PREVIEW_ZOOM_PIXELS = 6_000_000;

const MIME_OF = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

/** 参数路径读写（"adjust.brightness"）。 */
function getPath(o, p) {
	return p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
}

function setPath(o, p, v) {
	const ks = p.split(".");
	const last = ks.pop();
	let cur = o;
	for (const k of ks) cur = cur[k];
	cur[last] = v;
}

/** 源图尺寸（item.bitmap 的宽高）。 */
function srcSize(item) {
	return { width: item.bitmap.width, height: item.bitmap.height };
}

/** 裁剪坐标基于「旋转+任意角度外扩后」的坐标系。 */
function baseOf(item) {
	return baseSize(item.state, item.bitmap.width, item.bitmap.height);
}

function cropRect(item) {
	const b = baseOf(item);
	const c = item.state.crop;
	if (!c || !(c.w > 0) || !(c.h > 0)) return { x: 0, y: 0, w: b.width, h: b.height };
	return {
		x: clamp(c.x, 0, b.width),
		y: clamp(c.y, 0, b.height),
		w: clamp(c.w, 1, b.width),
		h: clamp(c.h, 1, b.height),
	};
}

export default {
	mount(container, ctx) {
		const app = {
			items: [],
			activeId: null,
			lang: detectLang(),
			tab: "compress",
			cfg: {},
			zoom: 0,
			fit: true,
			compare: false,
			grid: true,
			busy: false,
			estimate: null,
			exact: null,
			status: "",
		};
		const t = makeT(() => app.lang);

		let ui = null;
		let cropper = null;
		/** 最近一次渲染用的显示比例（显示像素 / 源像素），裁剪拖动时更新状态文案要用。 */
		let viewScaleNow = 1;
		let cleanupFns = [];

		const active = () => app.items.find((i) => i.id === app.activeId) ?? null;
		const uid = (() => {
			let n = 0;
			return () => `img${++n}`;
		})();

		// ------------------------------------------------------------------
		// 状态与历史
		// ------------------------------------------------------------------
		function varsFor(item) {
			return {
				name: stem(item.name),
				date: new Date().toISOString().slice(0, 10),
				w: String(item.bitmap?.width ?? ""),
				h: String(item.bitmap?.height ?? ""),
			};
		}

		function pushHistory(item) {
			const snap = JSON.stringify(item.state);
			if (item.history[item.histIndex] === snap) return;
			item.history = item.history.slice(0, item.histIndex + 1);
			item.history.push(snap);
			if (item.history.length > 60) item.history.shift();
			item.histIndex = item.history.length - 1;
		}

		function undo(item) {
			if (item.histIndex <= 0) {
				toast(t("msg.undoEmpty"), "warn");
				return;
			}
			item.histIndex--;
			item.state = JSON.parse(item.history[item.histIndex]);
			afterStateChange(item, false);
		}

		function redo(item) {
			if (item.histIndex >= item.history.length - 1) return;
			item.histIndex++;
			item.state = JSON.parse(item.history[item.histIndex]);
			afterStateChange(item, false);
		}

		/** 参数变了：可选重建面板（结构变了）→ 重绘 → 重估体积。 */
		function afterStateChange(item, structural) {
			if (structural) buildPanel();
			else syncPanelValues();
			scheduleRender();
			scheduleEstimate();
		}

		/** 参数变更的统一入口（控件都走这里）。 */
		function commit(item, fn, structural) {
			fn(item.state);
			pushHistory(item);
			app.exact = null;
			afterStateChange(item, structural);
		}

		// ------------------------------------------------------------------
		// 队列
		// ------------------------------------------------------------------
		async function addFiles(files, opts = {}) {
			const list = [...files].filter((f) => /^image\//.test(f.type) || ws.IMAGE_EXT.test(f.name || ""));
			if (!list.length) return;
			for (const f of list) {
				await addOne({ name: f.name, bytes: await f.arrayBuffer(), path: opts.path ?? "" });
			}
			renderQueue();
		}

		/** 解码一张图并建队列项（失败只标记该项，不影响其它）。 */
		async function addOne({ name, bytes, path = "" }) {
			const item = {
				id: uid(),
				name: name || "image",
				path,
				bytes,
				sourceType: sniffType(new Uint8Array(bytes)) || "",
				bitmap: null,
				info: null,
				exif: null,
				stats: null,
				state: defaultState(app.cfg),
				history: [],
				histIndex: -1,
				error: "",
				wmImage: null,
			};
			try {
				item.bitmap = await decodeBytes(bytes, item.sourceType);
				const sz = srcSize(item);
				item.info = {
					width: sz.width,
					height: sz.height,
					bytes: bytes.byteLength,
					type: item.sourceType,
					hasAlpha: /png|webp|avif|gif|svg/i.test(item.sourceType) || item.sourceType === "",
				};
				item.exif = parseExif(new Uint8Array(bytes));
				item.thumb = makeThumb(item);
				pushHistory(item);
				app.items.push(item);
				if (!app.activeId) selectItem(item.id);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				app.items.push({ ...item, error: msg });
				if (!app.activeId) selectItem(item.id);
				toast(t("msg.decodeFail", { name: item.name, msg }), "error");
			}
			return item;
		}

		/** 解码：优先 createImageBitmap（快），失败回落 <img>（SVG 等）。 */
		async function decodeBytes(bytes, type) {
			const blob = new Blob([bytes], { type: type || "application/octet-stream" });
			try {
				return await createImageBitmap(blob);
			} catch {
				/* 走 img 回落 */
			}
			const url = URL.createObjectURL(blob);
			try {
				const img = await new Promise((resolve, reject) => {
					const im = el("img");
					im.onload = () => resolve(im);
					im.onerror = () => reject(new Error("浏览器无法解码这个文件"));
					im.src = url;
				});
				if (!img.naturalWidth || !img.naturalHeight) throw new Error("图片没有有效尺寸");
				return img;
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 5000);
			}
		}

		function selectItem(id) {
			app.activeId = id;
			app.estimate = null;
			app.exact = null;
			app.fit = true;
			app.zoom = 0; // 换图回到适应
			renderQueue();
			buildPanel();
			scheduleRender(true);
		}

		function removeItem(id) {
			const i = app.items.findIndex((x) => x.id === id);
			if (i < 0) return;
			const [gone] = app.items.splice(i, 1);
			gone.bitmap?.close?.();
			if (app.activeId === id) app.activeId = app.items[Math.min(i, app.items.length - 1)]?.id ?? null;
			renderQueue();
			buildPanel();
			scheduleRender(true);
		}

		function setStatus(text) {
			app.status = text;
			if (ui?.statusEl) ui.statusEl.textContent = text;
		}

		function toast(text, level = "info") {
			if (!ui) return;
			const node = el("div", { class: `igt-toast igt-toast-${level}`, text });
			ui.toasts.append(node);
			setTimeout(() => node.classList.add("out"), 2600);
			setTimeout(() => node.remove(), 3200);
		}

		// ------------------------------------------------------------------
		// 渲染
		// ------------------------------------------------------------------
		function previewBudget() {
			return app.fit ? PREVIEW_FIT_PIXELS : PREVIEW_ZOOM_PIXELS;
		}

		const scheduleRender = debounce((immediate) => {
			void immediate;
			renderNow();
		}, 40);
		const scheduleEstimate = debounce(() => void computeEstimate(), 300);

		/**
		 * 当前参数下的预览画布。
		 * ignoreCrop：裁剪 tab 要看「未被裁掉的全图 + 选框」，否则选框会相对裁后画面
		 * 定位，越拖越乱（选框坐标基于未裁的 base 画面）；同时也要忽略形状 —— 形状只在
		 * 选框里以轮廓 + 压暗呈现，不然整张图会当场变成椭圆，看着像「改形状把图改了」。
		 * 其它参数页与导出结果才应用形状。
		 */
		function currentPreview(ignoreCrop = false, viewScale = 0) {
			const item = active();
			if (!item?.bitmap) return null;
			const bs = baseOf(item);
			const budget = previewBudget();
			const cap = Math.min(1, Math.sqrt(budget / Math.max(1, bs.width * bs.height)));
			// 屏幕只需要 viewScale×dpr 那么多像素：多渲的部分肉眼看不见，纯烧时间。
			// 但也不低于预算的 35%（否则 1:1 放大看就糊了）。
			const want = viewScale > 0 ? viewScale * (window.devicePixelRatio || 1) : cap;
			const scale = clamp(Math.min(cap, Math.max(want, cap * 0.35)), 0.05, 1);
			const mime = outputMime(item.state, item.sourceType);
			const st = ignoreCrop ? { ...item.state, crop: null, cropShape: "rect" } : item.state;
			const canvas = renderToCanvas(item.bitmap, withWatermarkImage(item, st), {
				scale,
				opaque: isOpaqueFormat(mime),
				vars: varsFor(item),
			});
			return { item, canvas, scale, mime };
		}

		function withWatermarkImage(item, state) {
			return { ...state, watermark: { ...state.watermark, _image: item.wmImage } };
		}

		function renderNow() {
			const item = active();
			if (!ui || !item) {
				if (ui) {
					ui.frame.style.display = "none";
					ui.placeholder.style.display = "";
					ui.placeholder.textContent = t("stage.noItem");
				}
				return;
			}
			if (!item.bitmap) {
				ui.frame.style.display = "none";
				ui.placeholder.style.display = "";
				ui.placeholder.textContent = t("msg.decodeFail", { name: item.name, msg: item.error });
				return;
			}
			ui.placeholder.style.display = "none";
			ui.frame.style.display = "";

			const bs = baseOf(item);

			// 显示尺寸：fit 用容器可容纳的比例；手动缩放时按 viewScale（显示像素/源像素）
			const availW = Math.max(80, ui.viewwrap.clientWidth - 24);
			const availH = Math.max(80, ui.viewwrap.clientHeight - 24);
			const fitScale = Math.min(availW / bs.width, availH / bs.height);
			const viewScale = app.fit ? Math.min(fitScale, 1) : app.zoom || fitScale;
			viewScaleNow = viewScale;
			const dispW = Math.max(1, Math.round(bs.width * viewScale));

			const p = currentPreview(app.tab === "crop", viewScale);
			if (!p) return;
			const dispH = Math.max(1, Math.round(bs.height * viewScale));

			const c2 = ui.canvas;
			c2.width = p.canvas.width;
			c2.height = p.canvas.height;
			const cctx = c2.getContext("2d");
			if (app.compare) {
				// 对比原图：直接画源图（不经任何参数）
				cctx.clearRect(0, 0, c2.width, c2.height);
				cctx.imageSmoothingQuality = "high";
				cctx.drawImage(item.bitmap, 0, 0, c2.width, c2.height);
			} else {
				cctx.clearRect(0, 0, c2.width, c2.height);
				cctx.drawImage(p.canvas, 0, 0);
			}
			c2.style.width = `${dispW}px`;
			c2.style.height = `${dispH}px`;
			ui.frame.style.width = `${dispW}px`;
			ui.frame.style.height = `${dispH}px`;

			// 裁剪层（显示像素 ↔ 源像素在这里换算）
			if (app.tab === "crop" && !app.compare) {
				if (!cropper) {
					cropper = createCropper(ui.cropLayer, {
						bounds: () => ({ width: parseFloat(ui.frame.style.width) || 1, height: parseFloat(ui.frame.style.height) || 1 }),
						rect: () => {
							const a = active();
							if (!a) return { x: 0, y: 0, w: 1, h: 1 };
							const b = baseOf(a);
							const r = cropRect(a);
							const vs = (parseFloat(ui.frame.style.width) || 1) / b.width;
							return { x: r.x * vs, y: r.y * vs, w: r.w * vs, h: r.h * vs };
						},
						ratio: () => ratioOf(active()?.state),
						grid: () => app.grid,
						shape: () => active()?.state.cropShape ?? "rect",
						shapePathD: (shape, w, h) =>
							toPathD(shapeCommands(shape, w, h, active()?.state.cropRadius ?? DEFAULT_CROP_RADIUS)),
						onChange: (dr) => {
							const a = active();
							if (!a) return;
							const b = baseOf(a);
							const vs = (parseFloat(ui.frame.style.width) || 1) / b.width;
							const r = { x: dr.x / vs, y: dr.y / vs, w: dr.w / vs, h: dr.h / vs };
							a.state.crop = {
								x: Math.round(clamp(r.x, 0, b.width)),
								y: Math.round(clamp(r.y, 0, b.height)),
								w: Math.round(clamp(r.w, 1, b.width)),
								h: Math.round(clamp(r.h, 1, b.height)),
							};
							// 这里**故意不重渲染画布**：裁剪 tab 的预览本来就是未裁的全图，
							// 每帧重渲一遍大图正是以前拖动卡顿的主因。选框由 cropper 自己挪，
							// 面板数值帧内跟一下，体积估算走防抖。
							syncPanelValues();
							scheduleEstimate();
							updateStageInfo(null, viewScaleNow);
						},
					});
				}
				ui.cropLayer.style.display = "";
				cropper.render();
			} else if (ui.cropLayer) {
				ui.cropLayer.style.display = "none";
				cropper?.destroy();
				cropper = null;
			}
			updateStageInfo(p, viewScale);
		}

		function updateStageInfo(p, viewScale) {
			const item = active();
			if (!item || !ui) return;
			void p;
			const crop = cropRect(item);
			const ov = currentOutputSize(item);
			ui.stageInfo.textContent = `${fmtInt(crop.w)}×${fmtInt(crop.h)} → ${fmtInt(ov.width)}×${fmtInt(ov.height)}`;
			ui.zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
			void p;
		}

		/** 当前输出尺寸（源像素空间）。 */
		function currentOutputSize(item) {
			const crop = cropRect(item);
			let w = crop.w;
			let h = crop.h;
			const r = item.state.resize;
			if (r.mode === "percent") {
				const k = clamp(Number(r.percent) || 100, 1, 1000) / 100;
				w = Math.round(w * k);
				h = Math.round(h * k);
			} else if (r.mode === "longEdge") {
				const le = Number(r.longEdge) || Math.max(w, h);
				if (w >= h) {
					h = Math.round((h * le) / w);
					w = le;
				} else {
					w = Math.round((w * le) / h);
					h = le;
				}
			} else if (r.mode === "width") {
				const tw = Number(r.width) || w;
				h = Math.round((h * tw) / w);
				w = tw;
			} else if (r.mode === "height") {
				const th = Number(r.height) || h;
				w = Math.round((w * th) / h);
				h = th;
			}
			if (r.mode !== "none" && r.noUpscale !== false && (w > crop.w || h > crop.h)) {
				return { width: Math.round(crop.w), height: Math.round(crop.h) };
			}
			return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
		}

		// ------------------------------------------------------------------
		// 体积估算
		// ------------------------------------------------------------------
		async function computeEstimate() {
			const item = active();
			if (!item?.bitmap || !ui) return;
			const p = currentPreview();
			if (!p) return;
			const mime = p.mime;
			const ov = currentOutputSize(item);
			try {
				const blob = await encodeCanvas(p.canvas, mime, item.state.quality);
				const ratio = (ov.width * ov.height) / Math.max(1, p.canvas.width * p.canvas.height);
				const est = Math.round(blob.size * ratio);
				app.estimate = est;
				updateStatus();
			} catch {
				app.estimate = null;
				updateStatus();
			}
		}

		function updateStatus() {
			const item = active();
			if (!ui) return;
			if (!item?.bitmap) {
				ui.statusbar.textContent = "";
				return;
			}
			const ov = currentOutputSize(item);
			const mime = outputMime(item.state, item.sourceType);
			const ext = extOfMime(mime);
			const src = `${fmtInt(item.info.width)}×${fmtInt(item.info.height)} · ${fmtBytes(item.info.bytes)}`;
			const outSize = app.exact ?? app.estimate;
			const delta = outSize ? Math.round((1 - outSize / item.info.bytes) * 100) : null;
			ui.statusbar.innerHTML = "";
			if (app.tab === "crop") ui.statusbar.append(el("span", { class: "igt-dim", text: t("stage.cropHint") }));
			// 形状抠图：形状外到底透明还是被底色填了，直接写在状态条上（用户就是踩了这个坑）
			if (alphaFixForShape(item.state, item.sourceType)) {
				ui.statusbar.append(el("span", { class: "igt-chip-warn", text: t("status.shapeFilled", { c: item.state.background }) }));
			} else if ((item.state.cropShape ?? "rect") !== "rect") {
				ui.statusbar.append(el("span", { class: "igt-chip-ok", text: t("status.shapeAlpha") }));
			}
			ui.statusbar.append(
				el("span", { class: "igt-dim", text: `${t("status.src")} ${src}` }),
				el("span", { class: "igt-arrow", text: "→" }),
				el("span", { text: `${t("status.out")} ${fmtInt(ov.width)}×${fmtInt(ov.height)} · ${ext.toUpperCase()}` }),
				outSize ? el("span", { class: "igt-out", text: `· ${app.exact ? "" : "≈"}${fmtBytes(outSize)}` }) : "",
				delta !== null && delta > 0 ? el("span", { class: "igt-good", text: t("status.delta", { p: delta }) }) : "",
			);
		}

		/** 精确体积：按真实输出分辨率编码一次。 */
		async function measureExact() {
			const item = active();
			if (!item?.bitmap) return;
			setStatus(t("status.calculating"));
			try {
				const r = await exportItem(item);
				app.exact = r.blob.size;
				toast(t("msg.exact", { size: fmtBytes(r.blob.size) }));
			} catch (err) {
				toast(String(err.message ?? err), "error");
			} finally {
				setStatus("");
				updateStatus();
			}
		}

		// ------------------------------------------------------------------
		// 导出 / 保存
		// ------------------------------------------------------------------
		/** 把一项按当前参数渲染到真实分辨率并编码。 */
		async function exportItem(item, onStep) {
			const mime = outputMime(item.state, item.sourceType);
			const canvas = renderToCanvas(item.bitmap, withWatermarkImage(item, item.state), {
				scale: 1,
				opaque: isOpaqueFormat(mime),
				vars: varsFor(item),
			});
			const targetKB = Number(item.state.targetKB) || 0;
			if (targetKB > 0 && isLossy(mime)) {
				const r = await encodeToTarget(canvas, mime, targetKB * 1024, { quality: item.state.quality, onStep });
				return { blob: r.blob, mime, quality: r.quality, canvas: r.canvas };
			}
			const blob = await encodeCanvas(canvas, mime, item.state.quality);
			return { blob, mime, quality: item.state.quality, canvas };
		}

		function outName(item, mime) {
			const suffix = String(item.state.suffix ?? "");
			const ext = extOfMime(mime);
			const safe = stem(item.name).replace(/[\\/:*?"<>|]+/g, "_") || "image";
			return `${safe}${suffix}.${ext}`;
		}

		async function exportActive() {
			const item = active();
			if (!item?.bitmap) {
				toast(t("msg.noItem"), "warn");
				return;
			}
			app.busy = true;
			setStatus(t("status.saving"));
			try {
				const r = await exportItem(item);
				downloadBlob(r.blob, outName(item, r.mime));
				toast(t("msg.exported", { name: outName(item, r.mime) }));
			} catch (err) {
				toast(String(err.message ?? err), "error");
			} finally {
				app.busy = false;
				setStatus("");
			}
		}

		async function exportAll() {
			const list = app.items.filter((i) => i.bitmap);
			if (!list.length) {
				toast(t("msg.noItem"), "warn");
				return;
			}
			app.busy = true;
			const out = [];
			try {
				for (let i = 0; i < list.length; i++) {
					const it = list[i];
					setStatus(t("msg.exportProgress", { i: i + 1, n: list.length }));
					await new Promise((r) => requestAnimationFrame(() => r()));
					const res = await exportItem(it);
					out.push({ name: outName(it, res.mime), data: new Uint8Array(await res.blob.arrayBuffer()) });
				}
				const zipName = `images-${new Date().toISOString().slice(0, 10)}.zip`;
				downloadBlob(makeZip(out), zipName);
				toast(t("msg.exportAll", { n: out.length, name: zipName }));
			} catch (err) {
				toast(String(err.message ?? err), "error");
			} finally {
				app.busy = false;
				setStatus("");
			}
		}

		/** 把当前项的参数复制给队列里其它图（裁剪框超出对方尺寸时丢掉，避免裁出空白）。 */
		function syncToAll() {
			const src = active();
			if (!src?.bitmap) {
				toast(t("msg.noItem"), "warn");
				return;
			}
			let n = 0;
			for (const it of app.items) {
				if (it.id === src.id || !it.bitmap) continue;
				const st = JSON.parse(JSON.stringify(src.state));
				const b = baseOf(it);
				if (st.crop && (st.crop.x + st.crop.w > b.width || st.crop.y + st.crop.h > b.height)) st.crop = null;
				it.state = st;
				it.history = [JSON.stringify(st)];
				it.histIndex = 0;
				n++;
			}
			buildPanel();
			scheduleRender(true);
			scheduleEstimate();
			toast(t("queue.synced", { n }));
		}

		async function copyActive() {
			const item = active();
			if (!item?.bitmap) {
				toast(t("msg.noItem"), "warn");
				return;
			}
			setStatus(t("status.saving"));
			try {
				const canvas = renderToCanvas(item.bitmap, withWatermarkImage(item, item.state), {
					scale: 1,
					opaque: false,
					vars: varsFor(item),
				});
				const blob = await encodeCanvas(canvas, "image/png");
				await copyImageToClipboard(blob);
				toast(t("msg.copied"));
			} catch (err) {
				toast(t("msg.copyFail"), "error");
				void err;
			} finally {
				setStatus("");
			}
		}

		/** 打开「保存到工作区」弹窗。 */
		function openSaveDialog() {
			const item = active();
			if (!item?.bitmap) {
				toast(t("msg.noItem"), "warn");
				return;
			}
			const mime = outputMime(item.state, item.sourceType);
			const dir = item.path ? item.path.replace(/[^/]*$/, "") : "";
			const def = `${dir}${stem(item.name)}${item.state.suffix ?? ""}.${extOfMime(mime)}`;
			const input = el("input", { class: "igt-input", value: def, spellcheck: "false" });
			const ow = el("input", { type: "checkbox", checked: item.state.overwrite === true });
			const msg = el("div", { class: "igt-hint" });
			const dlg = modal(
				t("save.title"),
				el("div", { class: "igt-form" }, [
					el("label", { class: "igt-field" }, [el("span", { text: t("save.path") }), input]),
					el("label", { class: "igt-field igt-inline" }, [ow, el("span", { text: t("save.overwrite") })]),
					msg,
				]),
				[
					{
						label: t("save.btn"),
						primary: true,
						onClick: async () => {
							const path = input.value.trim();
							if (!path) return true;
							msg.textContent = t("status.saving");
							try {
								item.state.overwrite = ow.checked;
								const r = await exportItem(item);
								const res = await ws.saveImage(path, r.blob, ow.checked);
								toast(t(res.renamed ? "save.renamed" : "save.ok", { path: res.pretty ?? res.path }));
								// 存回工作区后此项的来源路径跟着走，下次保存/后缀更聪明
								item.path = res.path;
								return false;
							} catch (err) {
								msg.textContent = t("save.fail", { msg: String(err.message ?? err) });
								return true;
							}
						},
					},
				],
			);
			void dlg;
		}

		/** 工作区文件浏览弹窗。 */
		function openWorkspaceDialog() {
			let dir = "";
			const listEl = el("div", { class: "igt-wslist" });
			const crumb = el("div", { class: "igt-hint" });
			const body = el("div", {}, [crumb, listEl]);
			const dlg = modal(t("ws.title"), body, [{ label: t("ws.close"), onClick: () => false }]);
			const upBtn = el("button", {
				class: "igt-btn",
				text: t("ws.up"),
				onclick: () => {
					const next = dir.replace(/[^/]+\/?$/, "");
					void load(next);
				},
			});
			dlg.header.append(el("span", { class: "igt-sp" }), upBtn);

			async function load(next) {
				dir = next;
				listEl.innerHTML = "";
				listEl.append(el("div", { class: "igt-hint", text: t("ws.loading") }));
				try {
					const res = await ws.listDir(dir);
					crumb.textContent = `${t("app.ws")}: ${res.cwd}${dir ? "/" + dir : ""}`;
					listEl.innerHTML = "";
					const dirs = res.entries.filter((e) => e.type === "dir");
					const imgs = res.entries.filter((e) => e.isImage);
					const others = res.entries.filter((e) => e.type === "file" && !e.isImage);
					for (const d of dirs) {
						listEl.append(
							el("button", { class: "igt-wsitem", onclick: () => void load(d.path) }, [
								el("span", { class: "igt-wsicon", text: "📁" }),
								el("span", { text: d.name }),
							]),
						);
					}
					for (const f of imgs) {
						listEl.append(
							el("button", { class: "igt-wsitem", onclick: () => void pick(f.path) }, [
								el("img", { class: "igt-wsthumb", src: ws.imageUrl(f.path), loading: "lazy", alt: "", draggable: "false" }),
								el("span", { text: f.name }),
							]),
						);
					}
					if (others.length) {
						listEl.append(el("div", { class: "igt-hint", text: `${others.length} 个非图片文件已折叠` }));
					}
					if (!dirs.length && !imgs.length) listEl.append(el("div", { class: "igt-hint", text: t("ws.empty") }));
				} catch (err) {
					listEl.innerHTML = "";
					listEl.append(el("div", { class: "igt-error", text: t("msg.wsLoadFail", { msg: String(err.message ?? err) }) }));
				}
			}

			async function pick(path) {
				try {
					const blob = await ws.readImageBlob(path);
					await addOne({ name: path.split("/").pop() ?? "image", bytes: await blob.arrayBuffer(), path });
					renderQueue();
					buildPanel();
					scheduleRender(true);
					dlg.close();
				} catch (err) {
					toast(t("msg.wsLoadFail", { msg: String(err.message ?? err) }), "error");
				}
			}

			void load("");
		}

		/** 通用弹窗（返回 { close, header }）。 */
		function modal(title, bodyEl, buttons) {
			const header = el("div", { class: "igt-modal-hd" }, [el("b", { text: title })]);
			const footer = el("div", { class: "igt-modal-ft" });
			const box = el("div", { class: "igt-modal" }, [header, el("div", { class: "igt-modal-bd" }, [bodyEl]), footer]);
			const back = el("div", { class: "igt-modal-back" }, [box]);
			ui.overlays.append(back);
			const close = () => back.remove();
			for (const b of buttons) {
				footer.append(
					el("button", {
						class: `igt-btn${b.primary ? " igt-primary" : ""}`,
						text: b.label,
						onclick: async () => {
							const keep = await b.onClick?.();
							if (keep !== true) close();
						},
					}),
				);
			}
			return { close, header };
		}

		// ------------------------------------------------------------------
		// 面板（控件描述 → DOM）
		// ------------------------------------------------------------------
		let builtControls = [];

		function panelSpec(item) {
			const s = item.state;
			const mime = outputMime(s, item.sourceType);
			const lossy = isLossy(mime);
			const fmtOptions = [
				{ value: "keep", label: t("cmp.keep") },
				{ value: "jpeg", label: "JPEG" },
				{ value: "webp", label: "WebP" },
				{ value: "png", label: "PNG" },
				{ value: "avif", label: "AVIF" },
			].map((o) => (o.value === "keep" ? o : { ...o, disabled: !supportsMime(MIME_OF[o.value]) }));

			const tabs = {
				compress: [
					{ type: "select", label: t("cmp.format"), path: "format", structural: true, options: fmtOptions },
					{
						type: "range",
						label: t("cmp.quality"),
						path: "quality",
						min: 0.1,
						max: 1,
						step: 0.01,
						fmt: (v) => `${Math.round(v * 100)}`,
						when: (st) => isLossy(outputMime(st, item.sourceType)) && !(Number(st.targetKB) > 0),
					},
					{
						type: "num",
						label: t("cmp.targetKB"),
						path: "targetKB",
						min: 0,
						max: 200000,
						step: 10,
						hint: t("cmp.targetKBHint"),
						when: (st) => isLossy(outputMime(st, item.sourceType)),
					},
					{ type: "text", label: t("cmp.suffix"), path: "suffix", hint: t("cmp.suffixHint") },
					{
						type: "color",
						label: t("cmp.background"),
						path: "background",
						hint: t("cmp.backgroundHint"),
						when: (st) => isOpaqueFormat(outputMime(st, item.sourceType)),
					},
					{ type: "note", text: t("cmp.alphaWarn"), when: (st) => item.info.hasAlpha && isOpaqueFormat(outputMime(st, item.sourceType)) },
					{
						type: "warn",
						text: t("crop.shapeAlphaWarn"),
						actionLabel: t("crop.usePng"),
						when: (st) => alphaFixForShape(st, item.sourceType) !== null,
						action: (it) =>
							commit(it, (s) => {
								s.format = "png";
							}, true),
					},
					{ type: "note", text: t("cmp.noQuality"), when: (st) => !isLossy(outputMime(st, item.sourceType)) },
					{
						type: "buttons",
						label: t("cmp.preset"),
						buttons: [
							{
								label: t("cmp.preset.web"),
								onClick: (it) =>
									commit(it, (st) => {
										if (supportsMime("image/webp")) st.format = "webp";
										st.quality = 0.8;
										st.targetKB = 300;
										st.resize = { ...st.resize, mode: "longEdge", longEdge: 1600, noUpscale: true };
									}, true),
							},
							{
								label: t("cmp.preset.thumb"),
								onClick: (it) =>
									commit(it, (st) => {
										st.format = "keep";
										st.targetKB = 0;
										st.resize = { ...st.resize, mode: "longEdge", longEdge: 400, noUpscale: true };
									}, true),
							},
							{
								label: t("cmp.preset.origin"),
								onClick: (it) =>
									commit(it, (st) => {
										st.targetKB = 0;
										st.resize = { ...st.resize, mode: "none" };
									}, true),
							},
						],
					},
				],
				crop: [
					{
						type: "select",
						label: t("crop.ratio"),
						path: "ratio",
						structural: true,
						options: RATIO_KEYS.map((value) => ({
							value,
							label: value === "custom" ? t("crop.custom") : value === "free" ? t("crop.free") : value,
						})),
						after: () => cropper?.normalize(),
					},
					{
						type: "num",
						label: t("crop.ratioW"),
						path: "ratioW",
						min: 1,
						max: 10000,
						when: (st) => st.ratio === "custom",
						after: () => cropper?.normalize(),
					},
					{
						type: "num",
						label: t("crop.ratioH"),
						path: "ratioH",
						min: 1,
						max: 10000,
						when: (st) => st.ratio === "custom",
						after: () => cropper?.normalize(),
					},
					{ type: "num", label: t("crop.x"), get: (st) => Math.round(cropRect(item).x), set: (st, v) => setCrop(st, "x", v) },
					{ type: "num", label: t("crop.y"), get: (st) => Math.round(cropRect(item).y), set: (st, v) => setCrop(st, "y", v) },
					{ type: "num", label: t("crop.w"), get: (st) => Math.round(cropRect(item).w), set: (st, v) => setCrop(st, "w", v) },
					{ type: "num", label: t("crop.h"), get: (st) => Math.round(cropRect(item).h), set: (st, v) => setCrop(st, "h", v) },
					{
						type: "buttons",
						buttons: [
							{
								label: t("crop.center"),
								onClick: (it) =>
									commit(it, (st) => {
										const b = baseOf(it);
										const r = cropRect(it);
										st.crop = { ...r, x: Math.round((b.width - r.w) / 2), y: Math.round((b.height - r.h) / 2) };
									}),
							},
							{
								label: t("crop.max"),
								onClick: (it) =>
									commit(it, (st) => {
										const b = baseOf(it);
										const ratio = ratioOf(st);
										let w = b.width;
										let h = b.height;
										if (ratio) {
											if (w / h > ratio) w = h * ratio;
											else h = w / ratio;
										}
										st.crop = { x: Math.round((b.width - w) / 2), y: Math.round((b.height - h) / 2), w: Math.round(w), h: Math.round(h) };
									}),
							},
							{
								label: t("crop.fromImage"),
								title: t("crop.fromImageHint"),
								onClick: (it) =>
									commit(it, (st) => {
										// 用「旋转后」的尺寸：用户看到的画面就是这个比例
										const b = baseOf(it);
										st.ratio = "custom";
										st.ratioW = b.width;
										st.ratioH = b.height;
										// 光改比例数字不够：框还停在旧尺寸上。按这个比例取最大框（= 整幅）才算「还原」
										st.crop = { x: 0, y: 0, w: Math.round(b.width), h: Math.round(b.height) };
									}, true),
							},
							{
								label: t("crop.reset"),
								onClick: (it) =>
									commit(it, (st) => {
										st.crop = null;
									}),
							},
						],
					},
					{
						type: "select",
						label: t("crop.shape"),
						structural: true,
						get: (st) => st.cropShape ?? "rect",
						set: (st, v) => {
							st.cropShape = v;
							// 「圆形」= 椭圆 + 锁 1:1（否则它只是躺平的椭圆）
							if (v === "circle") st.ratio = "1:1";
						},
						options: ["rect", "rounded", "ellipse", "circle", "diamond", "heart", "star"].map((v) => ({
							value: v,
							label: t(`crop.shape.${v}`),
						})),
						after: () => {
							cropper?.normalize();
							autoAlphaForShape(item);
						},
					},
					{
						type: "warn",
						text: t("crop.shapeAlphaWarn"),
						actionLabel: t("crop.usePng"),
						when: (st) => alphaFixForShape(st, item.sourceType) !== null,
						action: (it) =>
							commit(it, (s) => {
								s.format = "png";
							}, true),
					},
					{
						type: "range",
						label: t("crop.shapeRadius"),
						path: "cropRadius",
						min: 0,
						max: 50,
						step: 1,
						when: (st) => st.cropShape === "rounded",
					},
					{ type: "note", text: t("crop.note") },
					{ type: "note", text: t("crop.shapeNote"), when: (st) => (st.cropShape ?? "rect") !== "rect" },
					{ type: "bool", label: t("stage.grid"), get: () => app.grid, set: (_st, v) => (app.grid = v) },
				],
				resize: [
					{
						type: "select",
						label: t("rz.mode"),
						structural: true,
						path: "resize.mode",
						options: [
							{ value: "none", label: t("rz.none") },
							{ value: "longEdge", label: t("rz.longEdge") },
							{ value: "width", label: t("rz.width") },
							{ value: "height", label: t("rz.height") },
							{ value: "percent", label: t("rz.percent") },
						],
					},
					{ type: "num", label: t("rz.longEdgePx"), path: "resize.longEdge", min: 1, max: 20000, when: (st) => st.resize.mode === "longEdge" },
					{ type: "num", label: t("rz.widthPx"), path: "resize.width", min: 1, max: 20000, when: (st) => st.resize.mode === "width" },
					{ type: "num", label: t("rz.heightPx"), path: "resize.height", min: 1, max: 20000, when: (st) => st.resize.mode === "height" },
					{ type: "range", label: t("rz.percentPc"), path: "resize.percent", min: 1, max: 400, step: 1, when: (st) => st.resize.mode === "percent" },
					{ type: "bool", label: t("rz.noUpscale"), path: "resize.noUpscale", when: (st) => st.resize.mode !== "none" && st.resize.mode !== "percent" },
					{
						type: "select",
						label: t("rz.smooth"),
						path: "resize.smooth",
						options: [
							{ value: "high", label: t("rz.smoothHigh") },
							{ value: "medium", label: t("rz.smoothMedium") },
							{ value: "low", label: t("rz.smoothLow") },
						],
					},
					{
						type: "buttons",
						label: t("rz.presets"),
						buttons: [256, 512, 1080, 1920, 3840].map((n) => ({
							label: String(n),
							onClick: (it) =>
								commit(it, (st) => {
									st.resize = { ...st.resize, mode: "longEdge", longEdge: n };
								}, true),
						})),
					},
				],
				rotate: [
					{
						type: "buttons",
						buttons: [
							{ label: t("rot.left"), onClick: (it) => rotate(it, -1) },
							{ label: t("rot.right"), onClick: (it) => rotate(it, 1) },
							{ label: t("rot.half"), onClick: (it) => rotate(it, 2) },
						],
					},
					{
						type: "buttons",
						buttons: [
							{ label: t("rot.flipH"), toggle: (st) => st.flipH, onClick: (it) => commit(it, (st) => (st.flipH = !st.flipH)) },
							{ label: t("rot.flipV"), toggle: (st) => st.flipV, onClick: (it) => commit(it, (st) => (st.flipV = !st.flipV)) },
						],
					},
					{ type: "range", label: t("rot.angle"), path: "angle", min: -180, max: 180, step: 1 },
					{ type: "color", label: t("rot.background"), path: "angleBg", optional: true, hint: t("rot.backgroundHint") },
					{
						type: "buttons",
						buttons: [
							{
								label: t("rot.reset"),
								onClick: (it) =>
									commit(it, (st) => {
										st.rotate90 = 0;
										st.flipH = false;
										st.flipV = false;
										st.angle = 0;
										st.angleBg = "";
										st.crop = null;
									}),
							},
						],
					},
				],
				watermark: [
					{ type: "bool", label: t("wm.enable"), path: "watermark.enabled", structural: true },
					{
						type: "select",
						label: t("wm.kind"),
						path: "watermark.kind",
						structural: true,
						when: (st) => st.watermark.enabled,
						options: [
							{ value: "text", label: t("wm.kind.text") },
							{ value: "image", label: t("wm.kind.image") },
						],
					},
					{ type: "text", label: t("wm.content"), path: "watermark.text", hint: t("wm.vars"), when: (st) => st.watermark.enabled && st.watermark.kind === "text" },
					{ type: "range", label: t("wm.size"), path: "watermark.fontSize", min: 1, max: 20, step: 0.5, when: (st) => st.watermark.enabled && st.watermark.kind === "text" },
					{ type: "color", label: t("wm.color"), path: "watermark.color", when: (st) => st.watermark.enabled && st.watermark.kind === "text" },
					{
						type: "file",
						label: t("wm.pick"),
						when: (st) => st.watermark.enabled && st.watermark.kind === "image",
						onPick: (it, file) => void pickWatermark(it, file),
						valueText: (it) => (it.wmImage ? `${it.wmImage.width}×${it.wmImage.height}` : t("wm.imageMissing")),
					},
					{ type: "range", label: t("wm.scale"), path: "watermark.imageScale", min: 1, max: 100, step: 1, when: (st) => st.watermark.enabled && st.watermark.kind === "image" },
					{ type: "range", label: t("wm.opacity"), path: "watermark.opacity", min: 0, max: 100, step: 1, when: (st) => st.watermark.enabled },
					{ type: "range", label: t("wm.rotate"), path: "watermark.rotate", min: -90, max: 90, step: 1, when: (st) => st.watermark.enabled },
					{ type: "range", label: t("wm.margin"), path: "watermark.margin", min: 0, max: 20, step: 0.5, when: (st) => st.watermark.enabled && !st.watermark.tile },
					{
						type: "select",
						label: t("wm.pos"),
						path: "watermark.pos",
						when: (st) => st.watermark.enabled && !st.watermark.tile,
						options: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"].map((p) => ({ value: p, label: t(`wm.pos.${p}`) })),
					},
					{ type: "bool", label: t("wm.tile"), path: "watermark.tile", when: (st) => st.watermark.enabled },
					{ type: "range", label: t("wm.gap"), path: "watermark.gap", min: 0, max: 30, step: 0.5, when: (st) => st.watermark.enabled && st.watermark.tile },
					{ type: "note", text: t("wm.note"), when: (st) => st.watermark.enabled },
				],
				filter: [
					{ type: "range", label: t("fl.brightness"), path: "adjust.brightness", min: 0, max: 200, step: 1 },
					{ type: "range", label: t("fl.contrast"), path: "adjust.contrast", min: 0, max: 200, step: 1 },
					{ type: "range", label: t("fl.saturation"), path: "adjust.saturation", min: 0, max: 200, step: 1 },
					{ type: "range", label: t("fl.hue"), path: "adjust.hue", min: -180, max: 180, step: 1 },
					{ type: "range", label: t("fl.gamma"), path: "adjust.gamma", min: 20, max: 300, step: 5 },
					{ type: "range", label: t("fl.grayscale"), path: "adjust.grayscale", min: 0, max: 100, step: 1 },
					{ type: "range", label: t("fl.sepia"), path: "adjust.sepia", min: 0, max: 100, step: 1 },
					{ type: "range", label: t("fl.invert"), path: "adjust.invert", min: 0, max: 100, step: 1 },
					{ type: "range", label: t("fl.blur"), path: "adjust.blur", min: 0, max: 50, step: 0.5 },
					{ type: "range", label: t("fl.sharpen"), path: "adjust.sharpen", min: 0, max: 100, step: 1 },
					{ type: "range", label: t("fl.vignette"), path: "adjust.vignette", min: 0, max: 100, step: 1 },
					{ type: "range", label: t("fl.radius"), path: "filter.radius", min: 0, max: 50, step: 0.5 },
					{ type: "range", label: t("fl.borderW"), path: "filter.borderWidth", min: 0, max: 10, step: 0.1 },
					{ type: "color", label: t("fl.borderColor"), path: "filter.borderColor" },
					{
						type: "buttons",
						buttons: [
							{
								label: t("fl.reset"),
								onClick: (it) =>
									commit(it, (st) => {
										const d = defaultState(app.cfg);
										st.adjust = d.adjust;
										st.filter = d.filter;
									}, true),
							},
						],
					},
					{ type: "note", text: t("fl.note") },
				],
				info: [{ type: "info" }],
			};
			void s;
			void mime;
			void lossy;
			return tabs[app.tab] ?? [];
		}

		/**
		 * 选了非矩形形状（= 要抠图）却碰上不支持透明的输出格式时：
		 * 「保持原格式」这种没表态的情况直接改成 PNG —— 否则用户拿到的是一张白角图，
		 * 而他要的是透明；用户显式选了 JPEG 就不动他的选择，只在面板给警告 + 一键切换。
		 */
		function autoAlphaForShape(item) {
			const fix = alphaFixForShape(item.state, item.sourceType);
			if (!fix || item.state.format !== "keep") return;
			commit(item, (s) => {
				s.format = fix;
			}, true);
			toast(t("crop.autoAlpha"), "info");
		}

		/**
		 * 裁剪字段写入（相对整个 base 画面）。
		 * 锁了比例时另一个维度跟着算——否则面板写 120×300、选框与导出却是 120×120，
		 * 两边各说各的（曾经就是这么错的）。
		 */
		function setCrop(state, key, v) {
			const item = active();
			if (!item) return;
			const b = baseOf(item);
			const r = cropRect(item);
			const n = Number(v);
			if (!Number.isFinite(n)) return;
			const ratio = ratioOf(state);
			if (key === "x") {
				r.x = clamp(n, 0, Math.max(0, b.width - r.w));
			} else if (key === "y") {
				r.y = clamp(n, 0, Math.max(0, b.height - r.h));
			} else if (key === "w") {
				r.w = clamp(n, 1, Math.max(1, b.width - r.x));
				if (ratio) {
					r.h = clamp(r.w / ratio, 1, Math.max(1, b.height - r.y));
					r.w = clamp(r.h * ratio, 1, Math.max(1, b.width - r.x));
				}
			} else if (key === "h") {
				r.h = clamp(n, 1, Math.max(1, b.height - r.y));
				if (ratio) {
					r.w = clamp(r.h * ratio, 1, Math.max(1, b.width - r.x));
					r.h = clamp(r.w / ratio, 1, Math.max(1, b.height - r.y));
				}
			}
			state.crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
		}

		function rotate(item, steps) {
			commit(item, (st) => {
				st.rotate90 = (((st.rotate90 / 90 + steps) % 4) + 4) % 4 * 90;
				st.crop = null; // 坐标系变了，裁剪重置（否则框会跳到别处）
			}, true);
		}

		async function pickWatermark(item, file) {
			try {
				const bytes = await file.arrayBuffer();
				item.wmImage = await decodeBytes(bytes, sniffType(new Uint8Array(bytes)) || "");
				buildPanel();
				scheduleRender();
			} catch {
				toast(t("msg.decodeFail", { name: file.name, msg: "decode" }), "error");
			}
		}

		/** 建面板（tab 或 active 项变化时；控件内部改动不走这里）。 */
		function buildPanel() {
			if (!ui) return;
			const item = active();
			ui.panelBody.innerHTML = "";
			builtControls = [];
			// tab 高亮
			for (const b of ui.tabBtns) b.classList.toggle("on", b.dataset.tab === app.tab);
			if (!item || !item.bitmap) {
				ui.panelBody.append(el("div", { class: "igt-hint", text: t("msg.noItem") }));
				ui.actions.style.display = "none";
				updateStatus();
				return;
			}
			ui.actions.style.display = "";
			for (const c of panelSpec(item)) ui.panelBody.append(buildControl(c, item));
			syncPanelValues();
			updateStatus();
		}

		function buildControl(c, item) {
			const s = item.state;
			if (c.when && !c.when(s)) return el("span", { style: "display:none" });
			// 只有「值型」控件（range/num/select/bool/color/text）才有 path 或 get/set；
			// buttons/note/info/file 没有可同步的值——别给它们造一个 undefined path 的
			// getter，否则 syncPanelValues 一调就抛（曾经把整条参数变更链打断）。
			const hasValue = Boolean(c.get || c.path);
			const get = c.get ?? (hasValue ? (st) => getPath(st, c.path) : () => undefined);
			const set = c.set ?? (hasValue ? (st, v) => setPath(st, c.path, v) : () => {});
			const wrap = el("div", { class: `igt-ctl igt-ctl-${c.type}` });
			const label = el("label", { class: "igt-ctl-hd" }, [el("span", { class: "igt-ctl-label", text: c.label ?? "" })]);
			wrap.append(label);

			const rec = { c, get, set, hasValue, node: wrap, item };

			if (c.type === "range" || c.type === "num") {
				const valEl = el("span", { class: "igt-ctl-val" });
				label.append(el("span", { class: "igt-sp" }), valEl);
				const input = el("input", {
					class: "igt-input",
					type: c.type === "range" ? "range" : "number",
					min: c.min ?? undefined,
					max: c.max ?? undefined,
					step: c.step ?? 1,
					value: String(get(s)),
				});
				const fmtVal = (v) => (c.fmt ? c.fmt(v) : String(Math.round(v * 100) / 100));
				valEl.textContent = fmtVal(get(s));
				const apply = () => {
					const v = c.type === "range" ? Number(input.value) : Number(input.value);
					if (!Number.isFinite(v)) return;
					valEl.textContent = fmtVal(v);
					commit(item, (st) => set(st, v));
					c.after?.();
				};
				if (c.type === "range") input.addEventListener("input", apply);
				else {
					const deb = debounce(apply, 320);
					input.addEventListener("input", deb);
					input.addEventListener("change", apply);
				}
				wrap.append(input);
				rec.input = input;
				rec.valEl = valEl;
				rec.fmtVal = fmtVal;
			} else if (c.type === "select") {
				const sel = el("select", { class: "igt-input" });
				for (const o of c.options) {
					const opt = el("option", { value: o.value, text: o.disabled ? `${o.label} · ${t("cmp.unsupported")}` : o.label });
					if (o.disabled) opt.disabled = true;
					if (o.value === get(s)) opt.selected = true;
					sel.append(opt);
				}
				sel.addEventListener("change", () => {
					commit(item, (st) => set(st, sel.value), c.structural !== false);
					c.after?.();
				});
				wrap.append(sel);
				rec.input = sel;
			} else if (c.type === "bool") {
				const cb = el("input", { type: "checkbox", checked: Boolean(get(s)) });
				cb.addEventListener("change", () => commit(item, (st) => set(st, cb.checked), c.structural === true));
				label.append(el("span", { class: "igt-sp" }), cb);
				rec.input = cb;
			} else if (c.type === "color") {
				const val = get(s) || "#ffffff";
				const input = el("input", { class: "igt-color", type: "color", value: /^#[0-9a-f]{6}$/i.test(val) ? val : "#ffffff" });
				input.addEventListener("input", () => commit(item, (st) => set(st, input.value)));
				label.append(el("span", { class: "igt-sp" }));
				if (c.optional) {
					const clear = el("button", {
						class: `igt-btn igt-mini${get(s) ? "" : " on"}`,
						text: "透明",
						onclick: () => {
							commit(item, (st) => set(st, ""));
							clear.classList.add("on");
						},
					});
					label.append(clear);
				}
				label.append(input);
				rec.input = input;
			} else if (c.type === "text") {
				const input = el("input", { class: "igt-input", value: String(get(s) ?? ""), spellcheck: "false" });
				const deb = debounce(() => commit(item, (st) => set(st, input.value)), 320);
				input.addEventListener("input", deb);
				wrap.append(input);
				rec.input = input;
			} else if (c.type === "file") {
				const infoEl = el("span", { class: "igt-hint", text: c.valueText?.(item) ?? "" });
				const input = el("input", { type: "file", accept: "image/*", style: "display:none" });
				input.addEventListener("change", () => {
					const f = input.files?.[0];
					if (f) c.onPick?.(item, f);
				});
				wrap.append(el("button", { class: "igt-btn", text: c.label, onclick: () => input.click() }), input, infoEl);
				label.remove();
				rec.input = input;
				rec.valEl = infoEl;
				rec.valText = c.valueText;
			} else if (c.type === "buttons") {
				const row = el("div", { class: "igt-btnrow" });
				for (const b of c.buttons) {
					const on = b.toggle?.(s);
					const node = el("button", {
						class: `igt-btn${on ? " on" : ""}`,
						text: b.label,
						onclick: () => b.onClick?.(item),
					});
					row.append(node);
					rec.buttons = rec.buttons ?? [];
					rec.buttons.push({ node, b });
				}
				wrap.append(row);
				if (c.label) label.querySelector(".igt-ctl-label").textContent = c.label;
				else label.remove();
			} else if (c.type === "warn") {
				label.remove();
				const row = el("div", { class: "igt-warn" }, [el("span", { text: c.text })]);
				if (c.action) {
					row.append(el("button", { class: "igt-btn igt-mini igt-primary", text: c.actionLabel, onclick: () => c.action(item) }));
				}
				wrap.append(row);
			} else if (c.type === "note") {
				label.remove();
				wrap.append(el("div", { class: "igt-hint", text: c.text }));
			} else if (c.type === "info") {
				label.remove();
				wrap.append(infoBlock(item));
			}
			if (c.hint && !c.noHint && c.type !== "note") wrap.append(el("div", { class: "igt-hint", text: c.hint }));
			builtControls.push(rec);
			return wrap;
		}

		/** 控件值回填（拖动裁剪框 / 撤销 / 外部改参数后调用，不重建 DOM）。 */
		function syncPanelValues() {
			const item = active();
			if (!item) return;
			for (const rec of builtControls) {
				if (rec.buttons) {
					for (const { node, b } of rec.buttons) node.classList.toggle("on", Boolean(b.toggle?.(item.state)));
				}
				if (rec.valText) {
					if (rec.valEl) rec.valEl.textContent = rec.valText(item);
					continue;
				}
				if (!rec.hasValue) continue;
				const v = rec.get(item.state);
				if (rec.input && rec.c.type !== "color") {
					if (rec.input.type === "checkbox") rec.input.checked = Boolean(v);
					else if (document.activeElement !== rec.input) rec.input.value = String(v);
				}
				if (rec.valEl && rec.fmtVal) rec.valEl.textContent = rec.fmtVal(v);
			}
		}

		/** 信息 tab：文件信息 + EXIF + 直方图 + 主色。 */
		function infoBlock(item) {
			const box = el("div", { class: "igt-info" });
			const rows = [
				[t("info.file"), item.name],
				[t("info.type"), item.sourceType || "?"],
				[t("info.dims"), `${fmtInt(item.info.width)}×${fmtInt(item.info.height)}`],
				[t("info.bytes"), fmtBytes(item.info.bytes)],
				[t("info.aspect"), (item.info.width / item.info.height).toFixed(3)],
				[t("info.mp"), ((item.info.width * item.info.height) / 1e6).toFixed(1)],
				[t("info.alpha"), item.info.hasAlpha ? t("info.yes") : t("info.no")],
			];
			const tbl = el("table", { class: "igt-table" });
			for (const [k, v] of rows) tbl.append(el("tr", {}, [el("th", { text: k }), el("td", { text: String(v) })]));
			box.append(tbl);

			// 直方图 + 主色（代理像素统计，进来才算一次）
			if (!item.stats && item.bitmap) {
				try {
					const w = 200;
					const h = Math.max(1, Math.round((w * item.info.height) / item.info.width));
					const c = document.createElement("canvas");
					c.width = w;
					c.height = h;
					const cctx = c.getContext("2d");
					cctx.imageSmoothingQuality = "low";
					cctx.drawImage(item.bitmap, 0, 0, w, h);
					item.stats = imageStats(cctx.getImageData(0, 0, w, h));
				} catch {
					item.stats = null;
				}
			}
			box.append(el("div", { class: "igt-ctl-label", text: t("info.hist") }));
			const hc = el("canvas", { class: "igt-hist" });
			hc.width = 260;
			hc.height = 70;
			box.append(hc);
			if (item.stats) {
				const style = getComputedStyle(document.documentElement);
				drawHistogram(hc, item.stats.histogram, style.getPropertyValue("--accent").trim() || "#8b5cf6");
				box.append(el("div", { class: "igt-ctl-label", text: t("info.colors") }));
				const sw = el("div", { class: "igt-swatches" });
				for (const c of item.stats.colors) {
					sw.append(
						el("button", {
							class: "igt-swatch",
							style: `background:${c.hex}`,
							title: `${c.hex} · ${Math.round(c.share * 100)}%`,
							onclick: () => {
								void (async () => {
									try {
										await navigator.clipboard?.writeText(c.hex);
										toast(t("info.copied", { v: c.hex }));
									} catch {
										/* 剪贴板不可用就安静失败 */
									}
								})();
							},
						}),
					);
				}
				box.append(sw);
			}

			box.append(el("div", { class: "igt-ctl-label", text: t("info.exif") }));
			if (item.exif) {
				const et = el("table", { class: "igt-table" });
				const map = [
					["make", t("info.exifMake")],
					["model", t("info.exifModel")],
					["lens", t("info.exifLens")],
					["fNumber", t("info.exifF")],
					["exposureTime", t("info.exifShutter")],
					["iso", t("info.exifIso")],
					["focalLength", t("info.exifFocal")],
					["dateTime", t("info.exifDate")],
					["software", t("info.exifSoft")],
					["gps", t("info.exifGps")],
				];
				for (const [k, label] of map) {
					const v = item.exif[k];
					if (v === undefined) continue;
					const text = k === "gps" ? `${v.lat}, ${v.lon}` : String(v);
					et.append(el("tr", {}, [el("th", { text: label }), el("td", { text })]));
				}
				box.append(et);
			} else {
				box.append(el("div", { class: "igt-hint", text: t("info.noExif") }));
			}

			box.append(el("div", { class: "igt-ctl-label", text: t("info.output") }));
			const ov = currentOutputSize(item);
			const mime = outputMime(item.state, item.sourceType);
			const ot = el("table", { class: "igt-table" });
			ot.append(
				el("tr", {}, [el("th", { text: t("info.dims") }), el("td", { text: `${fmtInt(ov.width)}×${fmtInt(ov.height)}` })]),
				el("tr", {}, [el("th", { text: t("info.type") }), el("td", { text: extOfMime(mime).toUpperCase() })]),
			);
			box.append(ot);
			return box;
		}

		// ------------------------------------------------------------------
		// 队列渲染
		// ------------------------------------------------------------------
		function renderQueue() {
			if (!ui) return;
			ui.queueCount.textContent = `${app.items.length}`;
			ui.queueList.innerHTML = "";
			if (!app.items.length) {
				ui.queueList.append(el("div", { class: "igt-hint igt-queueempty", text: t("queue.empty") }));
				return;
			}
			for (const it of app.items) {
				const row = el("div", { class: `igt-qitem${it.id === app.activeId ? " on" : ""}` });
				const thumb = it.bitmap
					? el("img", { class: "igt-qthumb", src: it.thumb ?? "", alt: "", draggable: "false" })
					: el("span", { class: "igt-qthumb igt-qthumb-err", text: "!" });
				const meta = el("div", { class: "igt-qmeta" }, [
					el("div", { class: "igt-qname", text: it.name, title: it.path || it.name }),
					el("div", {
						class: "igt-qsub",
						text: it.bitmap
							? `${it.info.width}×${it.info.height} · ${fmtBytes(it.info.bytes)}${it.path ? " · " + t("queue.fromWs") : ""}`
							: t("queue.failed"),
					}),
				]);
				row.append(thumb, meta);
				row.addEventListener("click", () => selectItem(it.id));
				const del = el("button", {
					class: "igt-x",
					text: "×",
					title: t("queue.remove"),
					onclick: (e) => {
						e.stopPropagation();
						removeItem(it.id);
					},
				});
				row.append(del);
				ui.queueList.append(row);
			}
		}

		/**
		 * 队列缩略图：用**原图**（不跑参数）画一次 64px 并缓存。
		 * 不跟参数联动是故意的：每拖一次滑杆就重渲染一遍全部缩略图太贵，
		 * 而且队列缩略图需要的是「我导入了哪张」这个身份信息。
		 */
		function makeThumb(item) {
			try {
				const k = 64 / Math.max(item.bitmap.width, item.bitmap.height);
				const c = document.createElement("canvas");
				c.width = Math.max(1, Math.round(item.bitmap.width * k));
				c.height = Math.max(1, Math.round(item.bitmap.height * k));
				const cx = c.getContext("2d");
				cx.imageSmoothingQuality = "low";
				cx.drawImage(item.bitmap, 0, 0, c.width, c.height);
				return c.toDataURL("image/png");
			} catch {
				return "";
			}
		}

		// ------------------------------------------------------------------
		// 外壳
		// ------------------------------------------------------------------
		function buildShell() {
			container.innerHTML = "";
			container.classList.add("igt-root");

			const style = el("style", { text: CSS });
			const top = el("div", { class: "igt-top" });
			const langBtn = el("button", { class: "igt-btn", text: t("app.lang"), onclick: () => switchLang() });
			const importBtn = el("button", { class: "igt-btn igt-primary", text: t("app.import"), title: t("app.importHint"), onclick: () => fileInput.click() });
			const wsBtn = el("button", { class: "igt-btn", text: t("app.fromWs"), onclick: () => openWorkspaceDialog() });
			const clearBtn = el("button", {
				class: "igt-btn",
				text: t("app.clear"),
				onclick: () => {
					if (!app.items.length) return;
					if (!confirm(t("app.clearConfirm"))) return;
					for (const it of app.items) it.bitmap?.close?.();
					app.items = [];
					app.activeId = null;
					renderQueue();
					buildPanel();
					scheduleRender(true);
				},
			});
			top.append(
				el("b", { class: "igt-title", text: `🖼 ${t("app.title")}` }),
				el("span", { class: "igt-sub", text: t("app.subtitle") }),
				el("span", { class: "igt-sp" }),
				importBtn,
				wsBtn,
				clearBtn,
				langBtn,
			);

			// 左：队列
			const queueCount = el("b", { text: "0" });
			const queueList = el("div", { class: "igt-queue-list" });
			const queue = el("aside", { class: "igt-queue" }, [
				el("div", { class: "igt-sec" }, [el("span", { text: t("queue.title") }), el("span", { class: "igt-sp" }), queueCount]),
				queueList,
				el("div", { class: "igt-hint igt-pad", text: t("queue.emptyHint") }),
			]);

			// 中：舞台
			// draggable=false + CSS -webkit-user-drag:none：Chrome 默认允许把 <canvas> 当图片
			// 原生拖走（拖影 + 冒泡出主应用的拖放提示框），必须两条都堵上。
			const canvas = el("canvas", { class: "igt-canvas", draggable: "false" });
			const cropLayer = el("div", { class: "igt-crop-layer" });
			const frame = el("div", { class: "igt-frame" }, [canvas, cropLayer]);
			const placeholder = el("div", { class: "igt-placeholder", text: t("stage.noItem") });
			const viewwrap = el("div", { class: "igt-viewwrap" }, [frame, placeholder]);
			const zoomLabel = el("span", { class: "igt-zoom", text: "100%" });
			const stageInfo = el("span", { class: "igt-stageinfo" });
			const compareBtn = el("button", {
				class: "igt-btn igt-mini",
				text: t("stage.compare"),
				title: t("stage.compareHint"),
				onpointerdown: (e) => {
					e.preventDefault();
					e.currentTarget.setPointerCapture?.(e.pointerId);
					app.compare = true;
					scheduleRender(true);
				},
				onpointerup: () => setCompare(false),
				onpointercancel: () => setCompare(false),
			});
			const stagebar = el("div", { class: "igt-stagebar" }, [
				el("button", { class: "igt-btn igt-mini", text: "−", title: t("stage.zoomOut"), onclick: () => zoomBy(1 / 1.25) }),
				el("button", {
					class: "igt-btn igt-mini",
					text: "＋",
					title: t("stage.zoomIn"),
					onclick: () => zoomBy(1.25),
				}),
				el("button", { class: "igt-btn igt-mini", text: t("stage.actual"), onclick: () => setZoom(1) }),
				el("button", {
					class: "igt-btn igt-mini",
					text: t("stage.fit"),
					onclick: () => {
						app.fit = true;
						app.zoom = 0;
						scheduleRender(true);
					},
				}),
				zoomLabel,
				el("span", { class: "igt-sp" }),
				stageInfo,
				compareBtn,
			]);
			const statusbar = el("div", { class: "igt-statusbar" });
			const stage = el("section", { class: "igt-stage" }, [stagebar, viewwrap, statusbar]);

			// 右：参数面板
			const tabBtns = [];
			const tabbar = el("div", { class: "igt-tabs" });
			for (const [key, label] of [
				["compress", t("tab.compress")],
				["crop", t("tab.crop")],
				["resize", t("tab.resize")],
				["rotate", t("tab.rotate")],
				["watermark", t("tab.watermark")],
				["filter", t("tab.filter")],
				["info", t("tab.info")],
			]) {
				const b = el("button", {
					class: `igt-tab${key === app.tab ? " on" : ""}`,
					text: label,
					"data-tab": key,
					onclick: () => {
						app.tab = key;
						buildPanel();
						scheduleRender(true);
					},
				});
				tabBtns.push(b);
				tabbar.append(b);
			}
			const panelBody = el("div", { class: "igt-panel-body" });
			const actions = el("div", { class: "igt-actions" }, [
				el("button", { class: "igt-btn igt-primary", text: t("act.export"), onclick: () => void exportActive() }),
				el("button", { class: "igt-btn", text: t("act.copy"), title: t("act.copyHint"), onclick: () => void copyActive() }),
				el("button", { class: "igt-btn", text: t("act.saveWs"), onclick: () => openSaveDialog() }),
				el("button", { class: "igt-btn", text: t("act.exportAll"), onclick: () => void exportAll() }),
				el("button", { class: "igt-btn", text: t("queue.sync"), onclick: () => syncToAll() }),
				el("button", { class: "igt-btn", text: t("act.undo"), title: "Ctrl+Z", onclick: () => active() && undo(active()) }),
				el("button", { class: "igt-btn", text: t("act.redo"), title: "Ctrl+Shift+Z", onclick: () => active() && redo(active()) }),
				el("button", {
					class: "igt-btn",
					text: t("act.reset"),
					onclick: () => {
						const it = active();
						if (it) commit(it, () => (it.state = defaultState(app.cfg)), true);
					},
				}),
				el("button", { class: "igt-btn", text: t("status.calc"), title: t("status.calcHint"), onclick: () => void measureExact() }),
			]);
			const panel = el("aside", { class: "igt-panel" }, [tabbar, panelBody, actions]);

			const main = el("div", { class: "igt-main" }, [queue, stage, panel]);
			const fileInput = el("input", {
				type: "file",
				accept: "image/*",
				multiple: true,
				style: "display:none",
				onchange: () => {
					if (fileInput.files?.length) void addFiles(fileInput.files);
					fileInput.value = "";
				},
			});
			const overlays = el("div", { class: "igt-overlays" });
			const toasts = el("div", { class: "igt-toasts" });
			const statusline = el("div", { class: "igt-statusline" });
			const root = el("div", { class: "igt" }, [top, main, fileInput, overlays, toasts, statusline]);
			container.append(style, root);

			ui = {
				root,
				style,
				canvas,
				cropLayer,
				frame,
				viewwrap,
				placeholder,
				zoomLabel,
				stageInfo,
				statusbar,
				queueList,
				queueCount,
				tabBtns,
				panelBody,
				actions,
				overlays,
				toasts,
				statusEl: statusline,
			};

			// 滚轮缩放（容器内，需要 Ctrl/⌘ —— 裸滚轮留给页面滚动）
			viewwrap.addEventListener(
				"wheel",
				(e) => {
					if (!active()?.bitmap) return;
					if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
					e.preventDefault();
					zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
				},
				{ passive: false },
			);
			// 拖放导入
			const stop = (e) => {
				e.preventDefault();
				e.stopPropagation();
			};
			// 插件内部不起原生拖拽：Chrome 允许把 <canvas> 当图片拖，既出拖影又会冒泡到
			// 主应用的全窗口拖放提示（「拖拽文件到聊天」的虚线框）。注意外部文件拖进来
			// 走的是 dragenter/dragover/drop，不会被这条挡住，导入照常可用。
			root.addEventListener("dragstart", (e) => e.preventDefault());
			root.addEventListener("dragover", (e) => {
				stop(e);
				root.classList.add("drop");
			});
			root.addEventListener("dragleave", () => root.classList.remove("drop"));
			root.addEventListener("drop", (e) => {
				stop(e);
				root.classList.remove("drop");
				const files = [...(e.dataTransfer?.files ?? [])];
				if (files.length) void addFiles(files);
			});
			// 键盘（仅在本视图可见时生效）
			const onKey = (e) => {
				if (!container.offsetParent) return;
				const mod = e.ctrlKey || e.metaKey;
				if (mod && e.key.toLowerCase() === "z") {
					e.preventDefault();
					const it = active();
					if (it) (e.shiftKey ? redo : undo)(it);
				}
			};
			document.addEventListener("keydown", onKey);
			const onPaste = (e) => {
				if (!container.offsetParent) return;
				const items = [...(e.clipboardData?.items ?? [])];
				const files = items.filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
				if (files.length) {
					e.preventDefault();
					void addFiles(files);
				}
			};
			document.addEventListener("paste", onPaste);
			const onResize = debounce(() => scheduleRender(true), 150);
			window.addEventListener("resize", onResize);
			const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
			ro?.observe(viewwrap);
			cleanupFns.push(() => {
				document.removeEventListener("keydown", onKey);
				document.removeEventListener("paste", onPaste);
				window.removeEventListener("resize", onResize);
				ro?.disconnect();
			});
		}

		function zoomBy(k) {
			const item = active();
			if (!item?.bitmap) return;
			const bs = baseOf(item);
			const availW = Math.max(80, ui.viewwrap.clientWidth - 24);
			const availH = Math.max(80, ui.viewwrap.clientHeight - 24);
			const fitScale = Math.min(availW / bs.width, availH / bs.height);
			const cur = app.fit ? Math.min(fitScale, 1) : app.zoom || fitScale;
			setZoom(cur * k);
		}

		function setZoom(k) {
			app.fit = false;
			app.zoom = clamp(k, 0.02, 8);
			scheduleRender(true);
		}

		function setCompare(on) {
			if (app.compare === on) return;
			app.compare = on;
			scheduleRender(true);
		}

		/** 切语言：整棵外壳重建（文案都长在 DOM 里，重建比逐节点替换更不容易漏）。 */
		function switchLang() {
			app.lang = app.lang === "zh" ? "en" : "zh";
			rebuild();
		}

		function rebuild() {
			cropper?.destroy();
			cropper = null;
			// 先拆上一轮挂的全局监听，否则切几次语言会叠好几套 paste/keydown 处理器
			for (const f of cleanupFns) {
				try {
					f();
				} catch {
					/* 忽略 */
				}
			}
			cleanupFns = [];
			buildShell();
			renderQueue();
			buildPanel();
			scheduleRender(true);
		}

		// ------------------------------------------------------------------
		// 启动
		// ------------------------------------------------------------------
		buildShell();
		renderQueue();
		buildPanel();
		scheduleRender(true);

		// 插件设置（默认质量/格式/后缀…）跟随宿主；拿到后刷新默认值
		void ws
			.fetchSettings()
			.then((res) => {
				app.cfg = res.settings ?? {};
				for (const it of app.items) {
					if (it.histIndex <= 0) it.state = defaultState(app.cfg);
				}
				buildPanel();
				scheduleRender(true);
			})
			.catch(() => {
				/* 服务端没起来时用内置默认值 */
			});

		const offData = ctx.onData?.((payload) => {
			if (payload?.kind === "settings") {
				app.cfg = payload.values ?? app.cfg;
				buildPanel();
			}
		});

		return () => {
			offData?.();
			for (const f of cleanupFns) {
				try {
					f();
				} catch {
					/* 忽略 */
				}
			}
			cleanupFns = [];
			cropper?.destroy();
			cropper = null;
			for (const it of app.items) it.bitmap?.close?.();
			container.innerHTML = "";
		};
	},
};

/** 视图样式（注入到容器内；变量都带主题回落，浅色主题自动跟随）。 */
const CSS = `
.igt-root { position: relative; display: flex; flex-direction: column; overflow: hidden; }
.igt { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); }
.igt-top { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
.igt-title { font-size: 14px; }
.igt-sub { color: var(--text-faint, #6b7284); font-size: 12px; }
.igt-sp { flex: 1; }
.igt-main { display: flex; flex: 1; min-height: 0; }
.igt-queue { width: 236px; flex: none; border-right: 1px solid var(--border, #262a35); display: flex; flex-direction: column; min-height: 0; }
.igt-sec { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border-soft, #1e2230); font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-queue-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.igt-qitem { display: flex; align-items: center; gap: 8px; padding: 5px; border: 1px solid transparent; border-radius: 7px; cursor: pointer; }
.igt-qitem:hover { background: var(--bg-elev, #14161c); }
.igt-qitem.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cf6); }
.igt-qthumb { width: 34px; height: 34px; flex: none; object-fit: cover; border-radius: 5px; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border-soft, #1e2230); }
.igt-qthumb-err { display: flex; align-items: center; justify-content: center; color: var(--red, #f87171); }
.igt-qmeta { min-width: 0; flex: 1; }
.igt-qname { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igt-qsub { font-size: 11px; color: var(--text-faint, #6b7284); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igt-x { border: none; background: transparent; color: var(--text-faint, #6b7284); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 5px; }
.igt-x:hover { color: var(--red, #f87171); background: var(--bg-elev2, #1a1d26); }
.igt-stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.igt-stagebar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft, #1e2230); }
.igt-zoom { font-size: 11px; color: var(--text-faint, #6b7284); font-variant-numeric: tabular-nums; min-width: 42px; }
.igt-stageinfo { font-size: 11px; color: var(--text-dim, #9aa1b4); font-variant-numeric: tabular-nums; }
.igt-viewwrap { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: flex-start; justify-content: flex-start; padding: 12px;
  background-color: var(--bg, #0d0e12);
  background-image: linear-gradient(45deg, var(--bg-elev, #14161c) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-elev, #14161c) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-elev, #14161c) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-elev, #14161c) 75%);
  background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0; }
.igt-frame { position: relative; flex: none; margin: auto; user-select: none; -webkit-user-select: none;
	-webkit-user-drag: none; box-shadow: 0 0 0 1px var(--border, #262a35), 0 6px 24px rgba(0,0,0,.4); }
.igt-canvas { display: block; width: 100%; height: 100%; image-rendering: auto; -webkit-user-drag: none; user-select: none; }
.igt-crop-layer { position: absolute; inset: 0; touch-action: none; }
.igt-placeholder { color: var(--text-faint, #6b7284); }
.igt-statusbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid var(--border-soft, #1e2230); font-size: 11px; color: var(--text-dim, #9aa1b4); font-variant-numeric: tabular-nums; min-height: 28px; }
.igt-dim { color: var(--text-faint, #6b7284); }
.igt-arrow { color: var(--text-faint, #6b7284); }
.igt-out { color: var(--accent, #8b5cf6); }
.igt-good { color: var(--green, #34d399); }
.igt-panel { width: 320px; flex: none; border-left: 1px solid var(--border, #262a35); display: flex; flex-direction: column; min-height: 0; }
.igt-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px; border-bottom: 1px solid var(--border-soft, #1e2230); }
.igt-tab { background: transparent; border: 1px solid transparent; color: var(--text-dim, #9aa1b4); font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
.igt-tab:hover { color: var(--text, #e6e8ef); }
.igt-tab.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cf6); color: var(--text, #e6e8ef); }
.igt-panel-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 9px; }
.igt-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px; border-top: 1px solid var(--border-soft, #1e2230); }
.igt-ctl { display: flex; flex-direction: column; gap: 4px; }
.igt-ctl-hd { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-ctl-label { font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-ctl-val { font-size: 11px; color: var(--text, #e6e8ef); font-variant-numeric: tabular-nums; }
.igt-input { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px; width: 100%; }
.igt-input[type="range"] { padding: 0; border: none; background: transparent; }
.igt-input[type="checkbox"] { width: auto; }
.igt-color { width: 30px; height: 22px; padding: 0; border: 1px solid var(--border, #262a35); border-radius: 5px; background: none; }
.igt-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 4px 9px; cursor: pointer; font: inherit; font-size: 12px; }
.igt-btn:hover { border-color: var(--accent, #8b5cf6); }
.igt-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cf6); }
.igt-btn.igt-primary { background: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); color: #fff; }
.igt-btn.igt-mini { padding: 2px 7px; font-size: 11px; }
.igt-btnrow { display: flex; flex-wrap: wrap; gap: 5px; }
.igt-hint { font-size: 11px; color: var(--text-faint, #6b7284); line-height: 1.5; }
.igt-warn { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; line-height: 1.5;
	color: var(--amber-text, #fcd34d); background: var(--notice-warn-bg, #38251f); border: 1px solid var(--amber, #fbbf24);
	border-radius: 6px; padding: 6px 8px; }
.igt-warn .igt-btn { flex: none; }
.igt-chip-warn { color: var(--amber-text, #fcd34d); }
.igt-chip-ok { color: var(--green, #34d399); }
.igt-pad { padding: 10px; }
.igt-error { font-size: 12px; color: var(--red, #f87171); }
.igt-queueempty { padding: 8px; }
.igt-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.igt-table th { text-align: left; font-weight: 400; color: var(--text-faint, #6b7284); padding: 2px 6px 2px 0; white-space: nowrap; vertical-align: top; }
.igt-table td { color: var(--text, #e6e8ef); padding: 2px 0; word-break: break-all; }
.igt-hist { width: 100%; height: 70px; background: var(--bg-elev, #14161c); border: 1px solid var(--border-soft, #1e2230); border-radius: 6px; }
.igt-swatches { display: flex; gap: 5px; flex-wrap: wrap; }
.igt-swatch { width: 26px; height: 26px; border-radius: 5px; border: 1px solid var(--border, #262a35); cursor: pointer; }
.igt-info { display: flex; flex-direction: column; gap: 7px; }
.igt-toasts { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; z-index: 40; pointer-events: none; }
.igt-toast { background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); border-left: 3px solid var(--accent, #8b5cf6); border-radius: 6px; padding: 7px 11px; font-size: 12px; max-width: 320px; box-shadow: 0 6px 20px rgba(0,0,0,.4); opacity: 1; transition: opacity .4s; }
.igt-toast-error { border-left-color: var(--red, #f87171); }
.igt-toast-warn { border-left-color: var(--amber, #fbbf24); }
.igt-toast.out { opacity: 0; }
.igt-overlays { position: absolute; inset: 0; pointer-events: none; }
.igt-modal-back { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; pointer-events: auto; z-index: 30; }
.igt-modal { width: min(560px, 90%); max-height: 78%; display: flex; flex-direction: column; background: var(--bg-elev, #14161c); border: 1px solid var(--border, #262a35); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.igt-modal-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft, #1e2230); }
.igt-modal-bd { padding: 10px 12px; overflow-y: auto; flex: 1; min-height: 0; }
.igt-modal-ft { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--border-soft, #1e2230); }
.igt-form { display: flex; flex-direction: column; gap: 9px; }
.igt-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-field.igt-inline { flex-direction: row; align-items: center; gap: 7px; }
.igt-wslist { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.igt-wsitem { display: flex; align-items: center; gap: 8px; background: transparent; border: 1px solid transparent; border-radius: 6px; color: inherit; font: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; text-align: left; }
.igt-wsitem:hover { background: var(--bg-elev2, #1a1d26); border-color: var(--border, #262a35); }
.igt-wsicon { width: 34px; text-align: center; }
.igt-wsthumb { width: 34px; height: 34px; object-fit: cover; border-radius: 5px; background: var(--bg-elev2, #1a1d26); }
.igt-statusline { font-size: 11px; color: var(--text-faint, #6b7284); padding: 3px 12px; }
.igt.drop::after { content: ""; position: absolute; inset: 0; border: 2px dashed var(--accent, #8b5cf6); border-radius: 8px; pointer-events: none; z-index: 35; }
.igt-crop-box { position: absolute; border: 1px solid rgba(255,255,255,.9); }
/* 框内平移命中区（没它就只能拖把手，框本身拖不动） */
.igt-crop-move { position: absolute; inset: 0; cursor: move; }
.igt-crop-dim { position: absolute; background: rgba(0,0,0,.45); pointer-events: none; }
.igt-crop-svg { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.igt-crop-shape-fill { fill: rgba(0,0,0,.45); }
.igt-crop-shape-line { fill: none; stroke: rgba(255,255,255,.9); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.igt-crop-grid { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr; pointer-events: none; }
.igt-crop-grid i { border: 0 solid rgba(255,255,255,.35); }
.igt-crop-grid i:nth-child(1) { border-right-width: 1px; }
.igt-crop-grid i:nth-child(2) { border-right-width: 1px; border-bottom-width: 1px; }
.igt-crop-grid i:nth-child(3) { border-bottom-width: 1px; }
.igt-crop-grid i:nth-child(4) { border-right-width: 1px; }
.igt-crop-h { position: absolute; width: 11px; height: 11px; background: #fff; border: 1px solid rgba(0,0,0,.5); border-radius: 2px; }
.igt-crop-nw { left: -6px; top: -6px; cursor: nwse-resize; }
.igt-crop-n { left: 50%; top: -6px; margin-left: -5px; cursor: ns-resize; }
.igt-crop-ne { right: -6px; top: -6px; cursor nesw-resize; }
.igt-crop-e { right: -6px; top: 50%; margin-top: -5px; cursor: ew-resize; }
.igt-crop-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.igt-crop-s { left: 50%; bottom: -6px; margin-left: -5px; cursor: ns-resize; }
.igt-crop-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.igt-crop-w { left: -6px; top: 50%; margin-top: -5px; cursor: ew-resize; }
`;
