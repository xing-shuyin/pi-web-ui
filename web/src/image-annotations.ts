export interface AnnotationPoint {
	x: number;
	y: number;
}
export type AnnotationTool = "pen" | "arrow" | "rectangle" | "text";
export interface ImageAnnotation {
	tool: AnnotationTool;
	color: string;
	width: number;
	points: AnnotationPoint[];
	text?: string;
}

export function annotationPoint(
	clientX: number,
	clientY: number,
	rect: { left: number; top: number; width: number; height: number },
	width: number,
	height: number,
): AnnotationPoint {
	return {
		x: Math.max(0, Math.min(width, ((clientX - rect.left) * width) / Math.max(1, rect.width))),
		y: Math.max(0, Math.min(height, ((clientY - rect.top) * height) / Math.max(1, rect.height))),
	};
}

export function drawImageAnnotation(ctx: CanvasRenderingContext2D, mark: ImageAnnotation): void {
	const first = mark.points[0];
	if (!first) return;
	const last = mark.points[mark.points.length - 1];
	ctx.save();
	ctx.strokeStyle = mark.color;
	ctx.fillStyle = mark.color;
	ctx.lineWidth = mark.width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (mark.tool === "text") {
		ctx.font = `600 ${Math.max(16, mark.width * 6)}px system-ui, sans-serif`;
		ctx.textBaseline = "top";
		for (const [i, line] of (mark.text || "").split("\n").entries())
			ctx.fillText(line, first.x, first.y + i * Math.max(20, mark.width * 7.5));
	} else if (mark.tool === "rectangle") {
		ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
	} else if (mark.tool === "pen" && mark.points.length === 1) {
		ctx.beginPath();
		ctx.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2);
		ctx.fill();
	} else {
		ctx.beginPath();
		ctx.moveTo(first.x, first.y);
		for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y);
		ctx.stroke();
		if (mark.tool === "arrow") {
			const angle = Math.atan2(last.y - first.y, last.x - first.x);
			const size = Math.max(12, mark.width * 4);
			ctx.beginPath();
			ctx.moveTo(last.x - size * Math.cos(angle - Math.PI / 6), last.y - size * Math.sin(angle - Math.PI / 6));
			ctx.lineTo(last.x, last.y);
			ctx.lineTo(last.x - size * Math.cos(angle + Math.PI / 6), last.y - size * Math.sin(angle + Math.PI / 6));
			ctx.stroke();
		}
	}
	ctx.restore();
}
