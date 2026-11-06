import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { retainBuildAssets } from "./build-assets";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const buildId = process.env.PI_WEB_BUILD_ID ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);

function swBuildIdPlugin(id: string) {
	return {
		name: "sw-build-id",
		transformIndexHtml() {
			return [{ tag: "meta", attrs: { name: "pi-web-build-id", content: id }, injectTo: "head" as const }];
		},
		closeBundle() {
			const swPath = join(__dirname, "dist", "sw.js");
			if (existsSync(swPath)) {
				const content = readFileSync(swPath, "utf-8");
				writeFileSync(swPath, content.replace(/__BUILD_ID__/g, id), "utf-8");
			}
		},
	};
}

export default defineConfig({
	root: __dirname,
	base: "./",
	plugins: [react(), swBuildIdPlugin(buildId), retainBuildAssets(join(__dirname, "dist"))],
	define: {
		__BUILD_ID__: JSON.stringify(buildId),
	},
	build: {
		outDir: join(__dirname, "dist"),
		emptyOutDir: false,
		target: "es2022",
		rollupOptions: {
			output: {
				advancedChunks: {
					groups: [
						{ name: "react", test: /node_modules[\\/](react|react-dom)[\\/]/ },
						{
							name: "markdown",
							test: /node_modules[\\/](react-markdown|remark-gfm|remark-math|remark-breaks|rehype-highlight|rehype-raw|highlight\.js)[\\/]/,
						},
						{
							name: "math",
							test: /(?:node_modules[\\/](rehype-katex|katex)[\\/]|[\\/]markdown-math-renderer\.ts$)/,
						},
						{ name: "xterm", test: /node_modules[\\/]@xterm[\\/](xterm|addon-fit)[\\/]/ },
					],
				},
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:8788",
			"/themes": "http://localhost:8788",
			"/plugins": "http://localhost:8788",
			"/plugins-api": "http://localhost:8788",
			"/plugins-shared": "http://localhost:8788",
			"/ws": {
				target: "ws://localhost:8788",
				ws: true,
				configure(proxy) {
					proxy.on("error", (_err, _req, socket) => {
						(socket as { destroy?: () => void } | undefined)?.destroy?.();
					});
					proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
						socket.on("error", () => {});
					});
				},
			},
		},
	},
});
