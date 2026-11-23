// P0 桥接：物理搬移在 P1 完成（见 packages/keel/README.md）。此文件是唯一允许指向 app 老路径的桥。
export { CoreEngine, CoreEngineNotReadyError } from "../../../server/core/app/core-engine.js";
export { resolvePiEngineMode, resolvePiEngineAttach, PI_ENGINE_ENV } from "../../../server/core/app/engine-mode.js";
export type { ClientFrames } from "../../../server/core/app/client-runtime.js";
