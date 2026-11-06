export const CROP_SHAPES = ["rect", "rounded", "ellipse", "circle", "diamond", "heart", "star"];

const K = 0.5522847498307936;

/**
 * 形状路径命令。
 * @param shape  CROP_SHAPES 里的值（"circle" 与 "ellipse" 路径相同，区别只在比例约束）
 * @param w,h    外接矩形尺寸（像素）
 * @param radiusPct  圆角矩形专用：半径占短边百分比（0..50）
 */
export function shapeCommands(shape, w, h, radiusPct = 12) {
	const cx = w / 2;
	const cy = h / 2;
	const rx = w / 2;
	const ry = h / 2;
	const map = (x, y) => [(x / 100) * w, (y / 100) * h];

	switch (shape) {
		case "ellipse":
		case "circle":
			return [
				{ c: "M", p: [cx, 0] },
				{ c: "C", p: [cx + K * rx, 0, w, cy - K * ry, w, cy] },
				{ c: "C", p: [w, cy + K * ry, cx + K * rx, h, cx, h] },
				{ c: "C", p: [cx - K * rx, h, 0, cy + K * ry, 0, cy] },
				{ c: "C", p: [0, cy - K * ry, cx - K * rx, 0, cx, 0] },
				{ c: "Z", p: [] },
			];

		case "rounded": {
			const min = Math.min(w, h);
			const r = Math.max(0, Math.min(min / 2, (radiusPct / 100) * min));
			if (r <= 0.5) return rectCommands(w, h);
			const k = K * r;
			return [
				{ c: "M", p: [r, 0] },
				{ c: "L", p: [w - r, 0] },
				{ c: "C", p: [w - r + k, 0, w, r - k, w, r] },
				{ c: "L", p: [w, h - r] },
				{ c: "C", p: [w, h - r + k, w - r + k, h, w - r, h] },
				{ c: "L", p: [r, h] },
				{ c: "C", p: [r - k, h, 0, h - r + k, 0, h - r] },
				{ c: "L", p: [0, r] },
				{ c: "C", p: [0, r - k, r - k, 0, r, 0] },
				{ c: "Z", p: [] },
			];
		}

		case "diamond":
			return [
				{ c: "M", p: [cx, 0] },
				{ c: "L", p: [w, cy] },
				{ c: "L", p: [cx, h] },
				{ c: "L", p: [0, cy] },
				{ c: "Z", p: [] },
			];

		case "heart": {
			const pts = [
				{ c: "M", p: map(50, 92) },
				{ c: "C", p: [...map(14, 68), ...map(4, 48), ...map(4, 34)] },
				{ c: "C", p: [...map(4, 16), ...map(18, 4), ...map(33, 4)] },
				{ c: "C", p: [...map(42, 4), ...map(47, 9), ...map(50, 16)] },
				{ c: "C", p: [...map(53, 9), ...map(58, 4), ...map(67, 4)] },
				{ c: "C", p: [...map(82, 4), ...map(96, 16), ...map(96, 34)] },
				{ c: "C", p: [...map(96, 48), ...map(86, 68), ...map(50, 92)] },
				{ c: "Z", p: [] },
			];
			return pts;
		}

		case "star": {
			const outer = 50;
			const inner = outer * 0.382;
			const cmds = [];
			for (let i = 0; i < 10; i++) {
				const a = -Math.PI / 2 + (i * Math.PI) / 5;
				const r = i % 2 === 0 ? outer : inner;
				const [x, y] = map(50 + Math.cos(a) * r, 50 + Math.sin(a) * r);
				cmds.push({ c: i === 0 ? "M" : "L", p: [x, y] });
			}
			cmds.push({ c: "Z", p: [] });
			return cmds;
		}

		default:
			return rectCommands(w, h);
	}
}

export function rectCommands(w, h) {
	return [
		{ c: "M", p: [0, 0] },
		{ c: "L", p: [w, 0] },
		{ c: "L", p: [w, h] },
		{ c: "L", p: [0, h] },
		{ c: "Z", p: [] },
	];
}

export function traceCommands(ctx, cmds) {
	ctx.beginPath();
	for (const { c, p } of cmds) {
		if (c === "M") ctx.moveTo(p[0], p[1]);
		else if (c === "L") ctx.lineTo(p[0], p[1]);
		else if (c === "C") ctx.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
		else if (c === "Z") ctx.closePath();
	}
}

export function toPathD(cmds) {
	const num = (n) => String(Math.round(n * 100) / 100);
	return cmds.map(({ c, p }) => (c === "Z" ? "Z" : `${c}${p.map(num).join(" ")}`)).join(" ");
}
