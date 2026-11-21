/**
 * 协议版本（前端视图）。
 *
 * 版本号只有一份：`server/protocol-version.ts`。前端与桌面壳都从这里取，
 * 改版本号只改服务端一处，避免两侧手写同一个数字后悄悄错位（守卫：
 * `tests/unit/protocol-version-single-source.test.ts`）。
 */
export { PROTOCOL_VERSION } from "../../server/protocol-version.js";
