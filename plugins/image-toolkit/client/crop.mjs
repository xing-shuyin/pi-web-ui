const NS = "http://www.w3.org/2000/svg";
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 10;
const CLICK_SLOP = 4;

export function createCropper(layer, opts) {
	layer.classList.add("igt-crop");
	if (getComputedStyle(layer).position === "static") layer.style.position = "relative";

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

	const move = document.createElement("div");
	move.className = "igt-crop-move";
	move.dataset.h = "move";

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
			render();
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
			flush();
			return moved;
		};
		window.addEventListener("pointermove", moveHandler);
		window.addEventListener("pointerup", upHandler);
		window.addEventListener("pointercancel", upHandler);
		return {
			get moved() {
				return moved;
			},
		};
	}

	function onBoxDown(ev) {
		const handle = ev.target?.dataset?.h;
		if (!handle) return;
		const snap0 = snapshot();
		const r0 = snap0.rect;
		const ox = ev.clientX;
		const oy = ev.clientY;
		beginDrag(ev, (p, snap) => applyDrag(r0, handle, p.cx - ox, p.cy - oy, snap));
	}

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
			return fit({ x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) }, snap);
		});
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

	function render() {
		const b = opts.bounds();
		if (b.width < 1 || b.height < 1) return;
		const r = fit(opts.rect());
		layer.style.left = "0px";
		layer.style.top = "0px";
		layer.style.width = `${b.width}px`;
		layer.style.height = `${b.height}px`;

		dims.t.style.cssText = `left:0;top:0;width:${b.width}px;height:${r.y}px`;
		dims.b.style.cssText = `left:0;top:${r.y + r.h}px;width:${b.width}px;height:${Math.max(0, b.height - r.y - r.h)}px`;
		dims.l.style.cssText = `left:0;top:${r.y}px;width:${r.x}px;height:${r.h}px`;
		dims.r.style.cssText = `left:${r.x + r.w}px;top:${r.y}px;width:${Math.max(0, b.width - r.x - r.w)}px;height:${r.h}px`;

		box.style.left = `${r.x}px`;
		box.style.top = `${r.y}px`;
		box.style.width = `${r.w}px`;
		box.style.height = `${r.h}px`;
		grid.style.display = opts.grid?.() === false ? "none" : "";

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
