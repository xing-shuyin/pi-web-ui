import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.env.OPENCC_DIR || join(tmpdir(), "zhtw-deps"));
export const OpenCC = createRequire(join(dir, "package.json"))("opencc-js");
