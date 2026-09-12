/**
 * 裁剪选框交互：框内拖动平移 + 8 个把手缩放 + 框外拖拽画新选区 + 三分线 + 形状轮廓。
 *
 * 三种拖动：
 *   1. 框内按住 → 平移选框（命中区 .igt-crop-move）；
 *   2. 8 个把手 → 改宽高（锁比例时联动另一个维度）；
 *   3. 框外（压暗区）按住 → 从落点拉出一个新选框。
 *
 * 性能与手感（以前很卡，原因写这儿免得再犯）：
 *   - 框外遮罩用四块固定色块，不用 `box-shadow: 0 0 0 9999px`（那玩意每帧重绘一大片）；
 *   - pointermove 走 rAF 合批，一帧只应用最后一次位置；松手补最后一段位移；
 *   - 拖动开始时把边界/比例/起点缓存下来，拖动期间不读 DOM 布局；
 *   - 只挪覆盖层，**不触发画布重渲染**（调用方负责）；
 *   - 所有 pointerdown 一律 preventDefault + CSS 禁用原生拖拽/选中：否则在 Chrome 里
 *     按住 canvas 会开始「原生拖图」，既出现拖影又冒泡出主应用的拖放提示框。
 *
 * 坐标系：本模块只认**显示像素**（画布在屏幕上的 CSS 尺寸），与源图像素/代理分辨率
 * 无关；换算由调用方在 onChange / rect 里做。
 */

const NS = "http://www.w3.org/2000/svg";
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 10; // 选框最小边长（显示像素）
const CLICK_SLOP = 4; // 位移小于这个值算「点一下」，不当作拖拽

