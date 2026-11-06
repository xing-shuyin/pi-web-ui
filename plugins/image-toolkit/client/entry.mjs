import { detectLang, makeT } from "./i18n.mjs";
import { mountGenView } from "./gen-view.mjs";
import {
	basename,
	clamp,
	copyImageToClipboard,
	debounce,
	downloadBlob,
	el,
	fmtBytes,
	fmtInt,
	makeZip,
	stem,
} from "./util.mjs";
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

const PREVIEW_FIT_PIXELS = 2_600_000;
const PREVIEW_ZOOM_PIXELS = 6_000_000;

const MIME_OF = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

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

function srcSize(item) {
	return { width: item.bitmap.width, height: item.bitmap.height };
}

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
			mode: "edit",
			sheetMin: false,
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
		let genHandle = null;
		let genContainer = null;
		let studioNavBtns = [];
		let editActionGroup = null;
		let genActionGroup = null;
		let viewScaleNow = 1;
		let cleanupFns = [];

		const active = () => app.items.find((i) => i.id === app.activeId) ?? null;
		const uid = (() => {
			let n = 0;
			return () => `img${++n}`;
		})();

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

		function afterStateChange(item, structural) {
			if (structural) buildPanel();
			else syncPanelValues();
			scheduleRender();
			scheduleEstimate();
		}

		function commit(item, fn, structural) {
			fn(item.state);
			pushHistory(item);
			app.exact = null;
			afterStateChange(item, structural);
		}

		async function addFiles(files, opts = {}) {
			const list = [...files].filter((f) => /^image\//.test(f.type) || ws.IMAGE_EXT.test(f.name || ""));
			if (!list.length) return;
			for (const f of list) {
				await addOne({ name: f.name, bytes: await f.arrayBuffer(), path: opts.path ?? "" });
			}
			renderQueue();
		}

		async function addOne({ name, bytes, path = "" }) {
			if (bytes instanceof Blob) {
				bytes = await bytes.arrayBuffer();
			}
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

		async function decodeBytes(bytes, type) {
			const blob = new Blob([bytes], { type: type || "application/octet-stream" });
			try {
				return await createImageBitmap(blob);
			} catch {}
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
			app.zoom = 0;
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

		function previewBudget() {
			return app.fit ? PREVIEW_FIT_PIXELS : PREVIEW_ZOOM_PIXELS;
		}

		const scheduleRender = debounce((immediate) => {
			void immediate;
			renderNow();
		}, 40);
		const scheduleEstimate = debounce(() => void computeEstimate(), 300);

		function currentPreview(ignoreCrop = false, viewScale = 0) {
			const item = active();
			if (!item?.bitmap) return null;
			const bs = baseOf(item);
			const budget = previewBudget();
			const cap = Math.min(1, Math.sqrt(budget / Math.max(1, bs.width * bs.height)));
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

			if (app.tab === "crop" && !app.compare) {
				if (!cropper) {
					cropper = createCropper(ui.cropLayer, {
						bounds: () => ({
							width: parseFloat(ui.frame.style.width) || 1,
							height: parseFloat(ui.frame.style.height) || 1,
						}),
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
			if (alphaFixForShape(item.state, item.sourceType)) {
				ui.statusbar.append(
					el("span", { class: "igt-chip-warn", text: t("status.shapeFilled", { c: item.state.background }) }),
				);
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

		function openSettingsDialog() {
			const draft = {
				defaultFormat: String(app.cfg.defaultFormat ?? "keep"),
				quality: Number(app.cfg.quality ?? 0.82),
				maxDim: Number(app.cfg.maxDim ?? 0),
				suffix: String(app.cfg.suffix ?? "-min"),
				overwrite: app.cfg.overwrite === true,
				aiTools: app.cfg.aiTools !== false,
				allowServerDeps: app.cfg.allowServerDeps !== false,
			};
			const fmtSel = el("select", { class: "igt-input" });
			for (const v of ["keep", "jpeg", "webp", "png", "avif"]) {
				const opt = el("option", { value: v, text: v === "keep" ? t("cmp.keep") : v.toUpperCase() });
				if (v === draft.defaultFormat) opt.selected = true;
				fmtSel.append(opt);
			}
			fmtSel.addEventListener("change", () => (draft.defaultFormat = fmtSel.value));
			const qInput = el("input", {
				class: "igt-input",
				type: "number",
				min: 0.1,
				max: 1,
				step: 0.01,
				value: String(draft.quality),
			});
			qInput.addEventListener("input", () => {
				const n = Number(qInput.value);
				if (Number.isFinite(n)) draft.quality = n;
			});
			const maxInput = el("input", {
				class: "igt-input",
				type: "number",
				min: 0,
				max: 20000,
				step: 1,
				value: String(draft.maxDim),
			});
			maxInput.addEventListener("input", () => {
				const n = Number(maxInput.value);
				if (Number.isFinite(n)) draft.maxDim = n;
			});
			const suffixInput = el("input", { class: "igt-input", value: draft.suffix, spellcheck: "false" });
			suffixInput.addEventListener("input", () => (draft.suffix = suffixInput.value));
			const owCb = el("input", { type: "checkbox", checked: draft.overwrite });
			owCb.addEventListener("change", () => (draft.overwrite = owCb.checked));
			const aiCb = el("input", { type: "checkbox", checked: draft.aiTools });
			aiCb.addEventListener("change", () => (draft.aiTools = aiCb.checked));
			const depCb = el("input", { type: "checkbox", checked: draft.allowServerDeps });
			depCb.addEventListener("change", () => (draft.allowServerDeps = depCb.checked));
			const msg = el("div", { class: "igt-hint" });
			const field = (labelText, inputEl, hintText) =>
				el("label", { class: "igt-field" }, [
					el("span", { text: labelText }),
					inputEl,
					hintText ? el("div", { class: "igt-hint", text: hintText }) : null,
				]);
			const boolField = (labelText, cb, hintText) =>
				el("div", { class: "igt-field" }, [
					el("label", { class: "igt-field igt-inline" }, [cb, el("span", { text: labelText })]),
					el("div", { class: "igt-hint", text: hintText }),
				]);
			modal(
				t("cfg.title"),
				el("div", { class: "igt-form" }, [
					field(t("cfg.format"), fmtSel, t("cfg.formatHint")),
					field(t("cfg.quality"), qInput, t("cfg.qualityHint")),
					field(t("cfg.maxDim"), maxInput, t("cfg.maxDimHint")),
					field(t("cfg.suffix"), suffixInput, t("cfg.suffixHint")),
					boolField(t("cfg.overwrite"), owCb, t("cfg.overwriteHint")),
					boolField(t("cfg.aiTools"), aiCb, t("cfg.aiToolsHint")),
					boolField(t("cfg.allowServerDeps"), depCb, t("cfg.allowServerDepsHint")),
					msg,
				]),
				[
					{ label: t("cfg.cancel"), onClick: () => false },
					{
						label: t("cfg.save"),
						primary: true,
						onClick: async () => {
							msg.textContent = t("status.saving");
							try {
								const res = await ws.saveSettings(draft);
								app.cfg = res.settings ?? draft;
								for (const it of app.items) {
									if (it.histIndex <= 0) it.state = defaultState(app.cfg);
								}
								buildPanel();
								scheduleRender(true);
								toast(t("cfg.saved"));
								return false;
							} catch (err) {
								msg.textContent = t("cfg.saveFail", { msg: String(err.message ?? err) });
								return true;
							}
						},
					},
				],
			);
		}

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
								el("img", {
									class: "igt-wsthumb",
									src: ws.imageUrl(f.path),
									loading: "lazy",
									alt: "",
									draggable: "false",
								}),
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
					listEl.append(
						el("div", { class: "igt-error", text: t("msg.wsLoadFail", { msg: String(err.message ?? err) }) }),
					);
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
					{
						type: "note",
						text: t("cmp.alphaWarn"),
						when: (st) => item.info.hasAlpha && isOpaqueFormat(outputMime(st, item.sourceType)),
					},
					{
						type: "warn",
						text: t("crop.shapeAlphaWarn"),
						actionLabel: t("crop.usePng"),
						when: (st) => alphaFixForShape(st, item.sourceType) !== null,
						action: (it) =>
							commit(
								it,
								(s) => {
									s.format = "png";
								},
								true,
							),
					},
					{ type: "note", text: t("cmp.noQuality"), when: (st) => !isLossy(outputMime(st, item.sourceType)) },
					{
						type: "buttons",
						label: t("cmp.preset"),
						buttons: [
							{
								label: t("cmp.preset.web"),
								onClick: (it) =>
									commit(
										it,
										(st) => {
											if (supportsMime("image/webp")) st.format = "webp";
											st.quality = 0.8;
											st.targetKB = 300;
											st.resize = { ...st.resize, mode: "longEdge", longEdge: 1600, noUpscale: true };
										},
										true,
									),
							},
							{
								label: t("cmp.preset.thumb"),
								onClick: (it) =>
									commit(
										it,
										(st) => {
											st.format = "keep";
											st.targetKB = 0;
											st.resize = { ...st.resize, mode: "longEdge", longEdge: 400, noUpscale: true };
										},
										true,
									),
							},
							{
								label: t("cmp.preset.origin"),
								onClick: (it) =>
									commit(
										it,
										(st) => {
											st.targetKB = 0;
											st.resize = { ...st.resize, mode: "none" };
										},
										true,
									),
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
					{
						type: "num",
						label: t("crop.x"),
						get: (st) => Math.round(cropRect(item).x),
						set: (st, v) => setCrop(st, "x", v),
					},
					{
						type: "num",
						label: t("crop.y"),
						get: (st) => Math.round(cropRect(item).y),
						set: (st, v) => setCrop(st, "y", v),
					},
					{
						type: "num",
						label: t("crop.w"),
						get: (st) => Math.round(cropRect(item).w),
						set: (st, v) => setCrop(st, "w", v),
					},
					{
						type: "num",
						label: t("crop.h"),
						get: (st) => Math.round(cropRect(item).h),
						set: (st, v) => setCrop(st, "h", v),
					},
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
										st.crop = {
											x: Math.round((b.width - w) / 2),
											y: Math.round((b.height - h) / 2),
											w: Math.round(w),
											h: Math.round(h),
										};
									}),
							},
							{
								label: t("crop.fromImage"),
								title: t("crop.fromImageHint"),
								onClick: (it) =>
									commit(
										it,
										(st) => {
											const b = baseOf(it);
											st.ratio = "custom";
											st.ratioW = b.width;
											st.ratioH = b.height;
											st.crop = { x: 0, y: 0, w: Math.round(b.width), h: Math.round(b.height) };
										},
										true,
									),
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
							commit(
								it,
								(s) => {
									s.format = "png";
								},
								true,
							),
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
					{
						type: "num",
						label: t("rz.longEdgePx"),
						path: "resize.longEdge",
						min: 1,
						max: 20000,
						when: (st) => st.resize.mode === "longEdge",
					},
					{
						type: "num",
						label: t("rz.widthPx"),
						path: "resize.width",
						min: 1,
						max: 20000,
						when: (st) => st.resize.mode === "width",
					},
					{
						type: "num",
						label: t("rz.heightPx"),
						path: "resize.height",
						min: 1,
						max: 20000,
						when: (st) => st.resize.mode === "height",
					},
					{
						type: "range",
						label: t("rz.percentPc"),
						path: "resize.percent",
						min: 1,
						max: 400,
						step: 1,
						when: (st) => st.resize.mode === "percent",
					},
					{
						type: "bool",
						label: t("rz.noUpscale"),
						path: "resize.noUpscale",
						when: (st) => st.resize.mode !== "none" && st.resize.mode !== "percent",
					},
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
								commit(
									it,
									(st) => {
										st.resize = { ...st.resize, mode: "longEdge", longEdge: n };
									},
									true,
								),
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
							{
								label: t("rot.flipH"),
								toggle: (st) => st.flipH,
								onClick: (it) => commit(it, (st) => (st.flipH = !st.flipH)),
							},
							{
								label: t("rot.flipV"),
								toggle: (st) => st.flipV,
								onClick: (it) => commit(it, (st) => (st.flipV = !st.flipV)),
							},
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
					{
						type: "text",
						label: t("wm.content"),
						path: "watermark.text",
						hint: t("wm.vars"),
						when: (st) => st.watermark.enabled && st.watermark.kind === "text",
					},
					{
						type: "range",
						label: t("wm.size"),
						path: "watermark.fontSize",
						min: 1,
						max: 20,
						step: 0.5,
						when: (st) => st.watermark.enabled && st.watermark.kind === "text",
					},
					{
						type: "color",
						label: t("wm.color"),
						path: "watermark.color",
						when: (st) => st.watermark.enabled && st.watermark.kind === "text",
					},
					{
						type: "file",
						label: t("wm.pick"),
						when: (st) => st.watermark.enabled && st.watermark.kind === "image",
						onPick: (it, file) => void pickWatermark(it, file),
						valueText: (it) => (it.wmImage ? `${it.wmImage.width}×${it.wmImage.height}` : t("wm.imageMissing")),
					},
					{
						type: "range",
						label: t("wm.scale"),
						path: "watermark.imageScale",
						min: 1,
						max: 100,
						step: 1,
						when: (st) => st.watermark.enabled && st.watermark.kind === "image",
					},
					{
						type: "range",
						label: t("wm.opacity"),
						path: "watermark.opacity",
						min: 0,
						max: 100,
						step: 1,
						when: (st) => st.watermark.enabled,
					},
					{
						type: "range",
						label: t("wm.rotate"),
						path: "watermark.rotate",
						min: -90,
						max: 90,
						step: 1,
						when: (st) => st.watermark.enabled,
					},
					{
						type: "range",
						label: t("wm.margin"),
						path: "watermark.margin",
						min: 0,
						max: 20,
						step: 0.5,
						when: (st) => st.watermark.enabled && !st.watermark.tile,
					},
					{
						type: "select",
						label: t("wm.pos"),
						path: "watermark.pos",
						when: (st) => st.watermark.enabled && !st.watermark.tile,
						options: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"].map((p) => ({
							value: p,
							label: t(`wm.pos.${p}`),
						})),
					},
					{ type: "bool", label: t("wm.tile"), path: "watermark.tile", when: (st) => st.watermark.enabled },
					{
						type: "range",
						label: t("wm.gap"),
						path: "watermark.gap",
						min: 0,
						max: 30,
						step: 0.5,
						when: (st) => st.watermark.enabled && st.watermark.tile,
					},
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
									commit(
										it,
										(st) => {
											const d = defaultState(app.cfg);
											st.adjust = d.adjust;
											st.filter = d.filter;
										},
										true,
									),
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

		function autoAlphaForShape(item) {
			const fix = alphaFixForShape(item.state, item.sourceType);
			if (!fix || item.state.format !== "keep") return;
			commit(
				item,
				(s) => {
					s.format = fix;
				},
				true,
			);
			toast(t("crop.autoAlpha"), "info");
		}

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
			commit(
				item,
				(st) => {
					st.rotate90 = ((((st.rotate90 / 90 + steps) % 4) + 4) % 4) * 90;
					st.crop = null;
				},
				true,
			);
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

		function buildPanel() {
			if (!ui) return;
			const item = active();
			ui.panelBody.innerHTML = "";
			builtControls = [];
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
					const opt = el("option", {
						value: o.value,
						text: o.disabled ? `${o.label} · ${t("cmp.unsupported")}` : o.label,
					});
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
				const input = el("input", {
					class: "igt-color",
					type: "color",
					value: /^#[0-9a-f]{6}$/i.test(val) ? val : "#ffffff",
				});
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
					row.append(
						el("button", { class: "igt-btn igt-mini igt-primary", text: c.actionLabel, onclick: () => c.action(item) }),
					);
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
									} catch {}
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
				el("tr", {}, [
					el("th", { text: t("info.dims") }),
					el("td", { text: `${fmtInt(ov.width)}×${fmtInt(ov.height)}` }),
				]),
				el("tr", {}, [el("th", { text: t("info.type") }), el("td", { text: extOfMime(mime).toUpperCase() })]),
			);
			box.append(ot);
			return box;
		}

		function renderQueue() {
			if (!ui) return;
			ui.queueCount.textContent = `${app.items.length}`;
			ui.queue.classList.toggle("igt-empty", !app.items.length);
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
				const refBtn = el("button", {
					class: "igt-btn igt-mini",
					text: "🎨",
					title: t("queue.useAsRef"),
					onclick: (e) => {
						e.stopPropagation();
						void useAsGenReference(it);
					},
				});
				const del = el("button", {
					class: "igt-x",
					text: "×",
					title: t("queue.remove"),
					onclick: (e) => {
						e.stopPropagation();
						removeItem(it.id);
					},
				});
				row.append(refBtn, del);
				ui.queueList.append(row);
			}
		}

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

		function ensureGenHandle() {
			if (!genHandle && genContainer) {
				genHandle = mountGenView(genContainer, {
					getLang: () => app.lang,
					ctx,
					hideTopbar: true,
					onOpenInToolkit: async ({ path }) => {
						try {
							const buf = await ws.readImage(path);
							const name = basename(path);
							await addOne({ name, bytes: buf, path });
							renderQueue();
							const newest = app.items[app.items.length - 1];
							if (newest) selectItem(newest.id);
							setMode("edit");
							toast(t("mode.edit") + " ✓");
						} catch (err) {
							toast(String(err?.message ?? err), "warn");
						}
					},
				});
			}
			return genHandle;
		}

		async function useAsGenReference(item) {
			if (!item) return;
			let relPath = item.path;
			try {
				let blob;
				if (item.history?.length > 1 || !relPath) {
					const rendered = await renderToCanvas(item, { signal: null });
					const mime = outputMime(item.state);
					blob = await encodeCanvas(rendered.canvas, mime, item.state.format.quality);
					const ext = extOfMime(mime) || "png";
					const candidate = `temp/ref-${Date.now()}-${stem(item.name)}.${ext}`;
					const res = await ws.saveImage(candidate, blob, false);
					relPath = res.path;
				}
			} catch {
				if (!relPath) {
					try {
						const ext = extOfMime(item.info?.mime) || "png";
						const candidate = `temp/ref-${Date.now()}-${stem(item.name)}.${ext}`;
						const res = await ws.saveImage(candidate, item.bytes, false);
						relPath = res.path;
					} catch {}
				}
			}
			if (relPath) {
				ensureGenHandle()?.addReference(relPath);
				setMode("gen");
				toast(t("queue.useAsRef") + " ✓");
			} else {
				toast(t("queue.useAsRef") + " ✗", "warn");
			}
		}

		function setMode(nextMode) {
			app.mode = nextMode;
			if (!ui?.main || !genContainer) return;
			for (const b of studioNavBtns) {
				b.classList.toggle("on", b.dataset.mode === nextMode);
			}
			if (editActionGroup) {
				editActionGroup.style.display = nextMode === "edit" ? "inline-flex" : "none";
			}
			if (genActionGroup) {
				genActionGroup.style.display = nextMode === "gen" ? "inline-flex" : "none";
			}
			if (nextMode === "edit") {
				ui.main.style.display = "flex";
				genContainer.style.display = "none";
				scheduleRender(true);
			} else {
				ui.main.style.display = "none";
				genContainer.style.display = "flex";
				ensureGenHandle()?.switchTab(nextMode);
			}
		}

		function buildShell() {
			container.innerHTML = "";
			container.classList.add("igt-root");

			const style = el("style", { text: CSS });
			const top = el("div", { class: "igt-top" });
			const langBtn = el("button", { class: "igt-btn", text: t("app.lang"), onclick: () => switchLang() });
			const cfgBtn = el("button", {
				class: "igt-btn",
				text: "⚙",
				title: t("cfg.title"),
				onclick: () => openSettingsDialog(),
			});
			const importBtn = el("button", {
				class: "igt-btn igt-primary",
				text: t("app.import"),
				title: t("app.importHint"),
				onclick: () => fileInput.click(),
			});
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

			const refreshBtn = el("button", {
				class: "igt-btn",
				text: t("app.refresh"),
				onclick: () => ensureGenHandle()?.refreshJobs?.(),
			});

			editActionGroup = el(
				"div",
				{ class: "igt-top-group", style: app.mode === "edit" ? "display:inline-flex" : "display:none" },
				[importBtn, wsBtn, clearBtn, cfgBtn],
			);

			genActionGroup = el(
				"div",
				{ class: "igt-top-group", style: app.mode === "gen" ? "display:inline-flex" : "display:none" },
				[refreshBtn],
			);

			studioNavBtns = [
				el("button", {
					class: `igt-nav-tab${app.mode === "edit" ? " on" : ""}`,
					"data-mode": "edit",
					text: t("mode.edit"),
					onclick: () => setMode("edit"),
				}),
				el("button", {
					class: `igt-nav-tab${app.mode === "gen" ? " on" : ""}`,
					"data-mode": "gen",
					text: t("mode.gen"),
					onclick: () => setMode("gen"),
				}),
				el("button", {
					class: `igt-nav-tab${app.mode === "svc" ? " on" : ""}`,
					"data-mode": "svc",
					text: t("mode.svc"),
					onclick: () => setMode("svc"),
				}),
				el("button", {
					class: `igt-nav-tab${app.mode === "cfg" ? " on" : ""}`,
					"data-mode": "cfg",
					text: t("mode.cfg"),
					onclick: () => setMode("cfg"),
				}),
			];
			const studioNav = el("nav", { class: "igt-studio-nav" }, studioNavBtns);

			const topActions = el("div", { class: "igt-top-actions" }, [editActionGroup, genActionGroup, langBtn]);

			top.append(
				el("b", { class: "igt-title", text: `🎨 ${t("app.title")}` }),
				el("span", { class: "igt-sub", text: t("app.subtitle") }),
				el("span", { class: "igt-sp" }),
				studioNav,
				el("span", { class: "igt-sp" }),
				topActions,
			);

			const queueCount = el("b", { text: "0" });
			const queueList = el("div", { class: "igt-queue-list" });
			const queue = el("aside", { class: "igt-queue" }, [
				el("div", { class: "igt-sec" }, [
					el("span", { text: t("queue.title") }),
					el("span", { class: "igt-sp" }),
					queueCount,
				]),
				queueList,
				el("div", { class: "igt-hint igt-pad", text: t("queue.emptyHint") }),
			]);

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
				el("button", {
					class: "igt-btn igt-mini",
					text: "−",
					title: t("stage.zoomOut"),
					onclick: () => zoomBy(1 / 1.25),
				}),
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
						if (app.sheetMin) setSheetMin(false);
						buildPanel();
						scheduleRender(true);
					},
				});
				tabBtns.push(b);
				tabbar.append(b);
			}
			const panelBody = el("div", { class: "igt-panel-body" });
			const heroRow = el("div", { class: "igt-act-row igt-act-hero-row" }, [
				el("button", {
					class: "igt-btn igt-primary igt-act-hero",
					text: t("act.export"),
					onclick: () => void exportActive(),
				}),
			]);
			const flowRow = el("div", { class: "igt-act-row igt-act-flow-row" }, [
				el("button", {
					class: "igt-btn igt-btn-savews",
					text: t("act.saveWs"),
					onclick: () => openSaveDialog(),
				}),
				el("button", {
					class: "igt-btn igt-btn-flow",
					text: t("act.useAsRef"),
					onclick: () => {
						const cur = active();
						if (cur) void useAsGenReference(cur);
					},
				}),
			]);
			const batchRow = el("div", { class: "igt-act-row igt-act-batch-row" }, [
				el("button", {
					class: "igt-btn",
					text: t("act.copy"),
					title: t("act.copyHint"),
					onclick: () => void copyActive(),
				}),
				el("button", { class: "igt-btn", text: t("act.exportAll"), onclick: () => void exportAll() }),
				el("button", { class: "igt-btn", text: t("queue.sync"), onclick: () => syncToAll() }),
			]);
			const historyRow = el("div", { class: "igt-act-row igt-act-history-row" }, [
				el("button", {
					class: "igt-btn igt-mini",
					text: t("act.undo"),
					title: "Ctrl+Z",
					onclick: () => active() && undo(active()),
				}),
				el("button", {
					class: "igt-btn igt-mini",
					text: t("act.redo"),
					title: "Ctrl+Shift+Z",
					onclick: () => active() && redo(active()),
				}),
				el("button", {
					class: "igt-btn igt-mini",
					text: t("act.reset"),
					onclick: () => {
						const it = active();
						if (it) commit(it, () => (it.state = defaultState(app.cfg)), true);
					},
				}),
				el("button", {
					class: "igt-btn",
					text: t("status.calc"),
					title: t("status.calcHint"),
					onclick: () => void measureExact(),
				}),
			]);
			const actions = el("div", { class: "igt-actions" }, [heroRow, flowRow, batchRow, historyRow]);
			const grip = el("button", { class: "igt-grip", type: "button", onclick: () => setSheetMin(!app.sheetMin) });
			const panel = el("aside", { class: "igt-panel" }, [grip, tabbar, panelBody, actions]);

			const main = el("div", { class: "igt-main", style: app.mode === "edit" ? "display:flex" : "display:none" }, [
				queue,
				stage,
				panel,
			]);
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

			genContainer = el("div", {
				class: "igt-gen-wrap",
				style: app.mode === "gen" || app.mode === "svc" || app.mode === "cfg" ? "display:flex" : "display:none",
			});
			const root = el("div", { class: "igt" }, [top, main, genContainer, fileInput, overlays, toasts, statusline]);
			container.append(style, root);

			if (app.mode !== "edit") {
				ensureGenHandle()?.switchTab(app.mode);
			}

			ui = {
				root,
				main,
				style,
				queue,
				panel,
				grip,
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
			syncSheet();

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
			const stop = (e) => {
				e.preventDefault();
				e.stopPropagation();
			};
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
				const files = items
					.filter((i) => i.type.startsWith("image/"))
					.map((i) => i.getAsFile())
					.filter(Boolean);
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

		function setSheetMin(min) {
			app.sheetMin = min;
			syncSheet();
		}

		function syncSheet() {
			if (!ui?.panel) return;
			ui.panel.classList.toggle("igt-min", app.sheetMin);
			ui.grip.textContent = app.sheetMin ? `▲ ${t("sheet.expand")}` : `▼ ${t("sheet.collapse")}`;
			ui.grip.title = app.sheetMin ? t("sheet.expand") : t("sheet.collapse");
		}

		function switchLang() {
			app.lang = app.lang === "zh" ? "en" : "zh";
			if (genHandle?.load) genHandle.load(true);
			rebuild();
		}

		function rebuild() {
			cropper?.destroy();
			cropper = null;
			for (const f of cleanupFns) {
				try {
					f();
				} catch {}
			}
			cleanupFns = [];
			buildShell();
			renderQueue();
			buildPanel();
			scheduleRender(true);
		}

		buildShell();
		renderQueue();
		buildPanel();
		scheduleRender(true);

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
			.catch(() => {});

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
				} catch {}
			}
			cleanupFns = [];
			cropper?.destroy();
			cropper = null;
			genHandle?.unmount?.();
			genHandle = null;
			for (const it of app.items) it.bitmap?.close?.();
			container.innerHTML = "";
		};
	},
};

