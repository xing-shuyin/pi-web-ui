import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { appResourceCrossOrigin } from "../base-url";
import { createPortal } from "react-dom";
import {
	FiCheck,
	FiCopy,
	FiDownload,
	FiEdit3,
	FiFileText,
	FiPaperclip,
	FiRotateCcw,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import { isZhLocale, useLocale, useT } from "../i18n";
import { listImageOcrProviders, subscribeImageOcrProviders } from "../image-ocr-providers";
import { useCopyFeedback } from "../use-copy-feedback";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";
import type { ImageLightboxTarget } from "../image-lightbox-bridge";
import { getImageOcrInstallState, subscribeImageOcrInstall, installImageOcr } from "../image-ocr-install";
import { composeToComposer } from "../composer-bridge";
import { fileToProcessedImage } from "../image-paste";
import {
	copyPreviewImage,
	downloadPreviewImage,
	imagePreviewFilename,
	loadPreviewImage,
} from "../image-preview-actions";

export interface ImageLightboxProps extends ImageLightboxTarget {
	onClose: () => void;
	composerSessionId?: string;
}

export function ImageLightbox({ src, alt, onClose, onSaveAnnotation, actions, composerSessionId }: ImageLightboxProps) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const sessionId = composerSessionId;
	const session = useRef(sessionId);
	session.current = sessionId;
	const [edited, setEdited] = useState<{ original: string; src: string } | null>(null);
	const previewSrc = edited?.original === src ? edited.src : src;
	const previewName = previewSrc === src ? alt : imagePreviewFilename(alt, "image/png");
	const [actionBusy, setActionBusy] = useState<"attach" | "copy" | "download" | null>(null);
	const [actionError, setActionError] = useState("");
	const [notice, setNotice] = useState("");
	const [attachedTo, setAttachedTo] = useState<{ sessionId: string; src: string } | null>(null);
	const attached = !!onSaveAnnotation || (attachedTo?.sessionId === sessionId && attachedTo?.src === previewSrc);
	const actionRequest = useRef<AbortController | null>(null);
	const image = useRef<HTMLImageElement>(null);
	const [loadedImage, setLoadedImage] = useState<{ src: string; width: number; height: number } | null>(null);
	const size = loadedImage?.src === previewSrc ? loadedImage : { width: 0, height: 0 };
	const [zoom, setZoom] = useState<number | null>(null);
	const providers = useSyncExternalStore(subscribeImageOcrProviders, listImageOcrProviders);
	const installation = useSyncExternalStore(subscribeImageOcrInstall, getImageOcrInstallState);
	const [providerId, setProviderId] = useState("");
	const provider = providers.find((item) => item.id === providerId) ?? providers[0];
	const installBusy = !provider && installation.busy;
	const installError = !provider && installation.error;
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const imageFailed = failedSrc === previewSrc;
	const [annotating, setAnnotating] = useState(false);
	const request = useRef<AbortController | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const target = useRef({ src: previewSrc, onSaveAnnotation });
	target.current = { src: previewSrc, onSaveAnnotation };
	const editing = useRef(annotating);
	editing.current = annotating;
	const { copied, copy, reset: resetCopy } = useCopyFeedback();

	useEffect(() => {
		request.current?.abort();
		request.current = null;
		setBusy(false);
		setProgress(0);
		setText(null);
		setError("");
		resetCopy();
		return () => {
			request.current?.abort();
			request.current = null;
		};
	}, [previewSrc, provider, resetCopy]);

	useEffect(() => setEdited(null), [src]);

	useEffect(() => {
		actionRequest.current?.abort();
		actionRequest.current = null;
		setActionBusy(null);
		setActionError("");
		setNotice("");
		setAnnotating(false);
		setZoom(null);
		return () => {
			actionRequest.current?.abort();
			actionRequest.current = null;
		};
	}, [previewSrc]);

	useEffect(() => {
		const previousFocus = document.activeElement;
		closeButton.current?.focus();
		const onKeyDown = (e: KeyboardEvent) => {
			if (document.querySelector(".approval-modal, .perm-modal-backdrop")) return;
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				if (editing.current) {
					e.preventDefault();
					setAnnotating(false);
					return;
				}
				e.preventDefault();
				close.current();
			} else if (e.key === "Tab") {
				const items = root.current?.querySelectorAll<HTMLElement>(
					"button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled)",
				);
				if (!items?.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (e.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) {
					e.preventDefault();
					last.focus();
				} else if (
					!e.shiftKey &&
					(document.activeElement === last || !root.current?.contains(document.activeElement))
				) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
		};
	}, []);

	const recognize = async () => {
		if (!provider || request.current || imageFailed) return;
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		setError("");
		setText(null);
		setProgress(0);
		resetCopy();
		try {
			const result = await provider.recognize({
				src: previewSrc,
				signal: controller.signal,
				onProgress: (value) => {
					if (request.current === controller && Number.isFinite(value)) setProgress(Math.max(0, Math.min(1, value)));
				},
			});
			if (request.current === controller && !controller.signal.aborted) setText(String(result.text ?? "").trim());
		} catch (err) {
			if (request.current === controller && !controller.signal.aborted) {
				setError(err instanceof Error ? err.message : t("imageOcrFailed"));
			}
		} finally {
			if (request.current === controller) {
				request.current = null;
				setBusy(false);
			}
		}
	};

	const runAction = async (action: "attach" | "copy" | "download") => {
		if (actionRequest.current || imageFailed || annotating) return;
		const controller = new AbortController();
		actionRequest.current = controller;
		setActionBusy(action);
		setActionError("");
		setNotice("");
		try {
			if (action === "copy") {
				await copyPreviewImage(previewSrc, controller.signal);
			} else if (action === "download") {
				if (!(await downloadPreviewImage(previewSrc, previewName, controller.signal))) return;
			} else {
				if (!sessionId) throw new Error(t("imageAttachFailed"));
				const file = await loadPreviewImage(previewSrc, previewName, controller.signal);
				const attachment = await fileToProcessedImage(file);
				controller.signal.throwIfAborted();
				if (!attachment || attachment.size > 2 * 1024 * 1024 || session.current !== sessionId)
					throw new Error(t("imageAttachFailed"));
				const accepted = composeToComposer({
					attachments: [
						{
							path: "",
							name: imagePreviewFilename(attachment.name, attachment.mimeType),
							imageData: attachment.data,
							mimeType: attachment.mimeType,
							size: attachment.size,
							key: crypto.randomUUID(),
						},
					],
				});
				if (!accepted) throw new Error(t("imageAttachFailed"));
				if (actionRequest.current === controller) setAttachedTo({ sessionId, src: previewSrc });
			}
			if (actionRequest.current === controller) {
				setNotice(t(action === "attach" ? "imageAttached" : action === "copy" ? "imageCopied" : "imageDownloaded"));
			}
		} catch (err) {
			if (actionRequest.current === controller && !controller.signal.aborted) {
				const message = err instanceof Error ? err.message : String(err);
				const failure = t(action === "attach" ? "imageAttachFailed" : "copyFailed");
				setActionError(
					err instanceof Error && err.name === "NotSupportedError"
						? t("imageCopyUnavailable")
						: action === "download"
							? t("downloadFailed", { error: message })
							: message === failure
								? failure
								: `${failure}: ${message}`,
				);
			}
		} finally {
			if (actionRequest.current === controller) {
				actionRequest.current = null;
				setActionBusy(null);
			}
		}
	};

	const changeZoom = (factor: number) => {
		const current =
			zoom ??
			Math.min(
				(image.current?.clientWidth || size.width) / size.width,
				(image.current?.clientHeight || size.height) / size.height,
			);
		setZoom(Math.max(0.1, Math.min(4, current * factor)));
	};
	const actionsDisabled = !!actionBusy || annotating || imageFailed;

	return createPortal(
		<div
			ref={root}
			className="img-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={alt || t("toolImageZoom")}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="img-lightbox-toolbar">
				<span className="img-lightbox-name" title={previewName}>
					{previewName}
				</span>
				<button
					type="button"
					className="btn"
					disabled={actionsDisabled || !sessionId || attached}
					onClick={() => void runAction("attach")}
				>
					{attached ? <FiCheck /> : <FiPaperclip />}
					{t(attached ? "imageAttached" : "imageAttach")}
				</button>
				<button type="button" className="btn" disabled={actionsDisabled} onClick={() => void runAction("copy")}>
					<FiCopy />
					{t("imageCopy")}
				</button>
				<button type="button" className="btn" disabled={actionsDisabled} onClick={() => void runAction("download")}>
					<FiDownload />
					{t("downloadFile")}
				</button>
				{actions
					?.filter((action) => action.id !== "download")
					.map((action) => (
						<button
							key={action.id}
							type="button"
							className="btn"
							disabled={!!actionBusy || annotating}
							onClick={() => {
								try {
									const result = action.onSelect();
									if (action.closeOnSelect) onClose();
									void Promise.resolve(result).catch((err) => {
										if (root.current) setError(err instanceof Error ? err.message : String(err));
									});
								} catch (err) {
									setError(err instanceof Error ? err.message : String(err));
								}
							}}
						>
							{action.label}
						</button>
					))}
				{providers.length > 1 && (
					<select
						aria-label={t("imageOcrProvider")}
						value={provider?.id ?? ""}
						disabled={busy}
						onChange={(e) => setProviderId(e.target.value)}
					>
						{providers.map((item) => (
							<option key={item.id} value={item.id}>
								{isZh ? item.label : item.labelEn || item.label}
							</option>
						))}
					</select>
				)}
				<button type="button" className="btn" disabled={busy || actionsDisabled} onClick={() => setAnnotating(true)}>
					<FiEdit3 />
					{t("imageAnnotate")}
				</button>
				{previewSrc !== src && (
					<button type="button" className="btn" disabled={busy || actionsDisabled} onClick={() => setEdited(null)}>
						<FiRotateCcw />
						{t("imageRestoreOriginal")}
					</button>
				)}
				<button
					type="button"
					className="btn"
					disabled={busy || installBusy || actionsDisabled}
					title={provider ? t("imageOcr") : t("imageOcrInstall")}
					onClick={() => (provider ? void recognize() : installImageOcr())}
				>
					<FiFileText />
					{t(installBusy ? "imageOcrInstalling" : "imageOcr")}
				</button>
				<button
					ref={closeButton}
					type="button"
					className="img-lightbox-close"
					title={t("close")}
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
			</div>
			{(actionBusy || notice || actionError) && (
				<div
					className={`img-lightbox-notice${actionError ? " img-lightbox-notice-error" : ""}`}
					role={actionError ? "alert" : "status"}
				>
					{actionError || (actionBusy ? t("running") : notice)}
				</div>
			)}
			{annotating ? (
				<ImageAnnotationEditor
					key={previewSrc}
					src={previewSrc}
					saveLabel={t(onSaveAnnotation ? "imageAnnotateSave" : "imageAnnotApply")}
					onCancel={() => setAnnotating(false)}
					onSave={async (dataUrl) => {
						if (onSaveAnnotation) await onSaveAnnotation(dataUrl);
						if (
							root.current?.isConnected &&
							target.current.src === previewSrc &&
							target.current.onSaveAnnotation === onSaveAnnotation
						) {
							if (onSaveAnnotation) onClose();
							else {
								setEdited({ original: src, src: dataUrl });
								setAnnotating(false);
							}
						}
					}}
				/>
			) : (
				<div className="img-lightbox-content">
					<div className="img-lightbox-viewer">
						<div className="img-lightbox-view-controls">
							{size.width > 0 && (
								<span>
									{size.width} × {size.height}
								</span>
							)}
							<button
								type="button"
								className="btn"
								aria-label={t("imageZoomOut")}
								title={t("imageZoomOut")}
								disabled={!size.width || (zoom !== null && zoom <= 0.1)}
								onClick={() => changeZoom(1 / 1.25)}
							>
								<FiZoomOut />
							</button>
							<button
								type="button"
								className="btn"
								onClick={() => setZoom(1)}
								disabled={!size.width}
								title={t("imageActualSize")}
							>
								{zoom === null ? "100%" : `${Math.round(zoom * 100)}%`}
							</button>
							<button
								type="button"
								className="btn"
								aria-label={t("imageZoomIn")}
								title={t("imageZoomIn")}
								disabled={!size.width || (zoom !== null && zoom >= 4)}
								onClick={() => changeZoom(1.25)}
							>
								<FiZoomIn />
							</button>
							<button type="button" className="btn" disabled={zoom === null} onClick={() => setZoom(null)}>
								{t("imageFit")}
							</button>
						</div>
						<div className={`img-lightbox-image${zoom !== null ? " img-lightbox-image-zoomed" : ""}`}>
							<img
								crossOrigin={appResourceCrossOrigin(previewSrc)}
								key={previewSrc}
								ref={image}
								src={previewSrc}
								alt={alt ?? "image preview"}
								style={
									zoom === null || !size.width ? undefined : { width: size.width * zoom, height: size.height * zoom }
								}
								onLoad={(e) => {
									setLoadedImage({
										src: previewSrc,
										width: e.currentTarget.naturalWidth,
										height: e.currentTarget.naturalHeight,
									});
									setFailedSrc(null);
								}}
								onError={() => setFailedSrc(previewSrc)}
							/>
							{imageFailed && <p role="alert">{t("imagePreviewFailed")}</p>}
						</div>
					</div>
					{(busy || text !== null || error || installBusy || installError) && (
						<section className="img-lightbox-ocr" aria-label={t("imageOcrResult")}>
							<div className="img-lightbox-ocr-head">
								<strong>{t("imageOcrResult")}</strong>
								{busy ? (
									<button
										type="button"
										className="btn"
										onClick={() => {
											request.current?.abort();
											request.current = null;
											setBusy(false);
										}}
									>
										{t("cancel")}
									</button>
								) : text ? (
									<button
										type="button"
										className="btn"
										onClick={async () => {
											if (!(await copy(text))) setError(t("copyFailed"));
										}}
									>
										{copied ? <FiCheck /> : <FiCopy />}
										{t(copied ? "copied" : "copyText")}
									</button>
								) : null}
							</div>
							{busy && (
								<div role="status">
									<p>
										{t("imageOcrWorking")} {Math.round(progress * 100)}%
									</p>
									<progress max={1} value={progress} />
									<p className="img-lightbox-hint">{t("imageOcrDownload")}</p>
								</div>
							)}
							{installBusy && <p role="status">{t("imageOcrInstalling")}</p>}
							{installError && <p role="alert">{installError}</p>}
							{error && <p role="alert">{error}</p>}
							{text !== null &&
								(text ? (
									<textarea aria-label={t("imageOcrResult")} value={text} readOnly spellCheck={false} />
								) : (
									<p role="status">{t("imageOcrEmpty")}</p>
								))}
						</section>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}
