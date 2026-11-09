import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { appResourceCrossOrigin } from "../base-url";
import { createPortal } from "react-dom";
import {
	FiCheck,
	FiCopy,
	FiDownload,
	FiEdit3,
	FiFileText,
	FiMaximize,
	FiMaximize2,
	FiMinimize,
	FiMinimize2,
	FiPaperclip,
	FiRotateCcw,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import { isZhLocale, useLocale, useT } from "../i18n";
import { listImageOcrProviders, subscribeImageOcrProviders } from "../image-ocr-providers";
import { useCopyFeedback } from "../use-copy-feedback";
import { useOverlayZIndex } from "../overlay-stack";
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

/** 图标按钮：文案只走悬浮提示（data-tip 立即出，无原生 title 的延迟），无障碍名默认与提示同源。 */
function LightboxButton({
	tip,
	label,
	disabled,
	onClick,
	className,
	buttonRef,
	children,
}: {
	tip: string;
	/** 无障碍名：需要跟提示分开时（如安装中的进度态）单独给 */
	label?: string;
	disabled?: boolean;
	onClick: () => void;
	className?: string;
	buttonRef?: React.Ref<HTMLButtonElement>;
	children: React.ReactNode;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			className={className ? `img-lightbox-btn ${className}` : "img-lightbox-btn"}
			data-tip={tip}
			aria-label={label ?? tip}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

export function ImageLightbox({ src, alt, onClose, onSaveAnnotation, actions, composerSessionId }: ImageLightboxProps) {
	const t = useT();
	const zIndex = useOverlayZIndex();
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
	// 默认不是全屏：先按图片原尺寸开一个浮卡，满屏由右上角按钮（或双击图片）切换
	const [fullscreen, setFullscreen] = useState(false);
	const expanded = useRef(false);
	expanded.current = fullscreen;
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
		setFullscreen(false);
		return () => {
			actionRequest.current?.abort();
			actionRequest.current = null;
		};
	}, [previewSrc]);

	useEffect(() => {
		const previousFocus = document.activeElement;
		// 焦点先落脚在关闭键上（键盘/读屏一进来就有出口），但不点亮 focus 环和提示
		closeButton.current?.focus({ focusVisible: false });
		const onKeyDown = (e: KeyboardEvent) => {
			if (document.querySelector(".approval-modal, .perm-modal-backdrop")) return;
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				if (editing.current) {
					e.preventDefault();
					setAnnotating(false);
					return;
				}
				if (expanded.current) {
					e.preventDefault();
					setFullscreen(false);
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
			} else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
				const target = e.target instanceof HTMLElement ? e.target : null;
				if (e.repeat || (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))))
					return;
				e.preventDefault();
				setFullscreen(!expanded.current);
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
			data-fullscreen={fullscreen ? "true" : undefined}
			// 预览窗可能从工具详情/文件预览里打开，层级一律由叠栈发放（后开的在上）
			style={{ zIndex }}
			role="dialog"
			aria-modal="true"
			aria-label={alt || t("toolImageZoom")}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			{/* 小巧浮卡：默认按图片原尺寸收着开；满屏交给右上角按钮 / 双击图片 / F 键 */}
			<div className="img-lightbox-panel">
				<div className="img-lightbox-toolbar">
					<span className="img-lightbox-name" title={previewName}>
						{previewName}
					</span>
					<div className="img-lightbox-actions">
						<LightboxButton
							tip={t(attached ? "imageAttached" : "imageAttach")}
							disabled={actionsDisabled || !sessionId || attached}
							onClick={() => void runAction("attach")}
						>
							{attached ? <FiCheck /> : <FiPaperclip />}
						</LightboxButton>
						<LightboxButton tip={t("imageCopy")} disabled={actionsDisabled} onClick={() => void runAction("copy")}>
							<FiCopy />
						</LightboxButton>
						<LightboxButton
							tip={t("downloadFile")}
							disabled={actionsDisabled}
							onClick={() => void runAction("download")}
						>
							<FiDownload />
						</LightboxButton>
						{actions
							?.filter((action) => action.id !== "download")
							.map((action) => (
								<button
									key={action.id}
									type="button"
									className="img-lightbox-btn img-lightbox-btn-text"
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
								className="img-lightbox-select"
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
						<LightboxButton
							tip={t("imageAnnotate")}
							disabled={busy || actionsDisabled}
							onClick={() => {
								// 标注要够大的画布：进标注顺手把浮卡铺满
								setFullscreen(true);
								setAnnotating(true);
							}}
						>
							<FiEdit3 />
						</LightboxButton>
						{previewSrc !== src && (
							<LightboxButton
								tip={t("imageRestoreOriginal")}
								disabled={busy || actionsDisabled}
								onClick={() => setEdited(null)}
							>
								<FiRotateCcw />
							</LightboxButton>
						)}
						<LightboxButton
							tip={provider ? t("imageOcr") : t("imageOcrInstall")}
							label={t(installBusy ? "imageOcrInstalling" : "imageOcr")}
							disabled={busy || installBusy || actionsDisabled}
							onClick={() => (provider ? void recognize() : installImageOcr())}
						>
							<FiFileText />
						</LightboxButton>
						<LightboxButton
							tip={t(fullscreen ? "exitFullscreen" : "fullscreen")}
							onClick={() => setFullscreen(!fullscreen)}
						>
							{fullscreen ? <FiMinimize2 /> : <FiMaximize2 />}
						</LightboxButton>
						<LightboxButton tip={t("close")} className="img-lightbox-close" buttonRef={closeButton} onClick={onClose}>
							<FiX />
						</LightboxButton>
					</div>
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
							<div
								className={`img-lightbox-image${zoom !== null ? " img-lightbox-image-zoomed" : ""}`}
								data-pending={size.width > 0 || imageFailed ? undefined : "true"}
							>
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
									onDoubleClick={() => setFullscreen(!fullscreen)}
									onError={() => setFailedSrc(previewSrc)}
								/>
								{imageFailed && <p role="alert">{t("imagePreviewFailed")}</p>}
							</div>
							<div className="img-lightbox-view-controls">
								{size.width > 0 && (
									<span className="img-lightbox-dims">
										{size.width} × {size.height}
									</span>
								)}
								<LightboxButton
									tip={t("imageZoomOut")}
									disabled={!size.width || (zoom !== null && zoom <= 0.1)}
									onClick={() => changeZoom(1 / 1.25)}
								>
									<FiZoomOut />
								</LightboxButton>
								<LightboxButton tip={t("imageActualSize")} disabled={!size.width} onClick={() => setZoom(1)}>
									<FiMaximize />
								</LightboxButton>
								{zoom !== null && <span className="img-lightbox-zoom">{Math.round(zoom * 100)}%</span>}
								<LightboxButton
									tip={t("imageZoomIn")}
									disabled={!size.width || (zoom !== null && zoom >= 4)}
									onClick={() => changeZoom(1.25)}
								>
									<FiZoomIn />
								</LightboxButton>
								<LightboxButton tip={t("imageFit")} disabled={zoom === null} onClick={() => setZoom(null)}>
									<FiMinimize />
								</LightboxButton>
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
			</div>
		</div>,
		document.body,
	);
}
