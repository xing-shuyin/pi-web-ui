import type { default as rehypeKatex } from "rehype-katex";

type MathRenderer = typeof rehypeKatex;
let renderer: MathRenderer | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();

export const mathRendererImport = {
	load: () => import("./markdown-math-renderer"),
};

export function getMathRenderer() {
	return renderer;
}

export function subscribeMathRenderer(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function loadMathRenderer(): Promise<void> {
	if (renderer) return Promise.resolve();
	if (!pending) {
		pending = mathRendererImport.load().then(
			(module) => {
				renderer = module.default;
				pending = undefined;
				for (const listener of listeners) listener();
			},
			() => {
				pending = undefined;
			},
		);
	}
	return pending;
}
