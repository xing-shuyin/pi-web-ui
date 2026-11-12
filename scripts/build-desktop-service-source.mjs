import { readFile, writeFile } from "node:fs/promises";
const source = await readFile(new URL("../server/device-center/native-desktop/windows.ts", import.meta.url), "utf8");
const start = source.indexOf("using System;");
const end = source.indexOf("\n'@", start);
if (start < 0 || end < 0) throw new Error("Windows capture source boundary missing");
await writeFile(
	new URL("../bin/desktop-service/NativeDesktop.cs", import.meta.url),
	"// Generated from server/device-center/native-desktop/windows.ts; do not edit.\n" +
		source.slice(start, end).replaceAll("\r\n", "\n") +
		"\n",
);