export function createCropper(layer, opts) {
	layer.classList.add("igt-crop");
	// 仅当宿主给的容器没有定位时才补 relative；视图传的是 .igt-crop-layer
	// （absolute; inset:0），强制改掉会把选框整块推到自己高度之下。
	if (getComputedStyle(layer).position === "static") layer.style.position = "relative";

	// 框外遮罩：四块（不再用 9999px 的 box-shadow）
	const dims = {};
	for (const side of ["t", "r", "b", "l"]) {
		dims[side] = document.createElement("div");
		dims[side].className = `igt-crop-dim igt-crop-dim-${side}`;
		layer.appendChild(dims[side]);
	}

	const box = document.createElement("div");
	box.className = "igt-crop-box";

	const grid = document.createElement("div");
	grid.className = "igt-crop-grid";
	grid.innerHTML = "<i></i><i></i><i></i><i></i>";

	// 框内平移命中区（必须在把手之前 append：后面的兄弟节点盖在上面）
	const move = document.createElement("div");
	move.className = "igt-crop-move";
	move.dataset.h = "move";

	// 形状轮廓：外框 + 形状路径用 evenodd 填半透明，等于「框内、形状外」也压暗
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("class", "igt-crop-svg");
	svg.setAttribute("preserveAspectRatio", "none");
	const shapeFill = document.createElementNS(NS, "path");
	shapeFill.setAttribute("class", "igt-crop-shape-fill");
	shapeFill.setAttribute("fill-rule", "evenodd");
	const shapeLine = document.createElementNS(NS, "path");
	shapeLine.setAttribute("class", "igt-crop-shape-line");
	svg.append(shapeFill, shapeLine);

	box.append(grid, move, svg);
	for (const h of HANDLES) {
		const el = document.createElement("span");
		el.className = `igt-crop-h igt-crop-${h}`;
		el.dataset.h = h;
		box.appendChild(el);
	}
	layer.appendChild(box);

	function snapshot() {
		return { bounds: opts.bounds(), ratio: opts.ratio() ?? null, rect: opts.rect() };
	}

	/** 收进边界 + 满足比例 + 最小边长。 */
	function fit(r0, snap) {
		const b = snap?.bounds ?? opts.bounds();
		const ratio = snap ? snap.ratio : (opts.ratio() ?? null);
		let { x, y, w, h } = r0;
		w = Math.max(MIN, Math.min(w, b.width));
		h = Math.max(MIN, Math.min(h, b.height));
		if (ratio) {
			h = w / ratio;
			if (h > b.height) {
				h = b.height;
				w = h * ratio;
			}
			if (w > b.width) {
				w = b.width;
				h = w / ratio;
			}
		}
		x = Math.max(0, Math.min(x, b.width - w));
		y = Math.max(0, Math.min(y, b.height - h));
		return { x, y, w, h };
	}

	/** 把手拖拽 → 新矩形。 */
	function applyDrag(r0, handle, dx, dy, snap) {
		let { x, y, w, h } = r0;
		if (handle === "move") {
			x += dx;
			y += dy;
		} else {
			if (handle.includes("w")) {
				x += dx;
				w -= dx;
			}
			if (handle.includes("e")) w += dx;
			if (handle.includes("n")) {
				y += dy;
				h -= dy;
			}
			if (handle.includes("s")) h += dy;
		}
		return fit({ x, y, w, h }, snap);
	}

	/**
	 * 统一的指针拖拽：extract(ev) 给出本帧的矩形，回调只发结果。
	 * 返回 false 表示这一下算点击、不该改选区（调用方用来区分）。
	 */
	function beginDrag(ev, extract) {
		const snap = snapshot();
		ev.preventDefault();
		ev.stopPropagation();
		let pending = null;
		let raf = 0;
		let moved = false;

		const flush = () => {
			raf = 0;
			if (!pending) return;
			const p = pending;
			pending = null;
			if (!moved && Math.abs(p.dx) < CLICK_SLOP && Math.abs(p.dy) < CLICK_SLOP) return;
			moved = true;
			opts.onChange(extract(p, snap));
			render(); // 立刻按新状态挪覆盖层，不等画布重渲染
		};
		const moveHandler = (e) => {
			pending = { dx: e.clientX - ev.clientX, dy: e.clientY - ev.clientY, cx: e.clientX, cy: e.clientY };
			if (!raf) raf = requestAnimationFrame(flush);
		};
		const upHandler = () => {
			window.removeEventListener("pointermove", moveHandler);
			window.removeEventListener("pointerup", upHandler);
			window.removeEventListener("pointercancel", upHandler);
			if (raf) cancelAnimationFrame(raf);
			flush(); // 收尾：把最后一段位移补上，不能丢
			return moved;
		};
		window.addEventListener("pointermove", moveHandler);
		window.addEventListener("pointerup", upHandler);
		window.addEventListener("pointercancel", upHandler);
		return { get moved() { return moved; } };
	}

	/** 盒子上的拖动：把手缩放 / 框内平移。 */
	function onBoxDown(ev) {
		const handle = ev.target?.dataset?.h;
		if (!handle) return;
		const snap0 = snapshot();
		const r0 = snap0.rect;
		const ox = ev.clientX;
		const oy = ev.clientY;
		beginDrag(ev, (p, snap) => applyDrag(r0, handle, p.cx - ox, p.cy - oy, snap));
	}

	/** 框外（压暗区）拖动：从落点拉出一个新选框。 */
	function onLayerDown(ev) {
		const t = ev.target;
		const onDim = t === layer || (t?.classList?.contains("igt-crop-dim") ?? false);
		if (!onDim) return;
		const snap0 = snapshot();
		const prev = snap0.rect;
		const stage = layer.getBoundingClientRect();
		const ax = ev.clientX - stage.left;
		const ay = ev.clientY - stage.top;
		const drag = beginDrag(ev, (p, snap) => {
			const cx = Math.max(0, Math.min(p.cx - stage.left, snap.bounds.width));
			const cy = Math.max(0, Math.min(p.cy - stage.top, snap.bounds.height));
			return fit(
				{ x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) },
				snap,
			);
		});
		// 只是点了一下压暗区（没拖出框）→ 保持原选区，别把框缩成一点
		window.addEventListener(
			"pointerup",
			() => {
				if (!drag.moved) opts.onChange(prev);
			},
			{ once: true },
		);
	}

	box.addEventListener("pointerdown", onBoxDown);
	layer.addEventListener("pointerdown", onLayerDown);

	/** 布局：遮罩四块 + 选框 + 形状轮廓。只在尺寸/参数变化时调，拖动中不调。 */
	function render() {
		const b = opts.bounds();
		if (b.width < 1 || b.height < 1) return;
		const r = fit(opts.rect());
		layer.style.left = "0px";
		layer.style.top = "0px";
		layer.style.width = `${b.width}px`;
		layer.style.height = `${b.height}px`;

		// 四块遮罩（上/下整宽，左/右只占选框那一段）
		dims.t.style.cssText = `left:0;top:0;width:${b.width}px;height:${r.y}px`;
		dims.b.style.cssText = `left:0;top:${r.y + r.h}px;width:${b.width}px;height:${Math.max(0, b.height - r.y - r.h)}px`;
		dims.l.style.cssText = `left:0;top:${r.y}px;width:${r.x}px;height:${r.h}px`;
		dims.r.style.cssText = `left:${r.x + r.w}px;top:${r.y}px;width:${Math.max(0, b.width - r.x - r.w)}px;height:${r.h}px`;

		box.style.left = `${r.x}px`;
		box.style.top = `${r.y}px`;
		box.style.width = `${r.w}px`;
		box.style.height = `${r.h}px`;
		grid.style.display = opts.grid?.() === false ? "none" : "";

		// 形状轮廓（矩形时整块隐藏，样式与纯矩形裁剪完全一致）
		const shape = opts.shape?.() ?? "rect";
		if (shape === "rect" || shape === "none") {
			svg.style.display = "none";
		} else {
			svg.style.display = "";
			svg.setAttribute("viewBox", `0 0 ${r.w} ${r.h}`);
			svg.setAttribute("width", String(r.w));
			svg.setAttribute("height", String(r.h));
			const outer = `M0 0 L${r.w} 0 L${r.w} ${r.h} L0 ${r.h} Z`;
			const inner = opts.shapePathD?.(shape, r.w, r.h) ?? "";
			shapeFill.setAttribute("d", `${outer} ${inner}`);
			shapeLine.setAttribute("d", inner);
		}
	}

	return {
		render,
		/** 比例/形状变化后立刻收一次形（避免出现一个不合比例或不合形状的框）。 */
		normalize() {
			opts.onChange(fit(opts.rect()));
		},
		destroy() {
			box.removeEventListener("pointerdown", onBoxDown);
			layer.removeEventListener("pointerdown", onLayerDown);
			box.remove();
			for (const side of ["t", "r", "b", "l"]) dims[side].remove();
		},
	};
}
