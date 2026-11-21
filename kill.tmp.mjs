import { spawnSync } from "node:child_process";
const r = spawnSync("taskkill", ["/PID", "12268", "/T", "/F"], { encoding: "utf8" });
console.log("status", r.status, "signal", r.signal, "error", r.error?.message ?? "");
console.log("out:", (r.stdout || "").trim().slice(0, 200));
console.log("err:", (r.stderr || "").trim().slice(0, 200));