const CSS = `
.igt-root { position: relative; display: flex; flex-direction: column; overflow: hidden; }
.igt { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); }
.igt-top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-soft, #1e2230); background: var(--topbar-bg, var(--bg-elev, #14161c)); flex-wrap: wrap; min-width: 0; }
.igt-title { font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
.igt-sub { color: var(--text-faint, #6b7284); font-size: 11.5px; }
.igt-sp { flex: 1; }
.igt-studio-nav { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border-radius: 9px; background: var(--sunken-bg, rgba(0, 0, 0, .2)); border: 1px solid var(--border-soft, #1e2230); flex: none; }
.igt-nav-tab { border: none; background: transparent; color: var(--text-dim, #9aa1b4); border-radius: 7px; padding: 4px 11px; cursor: pointer; font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; transition: background .12s ease, color .12s ease; }
.igt-nav-tab:hover { color: var(--text, #e6e8ef); background: rgba(255, 255, 255, .05); }
.igt-nav-tab.on { color: #fff; background: var(--card-bg, var(--bg-elev2, #1a1d26)); box-shadow: 0 1px 3px rgba(0, 0, 0, .35); font-weight: 500; }
.igt-top-actions { display: inline-flex; align-items: center; gap: 6px; }
.igt-top-group { display: inline-flex; align-items: center; gap: 6px; }
.igt-gen-wrap { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
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
/* 底部抽屉手柄：只在手机窄屏显示（宽屏参数栏常驻，不需要开合） */
.igt-grip { display: none; }
.igt-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px; border-bottom: 1px solid var(--border-soft, #1e2230); }
.igt-tab { background: transparent; border: 1px solid transparent; color: var(--text-dim, #9aa1b4); font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
.igt-tab:hover { color: var(--text, #e6e8ef); }
.igt-tab.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cf6); color: var(--text, #e6e8ef); }
.igt-panel-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 9px; }
.igt-actions { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-top: 1px solid var(--border-soft, #1e2230); background: var(--bg-elev, #14161c); }
.igt-act-row { display: grid; gap: 6px; width: 100%; box-sizing: border-box; }
.igt-act-hero-row { grid-template-columns: 1fr; }
.igt-act-hero { justify-content: center; padding: 8px 12px; font-weight: 600; font-size: 13px; border-radius: 8px; }
.igt-act-flow-row { grid-template-columns: 1fr 1fr; }
.igt-act-flow-row .igt-btn { justify-content: center; padding: 6px 8px; font-size: 11.5px; border-radius: 7px; }
.igt-btn-flow { border-color: rgba(139, 92, 246, 0.45); color: var(--accent, #a78bfa); background: rgba(139, 92, 246, 0.08); font-weight: 500; }
.igt-btn-flow:hover { background: rgba(139, 92, 246, 0.18); border-color: var(--accent, #8b5cf6); }
.igt-act-batch-row { grid-template-columns: 1fr 1.3fr 1.3fr; }
.igt-act-batch-row .igt-btn { justify-content: center; padding: 5px 4px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 6px; }
.igt-act-history-row { grid-template-columns: 1fr 1fr 1.2fr 1.2fr; }
.igt-act-history-row .igt-btn { justify-content: center; padding: 4px 4px; font-size: 10.5px; border-radius: 5px; }
.igt-ctl { display: flex; flex-direction: column; gap: 4px; }
.igt-ctl-hd { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-ctl-label { font-size: 12px; color: var(--text-dim, #9aa1b4); }
.igt-ctl-val { font-size: 11px; color: var(--text, #e6e8ef); font-variant-numeric: tabular-nums; }
.igt-input { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px; width: 100%; }
.igt-input[type="range"] { padding: 0; border: none; background: transparent; }
.igt-input[type="checkbox"] { width: auto; }
.igt-color { width: 30px; height: 22px; padding: 0; border: 1px solid var(--border, #262a35); border-radius: 5px; background: none; }
.igt-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 4px 9px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.igt-btn:hover { border-color: var(--accent, #8b5cf6); }
.igt-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cf6); }
.igt-btn.igt-primary { background: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); color: var(--accent-contrast, #fff); }
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
.igt-crop-ne { right: -6px; top: -6px; cursor: nesw-resize; }
.igt-crop-e { right: -6px; top: 50%; margin-top: -5px; cursor: ew-resize; }
.igt-crop-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.igt-crop-s { left: 50%; bottom: -6px; margin-left: -5px; cursor: ns-resize; }
.igt-crop-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.igt-crop-w { left: -6px; top: 50%; margin-top: -5px; cursor: ew-resize; }

/* ---- 手机端（≤640px）：三栏 → 上下堆叠 ---------------------------------
   宿主在手机上本来就是单列铺满，三栏固定宽度（队列 236 + 舞台 + 面板 320）
   在这里必定挤爆。改法：
     顶部 = 队列（横向缩略图带，只留缩略图 + 删除）
     中间 = 舞台（主区，尽量把纵向空间让给图）
     底部 = 参数抽屉（手柄可收起，收起后只剩 tab 行 + 动作行）
   各区域自己滚（overflow），插件根不超高，不给宿主的 .plugin-view 添外层滚动。 */
@media (max-width: 640px) {
	.igt-top { padding: 8px 10px; gap: 6px; }
	.igt-sub { display: none; }
	.igt-top .igt-btn { padding: 7px 11px; }

	.igt-main { flex-direction: column; }

	/* 队列 → 顶部横向缩略图带 */
	.igt-queue { width: auto; flex: none; border-right: none; border-bottom: 1px solid var(--border, #262a35); }
	.igt-queue.igt-empty { display: none; }
	.igt-queue .igt-sec { padding: 3px 8px; border-bottom: none; font-size: 11px; }
	/* 「拖入图片 / Ctrl+V 粘贴」那条引导是给桌面空队列看的，手机上有缩略图带就不必占两行 */
	.igt-queue > .igt-hint.igt-pad { display: none; }
	.igt-queue-list { flex-direction: row; align-items: center; overflow-x: auto; overflow-y: hidden; padding: 6px 8px; gap: 6px; }
	.igt-qitem { flex: none; padding: 3px; gap: 0; }
	.igt-qthumb { width: 46px; height: 46px; }
	/* 手机宽度里名字/尺寸全是省略号，不如只留缩略图 */
	.igt-qmeta { display: none; }
	.igt-x { font-size: 17px; padding: 6px 9px; }

	/* 舞台：主区 */
	.igt-stage { flex: 1 1 auto; min-height: 0; }
	.igt-stagebar { padding: 5px 8px; overflow-x: auto; }
	.igt-stagebar .igt-btn { flex: none; padding: 7px 10px; }
	.igt-viewwrap { padding: 8px; }
	/* 状态条不换行（换行会把舞台越顶越小），内容一长就横向滚 */
	.igt-statusbar { padding: 5px 8px; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; }

	/* 参数 → 底部抽屉 */
	.igt-panel { width: auto; flex: none; border-left: none; border-top: 1px solid var(--border, #262a35); max-height: 66%; }
	.igt-grip { display: flex; align-items: center; justify-content: center; width: 100%; height: 28px; flex: none; padding: 0; border: none; border-bottom: 1px solid var(--border-soft, #1e2230); background: transparent; color: var(--text-faint, #6b7284); font: inherit; font-size: 11px; cursor: pointer; }
	.igt-tabs { flex-wrap: nowrap; overflow-x: auto; }
	.igt-tab { flex: none; padding: 7px 11px; }
	.igt-panel-body { max-height: min(32vh, 280px); }
	.igt-panel.igt-min .igt-panel-body { display: none; }
	.igt-studio-nav { order: 3; width: 100%; justify-content: center; margin-top: 4px; }
	.igt-actions { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; padding: 8px 10px; gap: 6px; }
	.igt-act-row { display: contents; }
	.igt-actions .igt-btn { flex: none; padding: 7px 11px; }

	/* 弹窗 / 浮层 / 工作区列表：小屏上别浪费宽度，行高按能点中做 */
	.igt-modal { width: min(560px, 94%); max-height: 86%; }
	.igt-modal-ft .igt-btn { padding: 8px 12px; }
	.igt-wsitem { padding: 8px 6px; }
	.igt-wsthumb, .igt-wsicon { width: 40px; }
	.igt-wsthumb { height: 40px; }
	.igt-btnrow .igt-btn { padding: 7px 10px; }
	.igt-toasts { left: 10px; right: 10px; bottom: 10px; }
	.igt-toast { max-width: none; }
}

/* ---- 触屏：把手 / 滑杆 / 勾选框放大到能按住 ---------------------------- */
@media (pointer: coarse) {
	.igt-crop-h { width: 20px; height: 20px; border-radius: 4px; }
	.igt-crop-nw { left: -10px; top: -10px; }
	.igt-crop-n { left: 50%; top: -10px; margin-left: -10px; }
	.igt-crop-ne { right: -10px; top: -10px; }
	.igt-crop-e { right: -10px; top: 50%; margin-top: -10px; }
	.igt-crop-se { right: -10px; bottom: -10px; }
	.igt-crop-s { left: 50%; bottom: -10px; margin-left: -10px; }
	.igt-crop-sw { left: -10px; bottom: -10px; }
	.igt-crop-w { left: -10px; top: 50%; margin-top: -10px; }
	.igt-input[type="range"] { height: 24px; }
	.igt-input[type="checkbox"] { width: 18px; height: 18px; }
	.igt-ctl-hd { min-height: 22px; }
}
`;
