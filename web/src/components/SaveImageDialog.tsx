import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiCheckCircle, FiCopy, FiLoader, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { closeExportImage, setExportImageIncludes, useExportImage } from "../export-image-state";
import {
	isLightColor,
	parseCssColor,
	pickExportPixelRatio,
	rasterizeElementToPngBlob,
	resolveExportBackdrop,
	snapshotMessageForExport,
} from "../message-image";

function cssEscape(id: string): string {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(id);
	return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function queryMsgEl(id: string): HTMLElement | null {
	return (
		document.querySelector<HTMLElement>(`.msg[data-msg-id="${cssEscape(id)}"]`) ??
		document.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(id)}"]`)
	);
}

/**
 * 右侧停靠的保存为图片面板。预览卡就是导出源。
 * 不用全屏 backdrop，以便对话里的勾选框还能点。
 */
export function SaveImageDialog(): ReactNode {
	const t = useT();
	const exp = useExportImage();
	const [title, setTitle] = useState("");
	const [border, setBorder] = useState(false);
	const [watermark, setWatermark] = useState(false);
	const [watermarkText, setWatermarkText] = useState("pi-web-ui");
	const [busy, setBusy] = useState(false);
	const [previewBusy, setPreviewBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState("");
	const cardRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const backdropRef = useRef("#ffffff");

	useEffect(() => {
		if (!exp.open) return;
		setBusy(false);
		setCopied(false);
		setError("");
	}, [exp.open]);

	useEffect(() => {
		if (!exp.open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeExportImage();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [exp.open]);

	useLayoutEffect(() => {
		if (!exp.open) return;
		let cancelled = false;
		let attempts = 0;
		setPreviewBusy(true);
		const paint = (): void => {
			if (cancelled || !bodyRef.current) return;
			const els: HTMLElement[] = [];
			let missing = false;
			for (const id of exp.selectedIds) {
				const el = queryMsgEl(id);
				if (!el) missing = true;
				else els.push(el);
			}
			const waitingBody =
				(exp.includeThinking &&
					els.some((el) => el.querySelector(".thinking") && !el.querySelector(".thinking-body"))) ||
				(exp.includeTools && els.some((el) => el.querySelector(".toolcall") && !el.querySelector(".toolcall-body")));
			if ((missing || waitingBody) && attempts < 12) {
				attempts += 1;
				requestAnimationFrame(paint);
				return;
			}
			const first = els[0];
			const backdrop = resolveExportBackdrop(first ?? undefined);
			backdropRef.current = backdrop;
			const frag = document.createDocumentFragment();
			for (const el of els) {
				frag.appendChild(
					snapshotMessageForExport(el, backdrop, {
						includeThinking: exp.includeThinking,
						includeTools: exp.includeTools,
					}),
				);
			}
			bodyRef.current.replaceChildren(frag);
			const card = cardRef.current;
			if (card) {
				card.style.backgroundColor = backdrop;
				const parsed = parseCssColor(backdrop);
				card.style.colorScheme = parsed && !isLightColor(parsed) ? "dark" : "light";
				if (first) {
					const text = getComputedStyle(first).color;
					if (text) card.style.color = text;
				}
			}
			setPreviewBusy(false);
		};
		const raf = requestAnimationFrame(() => requestAnimationFrame(paint));
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			bodyRef.current?.replaceChildren();
		};
	}, [exp.open, exp.selectedIds, exp.includeThinking, exp.includeTools]);

	if (!exp.open) return null;

	const copy = async (): Promise<void> => {
		const card = cardRef.current;
		if (!card || busy || exp.selectedIds.length === 0) return;
		setBusy(true);
		setError("");
		try {
			const ratio = pickExportPixelRatio(card.scrollHeight, card.scrollWidth);
			if (ratio === 0) {
				setError(t("exportTooLong"));
				return;
			}
			const blob = await rasterizeElementToPngBlob(card, {
				backgroundColor: backdropRef.current,
				pixelRatio: ratio,
			});
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			setError(`${t("copyFailed")}: ${detail}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<aside className="saveimg-dock" role="dialog" aria-label={t("saveAsImage")}>
			<div className="saveimg-head">
				<span className="saveimg-title">{t("saveAsImage")}</span>
				<button
					type="button"
					className="btn"
					title={t("close")}
					aria-label={t("close")}
					onClick={() => closeExportImage()}
				>
					<FiX />
				</button>
			</div>
			<p className="saveimg-hint">{t("exportSelectHint")}</p>
			<div className="saveimg-body">
				<div className="saveimg-preview">
					<div ref={cardRef} className={`saveimg-card${border ? " saveimg-card--border" : ""}`}>
						{title.trim() ? <div className="saveimg-card-title">{title.trim()}</div> : null}
						<div ref={bodyRef} className="saveimg-card-md" />
						{watermark && watermarkText.trim() ? <div className="saveimg-card-wm">{watermarkText.trim()}</div> : null}
					</div>
				</div>
				<div className="saveimg-options">
					<label className="saveimg-opt saveimg-opt--toggle">
						<input
							type="checkbox"
							checked={exp.includeTools}
							onChange={(e) => setExportImageIncludes({ includeTools: e.target.checked })}
						/>
						<span>{t("exportIncludeTools")}</span>
					</label>
					<label className="saveimg-opt saveimg-opt--toggle">
						<input
							type="checkbox"
							checked={exp.includeThinking}
							onChange={(e) => setExportImageIncludes({ includeThinking: e.target.checked })}
						/>
						<span>{t("exportIncludeThinking")}</span>
					</label>
					<label className="saveimg-opt">
						<span>{t("imageTitle")}</span>
						<input
							type="text"
							className="dialog-input saveimg-input"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder={t("imageTitlePlaceholder")}
						/>
					</label>
					<label className="saveimg-opt saveimg-opt--toggle">
						<input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} />
						<span>{t("imageBorder")}</span>
					</label>
					<label className="saveimg-opt saveimg-opt--toggle">
						<input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} />
						<span>{t("imageWatermark")}</span>
					</label>
					<input
						type="text"
						className="dialog-input saveimg-input"
						value={watermarkText}
						disabled={!watermark}
						onChange={(e) => setWatermarkText(e.target.value)}
						placeholder={t("imageWatermarkPlaceholder")}
					/>
					<div className="saveimg-copy-row">
						<span className="saveimg-count">{t("exportSelectedCount", { n: exp.selectedIds.length })}</span>
						<button
							type="button"
							className="btn primary saveimg-copy"
							onClick={() => void copy()}
							disabled={busy || previewBusy || exp.selectedIds.length === 0}
							title={t("copyImageBtn")}
						>
							{busy || previewBusy ? <FiLoader className="saveimg-spin" /> : copied ? <FiCheckCircle /> : <FiCopy />}
							<span>{busy || previewBusy ? t("savingImage") : copied ? t("copied") : t("copyImageBtn")}</span>
						</button>
					</div>
				</div>
				{error ? <div className="saveimg-error">{error}</div> : null}
			</div>
		</aside>
	);
}
