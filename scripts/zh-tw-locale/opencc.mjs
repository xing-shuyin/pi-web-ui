// 載入 opencc-js。它不在專案依賴裡：裝在 OPENCC_DIR（預設 <系統暫存目錄>/zhtw-deps），見 README。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.env.OPENCC_DIR || join(tmpdir(), "zhtw-deps"));
export const OpenCC = createRequire(join(dir, "package.json"))("opencc-js");
