import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	build: {
		outDir: "../client/app",
		emptyOutDir: true,
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
	},
	preview: {
		port: 4173,
	},
});
