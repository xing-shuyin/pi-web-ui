// 驗證 zh-TW 輸出：key 完整與順序、佔位符、殘留簡體字、重複詞、禁用詞。
import { readFileSync } from "node:fs";
import { OpenCC } from "./opencc.mjs";
// 用法：node verify.mjs <tw.json> <zh.json>
const [twPath, zhPath] = process.argv.slice(2);
const zh = JSON.parse(readFileSync(zhPath, "utf8"));
const tw = JSON.parse(readFileSync(twPath, "utf8"));
const ph = (s) => [...s.matchAll(/\$\{pwd\}|\{\{[a-z]+\}\}|\{\$?[a-zA-Z]+\}|\[\[[a-z_/-]+/g)].map((m) => m[0]).sort();
let bad = 0;
const report = (msg) => {
	bad++;
	console.log("  ✗", msg);
};
const zk = Object.keys(zh),
	tk = Object.keys(tw);
if (JSON.stringify(zk) !== JSON.stringify(tk)) report("key 集合或順序與 zh 不一致");
for (const k of zk) {
	const v = tw[k];
	if (typeof v !== "string" || !v.length) {
		report(`${k}: 空值`);
		continue;
	}
	if (JSON.stringify(ph(v)) !== JSON.stringify(ph(zh[k])))
		report(`${k}: 佔位符不一致 ${JSON.stringify(ph(zh[k]))} → ${JSON.stringify(ph(v))}`);
}
// 殘留簡體：把輸出再從「簡」轉一次，凡會變動的字元即為殘留簡體字（排除 twp 會把繁體再改的詞）
const toTrad = OpenCC.Converter({ from: "cn", to: "tw" });
const residual = new Map();
for (const [k, v] of Object.entries(tw)) {
	const t = toTrad(v);
	if (t !== v) {
		const a = [...v],
			b = [...t];
		for (let i = 0; i < Math.min(a.length, b.length); i++)
			if (a[i] !== b[i]) {
				const key = a[i] + "→" + b[i];
				(residual.get(key) ?? residual.set(key, []).get(key)).push(k);
			}
	}
}
for (const [pair, keys] of residual)
	console.log(`  ? 可能殘留簡體 ${pair}  (${keys.length}) 例: ${keys.slice(0, 3).join(", ")}`);
// 重複詞
for (const [k, v] of Object.entries(tw)) {
	const m = v.match(
		/(設定設定|預設預設|平行平行|行程行程|範本範本|專案專案|核准核准|儲存庫庫|終端機機|工作階段工作階段|取得取得)/,
	);
	if (m) report(`${k}: 重複詞 ${m[0]}`);
}
// 禁用／可疑詞
const banned = [
	"幹",
	"當前",
	"會話",
	"沙箱",
	"模板",
	"後臺",
	"計劃",
	"只讀",
	"訪問",
	"文本",
	"窗口",
	"進程",
	"打開",
	"響應",
	"發送",
	"鼠標",
	"軟件",
	"網絡",
	"服務器",
	"默認",
	"設置",
	"信息",
];
for (const w of banned) {
	const ks = Object.entries(tw)
		.filter(([, v]) => v.includes(w))
		.map(([k]) => k);
	if (ks.length) report(`含 "${w}" ×${ks.length}: ${ks.slice(0, 4).join(", ")}`);
}
console.log(bad ? `\n共 ${bad} 項問題` : "\n通過基本驗證（key／佔位符／重複詞／禁用詞）");
