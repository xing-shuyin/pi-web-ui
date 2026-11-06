import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { applyHashlinePatch, HashlineSnapshotStore, computeFileHash } from "../../server/hashline-engine.js";

describe("Hashline Snapshot Isolation & Safe Write Order (#341)", () => {
	it("isolates snapshots across different project directories with identical relative paths", () => {
		const store = new HashlineSnapshotStore();

		const codeA = "console.log('Project A');";
		const codeB = "console.log('Project B');";

		const patchTextA = `[src/index.ts]
PUT 1.=1:
+console.log('Project A Modified');
`;

		const patchTextB = `[src/index.ts]
PUT 1.=1:
+console.log('Project B Modified');
`;

		const cwdA = "/workspace/projectA";
		const cwdB = "/workspace/projectB";

		const reportA = applyHashlinePatch(patchTextA, {
			cwd: cwdA,
			snapshotStore: store,
			readFile: () => codeA,
			writeFile: () => {},
		});

		const reportB = applyHashlinePatch(patchTextB, {
			cwd: cwdB,
			snapshotStore: store,
			readFile: () => codeB,
			writeFile: () => {},
		});

		expect(reportA.ok).toBe(true);
		expect(reportB.ok).toBe(true);

		const hashA = computeFileHash("console.log('Project A Modified');");
		const hashB = computeFileHash("console.log('Project B Modified');");

		const pathA = resolve(cwdA, "src/index.ts");
		const pathB = resolve(cwdB, "src/index.ts");

		expect(store.get(pathA, hashA)).toBeDefined();
		expect(store.get(pathB, hashB)).toBeDefined();
	});

	it("executes writes before deletes during move operations", () => {
		const store = new HashlineSnapshotStore();
		const originalCode = "hello world\n";
		const opsOrder: string[] = [];

		const patch = `[sample.txt]
MV new-sample.txt
`;

		const report = applyHashlinePatch(patch, {
			cwd: "/workspace/test",
			snapshotStore: store,
			readFile: (p) => (p === "sample.txt" ? originalCode : null),
			writeFile: (p) => {
				opsOrder.push(`write:${p}`);
			},
			deleteFile: (p) => {
				opsOrder.push(`delete:${p}`);
			},
		});

		expect(report.ok).toBe(true);
		expect(opsOrder).toEqual(["write:new-sample.txt", "delete:sample.txt"]);
	});
});
