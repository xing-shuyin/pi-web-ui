import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CLAIM_TTL_MS,
	ClaimStore,
	matchClaims,
	mergeTouchSidecar,
	readTouchSidecar,
	removeTouchSidecar,
	resolveClaimPath,
} from "../../server/claim-store.js";

const CWD = resolve("/repo/proj");
const OWNER_A = { convId: "cA", title: "对话A" };
const OWNER_B = { convId: "cB", title: "对话B" };

function memStore(): ClaimStore {
	const dir = mkdtempSync(join(tmpdir(), "claim-test-"));
	return new ClaimStore(join(dir, "claims.json"));
}

describe("claim 先到先得", () => {
	it("认领成功；别人的冲突不抢占；自己的刷新", () => {
		const s = memStore();
		const r1 = s.claim(CWD, OWNER_A, [{ path: "a.ts", note: "改登录" }], 1000);
		expect(r1.claimed).toHaveLength(1);
		expect(r1.conflicts).toHaveLength(0);
		expect(r1.claimed[0].path).toBe(resolve("/repo/proj/a.ts"));
		const r2 = s.claim(CWD, OWNER_B, [{ path: "a.ts" }], 2000);
		expect(r2.claimed).toHaveLength(0);
		expect(r2.conflicts).toHaveLength(1);
		expect(r2.conflicts[0].claim.ownerTitle).toBe("对话A");
		expect(s.list(CWD, 2000)).toHaveLength(1);
		const r3 = s.claim(CWD, OWNER_A, [{ path: "a.ts", note: "改登录v2" }], 3000);
		expect(r3.conflicts).toHaveLength(0);
		expect(s.list(CWD, 3000)[0].note).toBe("改登录v2");
	});
	it("相对路径按 cwd resolve；逃逸拒绝", () => {
		expect(resolveClaimPath("sub/x.ts", CWD)).toBe(resolve("/repo/proj/sub/x.ts"));
		expect(resolveClaimPath("../outside.ts", CWD)).toBeUndefined();
		expect(resolveClaimPath("/abs/elsewhere.ts", CWD)).toBeUndefined();
		expect(resolveClaimPath("", CWD)).toBeUndefined();
	});
});

describe("release / touch / TTL", () => {
	it("只放自己的；不给 paths 全放；releaseByOwner 跨表清", () => {
		const s = memStore();
		s.claim(CWD, OWNER_A, [{ path: "a.ts" }, { path: "b.ts" }], 1000);
		s.claim(CWD, OWNER_B, [{ path: "c.ts" }], 1000);
		expect(s.release(CWD, OWNER_A.convId, ["a.ts", "c.ts"], 2000)).toBe(1);
		expect(
			s
				.list(CWD, 2000)
				.map((c) => c.path)
				.sort(),
		).toEqual([resolve("/repo/proj/b.ts"), resolve("/repo/proj/c.ts")].sort());
		expect(s.release(CWD, OWNER_A.convId, [], 2000)).toBe(1);
		expect(s.releaseByOwner(OWNER_B.convId, 2000)).toBe(1);
		expect(s.list(CWD, 2000)).toEqual([]);
	});
	it("过期自动扫掉；touch 心跳续期", () => {
		const s = memStore();
		s.claim(CWD, OWNER_A, [{ path: "a.ts" }], 1000);
		expect(s.list(CWD, 1000 + CLAIM_TTL_MS + 1)).toEqual([]);
		s.claim(CWD, OWNER_A, [{ path: "b.ts" }], 1000);
		expect(s.touch(OWNER_A.convId, 1000 + CLAIM_TTL_MS - 1000)).toBe(1);
		expect(s.list(CWD, 1000 + CLAIM_TTL_MS + 1).map((c) => c.path)).toEqual([resolve("/repo/proj/b.ts")]);
	});
});

describe("持久化", () => {
	it("落盘重载 roundtrip；坏文件丢弃不抛错", () => {
		const dir = mkdtempSync(join(tmpdir(), "claim-persist-"));
		try {
			const file = join(dir, "claims.json");
			const s1 = new ClaimStore(file);
			s1.claim(CWD, OWNER_A, [{ path: "a.ts", note: "n" }], 1000);
			const s2 = new ClaimStore(file);
			const rows = s2.list(CWD, 2000);
			expect(rows).toHaveLength(1);
			expect(rows[0].ownerTitle).toBe("对话A");
			writeFileSync(file, "not json {{{");
			expect(new ClaimStore(file).list(CWD, 2000)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("matchClaims", () => {
	it("相对触碰 vs 绝对认领能对上；无关的不对上；脏输入不抛错", () => {
		const touches = [
			{ path: "a.ts", count: 2, lastTs: 5 },
			{ path: "/repo/proj/sub/b.ts", count: 1, lastTs: 6 },
			{ path: "other.ts", count: 1, lastTs: 7 },
		];
		const claims = [
			{ path: resolve("/repo/proj/a.ts"), ownerConvId: "cB", ownerTitle: "B", claimedAt: 1, expiresAt: 99 },
			{ path: resolve("/repo/proj/sub/b.ts"), ownerConvId: "cB", ownerTitle: "B", claimedAt: 1, expiresAt: 99 },
		];
		const hits = matchClaims(touches, claims, CWD);
		expect(hits.map((h) => h.touch.path).sort()).toEqual(["/repo/proj/sub/b.ts", "a.ts"]);
		expect(hits[0].claim.ownerTitle).toBe("B");
		expect(matchClaims([], claims, CWD)).toEqual([]);
		expect(matchClaims(null as never, null as never, CWD)).toEqual([]);
	});
});

describe("sidecar", () => {
	it("merge 累加（union 取大）；read 校验形状；坏文件/删文件不抛错", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sidecar-"));
		try {
			const session = join(dir, "s.jsonl");
			writeFileSync(session, "{}\n");
			await mergeTouchSidecar(session, [{ path: "a.ts", count: 2, lastTs: 10 }]);
			await mergeTouchSidecar(session, [
				{ path: "a.ts", count: 5, lastTs: 5 },
				{ path: "b.ts", count: 1, lastTs: 20 },
			]);
			const back = readTouchSidecar(session);
			expect(back?.find((f) => f.path === "a.ts")).toEqual({ path: "a.ts", count: 5, lastTs: 10 });
			expect(back?.find((f) => f.path === "b.ts")?.count).toBe(1);
			await mergeTouchSidecar(session, []);
			await mergeTouchSidecar(undefined, [{ path: "x", count: 1, lastTs: 1 }]);
			expect(readTouchSidecar(undefined)).toBeUndefined();
			expect(readTouchSidecar(join(dir, "nope.jsonl"))).toBeUndefined();
			writeFileSync(`${session}.touches.json`, "garbage{{{");
			expect(readTouchSidecar(session)).toBeUndefined();
			removeTouchSidecar(session);
			removeTouchSidecar(undefined);
			expect(readTouchSidecar(session)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
