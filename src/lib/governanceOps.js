// Pure helpers that roll the governance feed + per-proposal receipt
// summary + owned-MN count up into the ops-summary hero at the top
// of the authenticated Governance page.
//
// Why this file exists separately from governanceCohort.js:
//
//   * cohortChip gives a per-row *label* — it's UI vocabulary.
//   * This module gives page-wide *counts* — it's dashboard vocabulary.
//   * Both need to agree on "which proposals count as voted" so the
//     per-row chips and the hero don't contradict each other. Rather
//     than duplicate the classification across components, we export
//     `classifyProposal` here and reuse it from both call-sites over
//     time; today it's the single source of truth for the hero.
//
// Design notes:
//
//   * Voted + Pending both count as "voted" for hero purposes. A
//     pending receipt means the user did their part — the vote is
//     signed and relayed; Core just hasn't echoed it back in
//     `gobject_getcurrentvotes` yet. Telling the user "you still
//     need to vote" while we're waiting for chain confirmation
//     would be a lie.
//
//   * Changed + Needs-retry + Partial + Not-voted count as "needs
//     vote". All four states mean the user has work to do; we
//     aggregate them into a single denominator so the hero stays a
//     two-bucket read (done vs. to-do).
//
//   * Passing uses the same >10% threshold as the per-row status
//     chip. If the threshold changes it should change in one place;
//     for now we keep the 10 literal close to the consumer so the
//     hero stays independent.
//
//   * `nextUnvotedKey` walks the provided proposals in caller order.
//     The caller is expected to pass them in display order (i.e.
//     already sorted + filtered the same way the table renders).
//     That keeps the jump-link deterministic: click jumps to the
//     literal next row the user can see.

import { cohortChip } from './governanceCohort';

// Absolute-yes threshold (percent of enabled MNs) for "passing" —
// mirrors the per-row badge logic so the hero count agrees with
// what the table visualises.
const PASSING_SUPPORT_PERCENT = 10;

function supportPercent(proposal, enabledCount) {
  if (!Number.isFinite(enabledCount) || enabledCount <= 0) return 0;
  const absYes = Number(proposal && proposal.AbsoluteYesCount);
  if (!Number.isFinite(absYes)) return 0;
  return (absYes / enabledCount) * 100;
}

function hashKeyOf(proposal) {
  if (!proposal || typeof proposal.Key !== 'string') return '';
  return proposal.Key.toLowerCase();
}

// Decide which hero bucket a proposal falls into for this user.
// Returns one of: 'voted' | 'needs-vote' | 'not-applicable'.
//
// 'not-applicable' means we shouldn't count this proposal in the
// progress-bar denominator — e.g. the user owns zero MNs and
// therefore can't vote on anything, or the cohort classifier was
// unable to return a chip (returned null).
export function classifyProposal(proposal, summaryMap, ownedCount) {
  const key = hashKeyOf(proposal);
  const summaryRow = key && summaryMap ? summaryMap.get(key) || null : null;
  const chip = cohortChip(summaryRow, ownedCount);

  if (!chip) return 'not-applicable';
  if (chip.kind === 'voted' || chip.kind === 'pending') return 'voted';
  // not-voted / needs-retry / changed / partial all mean "user has
  // something to do here". We don't distinguish them at the hero
  // level; the per-row chip still tells the detailed story.
  return 'needs-vote';
}

// Assemble the hero-level counts from the feed + summary + owned.
//
// `enabledCount` drives the "passing" calculation; when it's
// missing (network-stats fetch failed or in-flight) we still
// compute everything except the passing/watch split, which become
// null. Callers can render "—" for those two chips rather than
// miscount a proposal as "not passing" just because we don't know
// the denominator yet.
//
// `proposals` is expected to be the already-filtered list the page
// renders — i.e. honour the current search/filter. Scope of the
// hero is "what you see below me", so passing the raw unfiltered
// feed would have the hero contradict the table.
export function computeOpsStats({
  proposals,
  summaryMap,
  ownedCount,
  enabledCount,
}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const total = list.length;
  let voted = 0;
  let needsVote = 0;
  let applicable = 0;
  let passing = null;
  let watching = null;
  let nextUnvotedKey = null;

  const enabledIsKnown = Number.isFinite(enabledCount) && enabledCount > 0;
  if (enabledIsKnown) {
    passing = 0;
    watching = 0;
  }

  for (const proposal of list) {
    if (enabledIsKnown) {
      if (supportPercent(proposal, enabledCount) > PASSING_SUPPORT_PERCENT) {
        passing += 1;
      } else {
        watching += 1;
      }
    }

    const bucket = classifyProposal(proposal, summaryMap, ownedCount);
    if (bucket === 'not-applicable') continue;
    applicable += 1;
    if (bucket === 'voted') {
      voted += 1;
    } else {
      needsVote += 1;
      if (!nextUnvotedKey && typeof proposal.Key === 'string') {
        nextUnvotedKey = proposal.Key;
      }
    }
  }

  // Progress percent is computed off "applicable" so a user with
  // zero owned MNs sees a hero that doesn't pretend to measure
  // their participation. Same reason we don't divide by `total`
  // unconditionally: cohort chips only appear for proposals the
  // user can act on, and the hero should match.
  let progressPercent = null;
  if (applicable > 0) {
    progressPercent = Math.round((voted / applicable) * 100);
  }

  return {
    total,
    applicable,
    voted,
    needsVote,
    passing,
    watching,
    progressPercent,
    nextUnvotedKey,
    ownedCount: Number.isInteger(ownedCount) ? ownedCount : null,
  };
}

export const __private__ = {
  PASSING_SUPPORT_PERCENT,
  supportPercent,
  hashKeyOf,
};
