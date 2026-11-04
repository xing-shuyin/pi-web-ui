import React, { useEffect } from "react";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";

export interface ImageLightboxProps {
	src: string;
	alt?: string;
	onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
	const t = useT();

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<div className="img-lightbox" role="dialog" aria-modal="true" aria-label={t("toolImageZoom")} onClick={onClose}>
			<button
				type="button"
				className="img-lightbox-close"
				title={t("close")}
				aria-label={t("close")}
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
			>
				<FiX />
			</button>
			<img src={src} alt={alt ?? "image preview"} />
		</div>
	);
}
