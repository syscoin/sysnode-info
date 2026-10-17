import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getPali } from '../lib/paliProvider';
import { sentryService } from '../lib/sentryService';
import { governanceService } from '../lib/governanceService';
import { buildPaliVoteRequest, PALI_VOTE_LIMIT, paliVotingError, publicWatchedVotingNodes, requireWalletVotingCapability, validatePaliVoteResponse, validateVotingCapabilities, voteRelayResults } from '../lib/paliVoting';
import VotingDialog from './VotingDialog';
import { isUnknownVote, reconciledVoteStatus } from '../lib/voteSubmissionStatus';

const entryId = (entry) => `${entry.collateralHash}:${entry.collateralIndex}`;

export default function PaliVoteModal({ proposal, onClose, onBack, onReloadProposals, service = sentryService, votesService = governanceService }) {
  const { user, isAuthenticated } = useAuth();
  const [capabilities, setCapabilities] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [selected, setSelected] = useState({});
  const [outcome, setOutcome] = useState('yes');
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [batch, setBatch] = useState(null);
  const [results, setResults] = useState([]);
  const [verifiedName, setVerifiedName] = useState('');
  const [checkedStatus, setCheckedStatus] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const providerCleanup = useRef(() => {});
  const scope = JSON.stringify([user?.id, user?.email, isAuthenticated, proposal?.Key]);
  const owner = useRef(scope); owner.current = scope;
  const initialScope = useRef(scope);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const proposalHash = String(proposal?.Key || '').toLowerCase();
  const selectedIds = nodes.filter((node) => selected[node.proTxHash]).map((node) => node.proTxHash);
  const busy = ['loading', 'approving', 'submitting', 'checking'].includes(phase);

  const run = useCallback(() => {
    if (locked.current) return null;
    locked.current = true;
    const token = ++generation.current; const captured = scopeRef.current;
    return () => alive.current && token === generation.current && owner.current === captured;
  }, []);
  const load = useCallback(async () => {
    const current = run(); if (!current) return;
    setPhase('loading'); setError(''); setCapabilities(null); setBatch(null); setResults([]);
    setCheckedStatus(false);
    try {
      const [caps, watched] = await Promise.all([service.capabilities(), service.nodes()]);
      if (!current()) return;
      validateVotingCapabilities(caps);
      const available = publicWatchedVotingNodes(watched, caps.network);
      setCapabilities(caps); setNodes(available);
      setSelected(Object.fromEntries(available.map((node) => [node.proTxHash, available.length <= PALI_VOTE_LIMIT])));
      setPhase('pick');
    } catch (reason) { if (current()) { setError(paliVotingError(reason)); setPhase('error'); } }
    finally { if (current()) locked.current = false; }
  }, [service, run]);
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; generation.current += 1; }; }, [load]);
  useEffect(() => { if (initialScope.current !== scope) { generation.current += 1; onCloseRef.current(); } }, [scope]);
  useEffect(() => () => providerCleanup.current(), []);
  function bindProvider() {
    providerCleanup.current();
    const provider = getPali();
    const changed = () => { generation.current += 1; onCloseRef.current(); };
    provider?.on?.('accountsChanged', changed); provider?.on?.('chainChanged', changed);
    providerCleanup.current = () => { provider?.removeListener?.('accountsChanged', changed); provider?.removeListener?.('chainChanged', changed); };
  }

  async function relay(payload, current) {
    setPhase('submitting'); setError('');
    try {
      const response = await votesService.submitVote(payload);
      if (!current()) return;
      const next = new Map(voteRelayResults(response, payload.entries).map((entry) => [entryId(entry), entry]));
      setResults((existing) => existing.length ? existing.map((entry) => next.get(entryId(entry)) || entry) : Array.from(next.values()));
      setPhase('done'); onReloadProposals?.();
    } catch (_) {
      if (current()) { setPhase('unknown'); setError('Submission status is uncertain. Check status before retrying. Your signed votes are kept in this dialog; no new signature will be requested.'); }
    }
  }
  async function approve() {
    if (!capabilities || !selectedIds.length || selectedIds.length > PALI_VOTE_LIMIT) return;
    const current = run(); if (!current) return;
    setPhase('approving'); setError('');
    try {
      await service.connectWallet(); if (!current()) return;
      // Initial permission grant may emit accountsChanged. Bind only after
      // connection, before resolving any account-dependent review or signing.
      bindProvider();
      const wallet = await service.walletCapabilities(); if (!current()) return;
      requireWalletVotingCapability(wallet);
      const context = await service.votingContext(capabilities.network, proposalHash, selectedIds); if (!current()) return;
      const request = buildPaliVoteRequest(capabilities, context, proposalHash, outcome, selectedIds);
      setVerifiedName(String(context.proposal?.name || '').slice(0, 160));
      const signed = await service.signVote(request); if (!current()) return;
      const payload = validatePaliVoteResponse(signed, request, context);
      setBatch(payload); setResults(payload.entries.map((entry) => ({ ...entry, ok: false, error: 'status_unknown' })));
      await relay(payload, current);
    } catch (reason) { if (current()) { setError(paliVotingError(reason)); setPhase('pick'); } }
    finally { if (current()) locked.current = false; }
  }
  async function checkStatus() {
    if (!batch) return;
    const current = run(); if (!current) return;
    setPhase('checking'); setError('');
    try {
      const status = await votesService.reconcileReceipts(batch.proposalHash, { refresh: true });
      if (!current()) return;
      if (status.reconcileError || !Array.isArray(status.receipts)) throw new Error('reconcile_failed');
      setCheckedStatus(true);
      const next = batch.entries.map((entry) => {
        return reconciledVoteStatus(results.find((row) => entryId(row) === entryId(entry)) || entry, batch, status);
      });
      setResults(next);
      if (next.some(isUnknownVote)) throw new Error('reconcile_unavailable');
      setPhase('done');
    } catch (_) { if (current()) { setPhase('unknown'); setError('Status could not be checked yet. Wait and check again; no votes were automatically resubmitted.'); } }
    finally { if (current()) locked.current = false; }
  }
  async function retryFailed() {
    if (!batch) return;
    const entries = results.filter((entry) => !entry.ok && !isUnknownVote(entry) && !entry.superseded).map(({ collateralHash, collateralIndex, voteSig }) => ({ collateralHash, collateralIndex, voteSig }));
    if (!entries.length) return;
    const current = run(); if (!current) return;
    try { await relay({ ...batch, entries }, current); }
    finally { if (current()) locked.current = false; }
  }
  if (!isAuthenticated || initialScope.current !== scope) return null;
  const hasUnknown = phase === 'unknown' || results.some(isUnknownVote);
  const failed = results.filter((entry) => !entry.ok && !entry.superseded).length;
  return <VotingDialog title="Vote with Pali" onClose={onClose}>
    <p className="pali-vote__proposal">{verifiedName || String(proposal.title || proposal.name || 'Proposal').slice(0, 160)}</p>
    <p className="vote-modal__hint">Voting keys stay in Pali. This website receives only approved vote signatures, never your private keys.</p>
    {capabilities && <p><strong>{capabilities.network}</strong> · {batch ? batch.entries.length : selectedIds.length} selected · Funding vote</p>}
    {error && <p className="auth-alert auth-alert--error" role="alert">{error}</p>}
    {phase === 'loading' && <p role="status">Loading your watched nodes…</p>}
    {phase === 'error' && <button className="button button--primary" type="button" onClick={load}>Reload nodes</button>}
    {capabilities && !batch && <>
      <fieldset className="pali-vote__outcomes" disabled={busy}><legend>Your vote</legend>{['yes', 'no', 'abstain'].map((value) => <label key={value}><input type="radio" name="pali-vote-outcome" value={value} checked={outcome === value} onChange={() => { generation.current += 1; setOutcome(value); setError(''); }} />{value.charAt(0).toUpperCase() + value.slice(1)}</label>)}</fieldset>
      {!nodes.length ? <p>No watched nodes on this network. <Link to="/nodes" onClick={onClose}>Import public node IDs</Link>, then return here to vote with the matching keys in Pali.</p> : <>
        <p className="vote-modal__hint">Select only nodes whose voting keys are imported into Pali. Watching a node alone does not let you vote. Maximum {PALI_VOTE_LIMIT} per approval.</p>
        <ul className="pali-vote__nodes" aria-label="Watched voting nodes">{nodes.map((node) => <li key={node.proTxHash}><label><input type="checkbox" checked={!!selected[node.proTxHash]} disabled={busy || (!selected[node.proTxHash] && selectedIds.length >= PALI_VOTE_LIMIT)} onChange={(event) => { generation.current += 1; setSelected((old) => ({ ...old, [node.proTxHash]: event.target.checked })); setError(''); }} /><span>{node.label || `${node.proTxHash.slice(0, 12)}…${node.proTxHash.slice(-8)}`}</span></label><details><summary>Node ID</summary><code>{node.proTxHash}</code></details></li>)}</ul>
        <p className="vote-modal__hint">A new vote replaces any earlier vote for these nodes on this proposal. Pali independently verifies each registration before approval.</p>
        <button type="button" className="button button--primary" disabled={busy || !selectedIds.length} onClick={approve}>{phase === 'approving' ? 'Waiting for Pali approval…' : `Review ${selectedIds.length || ''} ${outcome} vote${selectedIds.length === 1 ? '' : 's'} in Pali`}</button>
      </>}
    </>}
    {batch && <section aria-label="Vote results">
      <p><strong>{batch.voteOutcome.toUpperCase()}</strong> · {results.filter((entry) => entry.ok).length} of {batch.entries.length} relayed</p>
      {phase === 'submitting' && <p role="status">Relaying your approved votes…</p>}
      {phase === 'checking' && <p role="status">Checking saved receipts and the chain…</p>}
      <ul className="pali-vote__nodes">{results.map((entry) => <li key={entryId(entry)}><code>{entry.collateralHash.slice(0, 12)}…:{entry.collateralIndex}</code><span>{entry.superseded ? 'Another on-chain vote superseded this request.' : entry.confirmed ? 'Confirmed on-chain.' : entry.ok ? 'Relayed; confirmation pending.' : isUnknownVote(entry) ? 'Checking required.' : 'Not relayed.'}</span></li>)}</ul>
      <div className="pali-vote__actions">
        <button className="button button--ghost" type="button" disabled={busy} onClick={checkStatus}>Check status</button>
        {phase === 'done' && !!failed && !hasUnknown && <button className="button button--primary" type="button" disabled={busy} onClick={retryFailed}>Retry {failed} failed vote{failed === 1 ? '' : 's'}</button>}
        {phase === 'done' && !failed && <button className="button button--ghost" type="button" onClick={load}>Prepare another vote</button>}
        {checkedStatus && hasUnknown && <button className="button button--ghost" type="button" onClick={load}>Review a new vote</button>}
      </div>
      {checkedStatus && hasUnknown && <p className="vote-modal__hint">The earlier vote may still reach the network. A new vote requires another explicit Pali approval; checking did not prove the previous request failed.</p>}
      <p className="vote-modal__hint">Retries use the identical approved signatures. Closing does not cancel votes already relayed; receipts remain in your governance activity.</p>
    </section>}
    {!busy && !batch && onBack && <button type="button" className="button button--ghost pali-vote__back" onClick={onBack}>Choose another key store</button>}
  </VotingDialog>;
}
