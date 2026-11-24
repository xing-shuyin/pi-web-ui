import type { SessionFile } from "./ids.js";

/**
 * 派生会话（`forkSession`）时跟着转录一起走的外部产物。
 *
 * 转录本体由内核派生（SDK `SessionManager.createBranchedSession`，见 `adapters/sdk/session-opener`），
 * 但转录旁边那份 `<sessionFile>.evidence/` 只有宿主知道布局与预算（宿主 `context-evidence` 是唯一写入者）。
 * 所以这里只留一个窄面：内核把「源 / 新」两份路径交出去，搬运规则不在这里复写。
 */
export interface ForkEvidencePort {
	/** 把源转录的外置证据搬到新转录（老实现 `copyContextEvidence`）；抛错即视作本次派生失败。 */
	copy(source: SessionFile, destination: SessionFile): Promise<void>;
	/** 派生失败清理：删掉半成品转录对应的证据目录（老实现 `removeContextEvidence`）。 */
	remove?(sessionFile: SessionFile): Promise<void> | void;
}
