/**
 * Frontend copy of server/protocol-version.ts (protocol.ts itself must stay
 * pure types, so the constant lives here). scripts/check-protocol-sync.mjs
 * verifies both copies carry the same number — bump them together.
 */
export const PROTOCOL_VERSION = 11;
