import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	root,
	base: "./",
	publicDir: resolve(root, "../web/public"),
	plugins: [react()],
	resolve: { dedupe: ["react", "react-dom"] },
	define: { __BUILD_ID__: JSON.stringify("mobile-0.1.0") },
	build: { target: "es2022", outDir: "dist", emptyOutDir: true },
	server: { fs: { allow: [resolve(root, "..")] } },
});
