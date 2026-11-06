import { build } from "esbuild";

await build({
	entryPoints: ["src/client.js"],
	bundle: true,
	format: "esm",
	outfile: "client/entry.mjs",
	target: "es2022",
	charset: "utf8",
	minify: false,
	banner: { js: "/* db-client 客户端 bundle —— 由 npm run build 生成，源码在 src/client.js */" },
});
console.log("built → client/entry.mjs");
