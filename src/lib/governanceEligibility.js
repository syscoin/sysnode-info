// Display/reminder policy, not a change to Core's accepted governance data.
// Epochs are UNIX seconds. Never silently reinterpret on-chain milliseconds.
// Restrict dates to four-digit UTC years so malformed far-future proposals do
// not become actionable rows or create an implausible "active" count.
export const MAX_GOVERNANCE_EPOCH_SECONDS = 253402300799;

export function isSupportedGovernanceProposal(proposal, nowMs = Date.now()) {
  if (
    !proposal ||
    proposal.ObectType !== 1 ||
    proposal.fCachedValid !== true ||
    proposal.fBlockchainValidity !== true ||
    proposal.fCachedDelete !== false
  ) return false;
  const start = proposal.start_epoch;
  const end = proposal.end_epoch;
  return Number.isFinite(nowMs) &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= MAX_GOVERNANCE_EPOCH_SECONDS &&
    end > start &&
    end <= MAX_GOVERNANCE_EPOCH_SECONDS &&
    end > Math.floor(nowMs / 1000);
}
