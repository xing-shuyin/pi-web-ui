import { useEffect, useRef, useState } from "react";
import { FiArrowUpRight, FiCornerUpLeft, FiEdit3, FiSquare, FiType } from "react-icons/fi";
import { useT } from "../i18n";
import { annotationPoint, drawImageAnnotation, type AnnotationTool, type ImageAnnotation } from "../image-annotations";

export function ImageAnnotationEditor({
	src,
	onSave,
	onCancel,
	saveLabel,
}: {
	src: string;
	onSave: (dataUrl: string) => void | Promise<void>;
	onCancel: () => void;
	saveLabel?: string;
}) {
	const t = useT();
	const canvas = useRef<HTMLCanvasElement>(null);
	const image = useRef<HTMLImageElement | null>(null);
	const draft = useRef<ImageAnnotation | null>(null);
	const pointer = useRef<number | null>(null);
	const [revision, redraw] = useState(0);
	const [marks, setMarks] = useState<ImageAnnotation[]>([]);
	const [tool, setTool] = useState<AnnotationTool>("pen");
	const [color, setColor] = useState("#ef4444");
	const [label, setLabel] = useState("");
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		setReady(false);
		setMarks([]);
		setError("");
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			if (!alive.current || !canvas.current) return;
			image.current = img;
			const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
			canvas.current.width = Math.max(1, Math.round(img.naturalWidth * scale));
			canvas.current.height = Math.max(1, Math.round(img.naturalHeight * scale));
			setReady(true);
			redraw((n) => n + 1);
		};
		img.onerror = () => {
			if (alive.current) setError(t("imagePreviewFailed"));
		};
		img.src = src;
		return () => {
			alive.current = false;
			img.onload = null;
			img.onerror = null;
			draft.current = null;
			image.current = null;
		};
	}, [src, t]);

	useEffect(() => {
		const el = canvas.current;
		const ctx = el?.getContext("2d");
		if (!el || !ctx || !image.current) return;
		ctx.clearRect(0, 0, el.width, el.height);
		ctx.drawImage(image.current, 0, 0, el.width, el.height);
		for (const mark of marks) drawImageAnnotation(ctx, mark);
		if (draft.current) drawImageAnnotation(ctx, draft.current);
	}, [marks, revision, ready]);

	const point = (e: React.PointerEvent<HTMLCanvasElement>) =>
		annotationPoint(
			e.clientX,
			e.clientY,
			e.currentTarget.getBoundingClientRect(),
			e.currentTarget.width,
			e.currentTarget.height,
		);
	const stop = (e: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
		if (pointer.current !== e.pointerId) return;
		if (commit && draft.current) {
			const mark = draft.current;
			if (mark.tool !== "pen") mark.points = [mark.points[0], point(e)];
			setMarks((items) => [...items, mark]);
		}
		draft.current = null;
		pointer.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		redraw((n) => n + 1);
	};

	return (
		<div className="image-annotation-editor">
			<div className="image-annotation-toolbar" role="toolbar" aria-label={t("imageAnnotate")}>
				{(
					[
						["pen", FiEdit3, "imageAnnotatePen"],
						["arrow", FiArrowUpRight, "imageAnnotateArrow"],
						["rectangle", FiSquare, "imageAnnotateRectangle"],
						["text", FiType, "imageAnnotateText"],
					] as const
				).map(([id, Icon, key]) => (
					<button
						key={id}
						type="button"
						className={`btn ${tool === id ? "active" : ""}`}
						aria-pressed={tool === id}
						disabled={saving}
						onClick={() => setTool(id)}
					>
						<Icon />
						{t(key)}
					</button>
				))}
				<input
					type="color"
					aria-label={t("imageAnnotateColor")}
					value={color}
					disabled={saving}
					onChange={(e) => setColor(e.target.value)}
				/>
				{tool === "text" && (
					<input
						type="text"
						className="image-annotation-text"
						aria-label={t("imageAnnotateText")}
						placeholder={t("imageAnnotateTextHint")}
						value={label}
						maxLength={280}
						disabled={saving}
						onChange={(e) => setLabel(e.target.value)}
					/>
				)}
				<button
					type="button"
					className="btn"
					disabled={!marks.length || saving}
					onClick={() => setMarks((items) => items.slice(0, -1))}
				>
					<FiCornerUpLeft />
					{t("imageAnnotateUndo")}
				</button>
				<button type="button" className="btn" disabled={saving} onClick={onCancel}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="btn primary"
					disabled={!ready || !marks.length || saving}
					onClick={async () => {
						if (!canvas.current || saving) return;
						setSaving(true);
						setError("");
						try {
							await onSave(canvas.current.toDataURL("image/png"));
						} catch {
							if (alive.current) setError(t("imageAnnotateSaveFailed"));
						} finally {
							if (alive.current) setSaving(false);
						}
					}}
				>
					{saveLabel ?? t("imageAnnotateSave")}
				</button>
			</div>
			<p className="img-lightbox-hint">{t(tool === "text" ? "imageAnnotateTextHint" : "imageAnnotateHint")}</p>
			{error && <p role="alert">{error}</p>}
			<div className="image-annotation-stage">
				<canvas
					ref={canvas}
					className="image-annotation-canvas"
					aria-label={t("imageAnnotateCanvas")}
					onPointerDown={(e) => {
						if (!ready || saving || pointer.current !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
						const start = point(e);
						const mark: ImageAnnotation = {
							tool,
							color,
							width: Math.max(3, e.currentTarget.width / 300),
							points: [start],
						};
						if (tool === "text") {
							if (label.trim()) setMarks((items) => [...items, { ...mark, text: label.trim() }]);
							return;
						}
						e.preventDefault();
						e.currentTarget.setPointerCapture(e.pointerId);
						pointer.current = e.pointerId;
						draft.current = mark;
						redraw((n) => n + 1);
					}}
					onPointerMove={(e) => {
						if (!draft.current || pointer.current !== e.pointerId) return;
						e.preventDefault();
						const p = point(e);
						draft.current.points = tool === "pen" ? [...draft.current.points, p] : [draft.current.points[0], p];
						redraw((n) => n + 1);
					}}
					onPointerUp={(e) => stop(e, true)}
					onPointerCancel={(e) => stop(e, false)}
					onLostPointerCapture={(e) => stop(e, false)}
				/>
			</div>
		</div>
	);
}
