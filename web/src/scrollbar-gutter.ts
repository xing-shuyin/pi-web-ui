export function installScrollbarGutterVar(): void {
	if (typeof document === "undefined") return;
	setGutter(probeGutter());
	watchRealMessages();
}

function setGutter(px: number): void {
	if (!Number.isFinite(px) || px < 0) return;
	document.documentElement.style.setProperty("--msgs-gutter", `${Math.round(px * 100) / 100}px`);
}

function probeGutter(): number {
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:fixed;top:-9999px;left:0;width:100px;height:100px;overflow-y:auto;scrollbar-gutter:stable both-edges;visibility:hidden;pointer-events:none;";
	document.body.appendChild(probe);
	const gutter = (probe.offsetWidth - probe.clientWidth) / 2;
	probe.remove();
	return gutter;
}

function realGutter(el: HTMLElement): number {
	const marker = document.createElement("div");
	marker.style.cssText = "width:0;height:0;pointer-events:none;";
	el.appendChild(marker);
	const cs = getComputedStyle(el);
	const elBox = el.getBoundingClientRect();
	const markerBox = marker.getBoundingClientRect();
	const border = Number.parseFloat(cs.borderLeftWidth) || 0;
	const padding = Number.parseFloat(cs.paddingLeft) || 0;
	const gutter = markerBox.left - (elBox.left + border + padding);
	marker.remove();
	return gutter;
}

function watchRealMessages(): void {
	const refresh = (): boolean => {
		const el = document.querySelector<HTMLElement>(".messages");
		if (!el) return false;
		setGutter(realGutter(el));
		return true;
	};
	let raf = 0;
	window.addEventListener("resize", () => {
		if (raf) return;
		raf = window.requestAnimationFrame(() => {
			raf = 0;
			refresh();
		});
	});
	if (refresh()) return;
	const observer = new MutationObserver(() => {
		if (refresh()) observer.disconnect();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	window.setTimeout(() => observer.disconnect(), 60_000);
}
