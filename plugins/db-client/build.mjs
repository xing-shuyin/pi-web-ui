import { build } from "esbuild";

await build({
	entryPoints: ["src/client.js"],
	bundle: true,
	format: "esm",
	outfile: "client/entry.mjs",
	target: "es2022",
	charset: "utf8",
	minify: false,
	// 插件词典与宿主 SDK 都在运行时按原路径加载（SDK 由页面 import map 解析，词典由 /plugins/<id>/client/ 提供），
	// 不内联进 bundle：保留单一副本，改文案不需要重新构建。
	external: ["@pi-web-ui/plugin-sdk/client", "../client/i18n.mjs"],
	banner: { js: "/* db-client 客户端 bundle —— 由 npm run build 生成，源码在 src/client.js */" },
});
console.log("built → client/entry.mjs");
