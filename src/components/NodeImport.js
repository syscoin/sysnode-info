import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import { useOwnedMasternodes } from '../hooks/useOwnedMasternodes';
import { getPali } from '../lib/paliProvider';
import { NODE_IMPORT_LIMIT, NODE_IMPORT_MAX_LENGTH, nodeImportError, nodeImportId, parseNodeImport, publicVotingNodes, verifiedNodePreview } from '../lib/nodeImport';
import VaultImportModal from './VaultImportModal';
import VaultStatusCard from './VaultStatusCard';

const STATUS = { valid: 'Not checked', invalid: 'Invalid', duplicate: 'Duplicate', existing: 'Already watched', limit: 'Over limit', checking: 'Checking…', verified: 'Verified', failed: 'Needs retry', watching: 'Importing…', watched: 'Imported' };

export default function NodeImport({ capabilities, watched, service, onImported, onBusyChange, disabled = false }) {
  const auth = useAuth();
  const vault = useVault();
  const [open, setOpen] = useState(false);
  const [scopeAtOpen, setScopeAtOpen] = useState('');
  const [mode, setMode] = useState('public');
  const [paste, setPaste] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [votingOpen, setVotingOpen] = useState(false);
  const [discoverySelection, setDiscoverySelection] = useState({});
  const generation = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const scope = JSON.stringify([auth.user?.id, auth.user?.email, auth.isAuthenticated, capabilities?.network, capabilities?.chain?.genesisHash, capabilities?.chain?.era]);
  const owner = useRef(scope);
  owner.current = scope;
  const visible = open && scopeAtOpen === scope && !!capabilities;
  const owned = useOwnedMasternodes({ enabled: visible && mode === 'voting' && !votingOpen });
  const discovered = useMemo(() => publicVotingNodes(owned.owned), [owned.owned]);
  const discoveryFingerprint = discovered.map((node) => node.proTxHash).join(':');
  const overLimit = rows.some((row) => row.status === 'limit');

  const reset = useCallback(() => {
    generation.current += 1;
    if (inFlight.current) onBusyRef.current?.(false);
    inFlight.current = false;
    setBusy(false); setRows([]); setPaste(''); setError(''); setVotingOpen(false); setDiscoverySelection({});
  }, []);
  const close = useCallback(() => { reset(); setOpen(false); }, [reset]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; if (inFlight.current) onBusyRef.current?.(false); };
  }, []);
  useEffect(() => { close(); }, [scope, close]);
  useEffect(() => {
    const provider = getPali();
    const changed = () => close();
    provider?.on?.('accountsChanged', changed); provider?.on?.('chainChanged', changed);
    return () => { provider?.removeListener?.('accountsChanged', changed); provider?.removeListener?.('chainChanged', changed); };
  }, [close]);
  useEffect(() => {
    if (open && mode === 'public') {
      generation.current += 1;
      setRows(parseNodeImport(paste, capabilities?.network || '', watchedRef.current).rows);
      setError(paste.length > NODE_IMPORT_MAX_LENGTH ? 'The pasted batch is too large. Split it into smaller batches.' : '');
    }
  }, [open, mode, paste, capabilities?.network]);
  useEffect(() => {
    if (mode === 'voting') {
      setRows([]);
      setDiscoverySelection(Object.fromEntries(discoveryFingerprint.split(':').filter(Boolean).map((hash) => [hash, discoveryFingerprint.split(':').length <= NODE_IMPORT_LIMIT])));
    }
  }, [mode, discoveryFingerprint]);

  const changeMode = (next) => { reset(); setMode(next); };
  function start() {
    if (inFlight.current || disabled || !capabilities || !auth.isAuthenticated) return null;
    inFlight.current = true; setBusy(true); setError('');
    onBusyRef.current?.(true);
    const token = ++generation.current;
    const currentScope = scope;
    return () => alive.current && generation.current === token && owner.current === currentScope;
  }
  const updateRow = (id, patch) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  async function verify(candidates) {
    if (candidates.length > NODE_IMPORT_LIMIT || paste.length > NODE_IMPORT_MAX_LENGTH) return;
    const current = start(); if (!current) return;
    try {
      // Read fresh shortcuts before adding any node, including entries saved
      // in another tab since this page loaded. The server also inserts these
      // requests without overwriting existing labels.
      const existing = await service.nodes();
      if (!current()) return;
      if (!Array.isArray(existing) || existing.some((node) => typeof node?.network !== 'string' || !/^[0-9a-f]{64}$/i.test(node?.proTxHash || ''))) throw new Error('Invalid watch list');
      onImportedRef.current(existing);
      const ids = new Set(existing.map((node) => nodeImportId(node.network, node.proTxHash)));
      for (const row of candidates) {
        if (!current()) return;
        if (ids.has(nodeImportId(capabilities.network, row.proTxHash))) {
          updateRow(row.id, { status: 'existing', selected: false, message: 'Already watched. Its existing label will be kept.' }); continue;
        }
        updateRow(row.id, { status: 'checking', selected: false, message: '' });
        try {
          const context = await service.context(capabilities.network, row.proTxHash);
          if (!current()) return;
          const details = verifiedNodePreview(context, capabilities, row.proTxHash);
          updateRow(row.id, { status: 'verified', selected: true, stage: '', details, message: 'Registered on this network. Review before importing.' });
        } catch (reason) {
          if (!current()) return;
          updateRow(row.id, { status: 'failed', selected: false, stage: 'lookup', message: nodeImportError(reason) });
          if (reason?.status === 429 || reason?.status === 401) { setError(nodeImportError(reason)); break; }
        }
      }
    } catch (reason) { if (current()) setError(nodeImportError(reason)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); onBusyRef.current?.(false); } }
  }
  async function importRows(failedOnly = false) {
    const candidates = rows.filter((row) => row.selected && (row.status === 'verified' || (row.status === 'failed' && row.stage === 'watch')) && (!failedOnly || row.stage === 'watch'));
    if (!candidates.length || candidates.length > NODE_IMPORT_LIMIT) return;
    const current = start(); if (!current) return;
    try {
      for (const row of candidates) {
        if (!current()) return;
        updateRow(row.id, { status: 'watching', message: '' });
        try {
          const result = await service.watch({ network: capabilities.network, proTxHash: row.proTxHash, label: row.label, preserveExisting: true });
          if (!current()) return;
          if (!Array.isArray(result)) throw new Error('Invalid watch list');
          onImportedRef.current(result);
          updateRow(row.id, { status: 'watched', selected: false, stage: '', message: 'Imported as a watch only. No signing authority was granted.' });
        } catch (reason) {
          if (!current()) return;
          updateRow(row.id, { status: 'failed', stage: 'watch', message: nodeImportError(reason) });
          if (reason?.status === 429 || reason?.status === 401) { setError(nodeImportError(reason)); break; }
        }
      }
    } finally { if (current()) { inFlight.current = false; setBusy(false); onBusyRef.current?.(false); } }
  }
  function reviewDiscovered() {
    const chosen = discovered.filter((node) => discoverySelection[node.proTxHash]);
    if (!chosen.length || chosen.length > NODE_IMPORT_LIMIT) return;
    const parsed = parseNodeImport(chosen.map((node) => `${node.proTxHash},${node.label}`).join('\n'), capabilities.network, watched);
    setRows(parsed.rows); setError('');
    void verify(parsed.rows.filter((row) => row.status === 'valid'));
  }
  const selectedCount = rows.filter((row) => row.selected && ['verified', 'failed'].includes(row.status)).length;
  const discoveredCount = discovered.filter((node) => discoverySelection[node.proTxHash]).length;
  return <>
    <button type="button" className="button button--primary" disabled={disabled || !capabilities} onClick={() => { reset(); setMode('public'); setScopeAtOpen(scope); setOpen(true); }}>Import nodes</button>
    {visible && <section className="node-import" aria-label="Import nodes">
      <div className="node-import__heading"><h3>Import nodes</h3><button type="button" className="button button--ghost" onClick={close}>Close import</button></div>
      <p>Choose what you have. Node IDs add public shortcuts; browser voting keys stay in your encrypted voting vault. Neither grants owner or operator authority.</p>
      <div className="node-import__modes" role="group" aria-label="Import source">
        <button type="button" aria-pressed={mode === 'public'} disabled={busy} onClick={() => changeMode('public')}>Public node IDs</button>
        <button type="button" aria-pressed={mode === 'voting'} disabled={busy} onClick={() => changeMode('voting')}>Voting keys</button>
      </div>
      <p className="auth-card__hint">Network: <strong>{capabilities.network}</strong>. Up to {NODE_IMPORT_LIMIT} nodes per batch. Operator and owner private keys belong in Pali, never in this page.</p>
      <p className="auth-card__hint">Keeping voting keys in Pali? Import only the public node IDs here. Pali keeps custody and asks for approval when you vote. The browser voting vault remains available for phone-based voting.</p>
      {mode === 'public' ? <>
        <label htmlFor="node-import-paste">Public ProTx IDs, one per line</label>
        <textarea id="node-import-paste" rows="5" value={paste} disabled={busy} autoComplete="off" spellCheck="false" placeholder="64-character ProTx ID, optional label" onChange={(event) => setPaste(event.target.value)} />
        <p className="auth-card__hint">Optional format: <code>ProTx ID, label</code>. Do not paste WIFs, private descriptors or private keys here.</p>
        {overLimit && <p role="alert">This batch contains more than {NODE_IMPORT_LIMIT} nodes. Every excess line is marked below; move those lines to another batch before checking.</p>}
        <button type="button" className="button button--ghost" disabled={busy || overLimit || paste.length > NODE_IMPORT_MAX_LENGTH || !rows.some((row) => row.status === 'valid')} onClick={() => verify(rows.filter((row) => row.status === 'valid'))}>Check node IDs</button>
      </> : <>
        <p>Import one or many voting WIFs or private descriptors with the existing local validation and encrypted-vault flow. Only derived public addresses are used to discover registrations.</p>
        {vault.isEmpty || vault.isUnlocked ? <button type="button" className="button button--primary" disabled={busy} onClick={() => setVotingOpen(true)}>Import voting keys</button> : <VaultStatusCard user={auth.user} />}
        {owned.isLoading && <p role="status">Finding registrations for your voting addresses…</p>}
        {owned.isError && <p role="alert">Could not discover voting nodes. Unlock the vault and retry the lookup.</p>}
        {owned.isReady && <p>{discovered.length ? `${discovered.length} registered nodes match your voting addresses.` : 'No registrations match the voting addresses in this vault on the configured service.'}</p>}
        {!!discovered.length && <ul className="node-import__discovered" aria-label="Discovered voting nodes">{discovered.map((node) => <li key={node.proTxHash}><label className="node-import__selection"><input type="checkbox" checked={!!discoverySelection[node.proTxHash]} disabled={busy || (!discoverySelection[node.proTxHash] && discoveredCount >= NODE_IMPORT_LIMIT)} onChange={(event) => setDiscoverySelection((current) => ({ ...current, [node.proTxHash]: event.target.checked }))} />{node.label || 'Voting node'}</label><code>{node.proTxHash}</code></li>)}</ul>}
        <p>{discoveredCount} selected for this batch (maximum {NODE_IMPORT_LIMIT}).</p>
        <button type="button" className="button button--ghost" disabled={busy || !owned.isReady || !discoveredCount || discoveredCount > NODE_IMPORT_LIMIT} onClick={reviewDiscovered}>Review discovered nodes</button>
        {owned.isError && <button type="button" className="button button--ghost" onClick={() => owned.refresh()}>Retry discovery</button>}
      </>}
      {error && <p role="alert" className="auth-alert auth-alert--error">{error}</p>}
      {!!rows.length && <ul className="node-import__rows" aria-label="Import preview">{rows.map((row) => <li key={row.id}>
        <div className="node-import__row-heading"><strong>Line {row.lineNo}</strong><span role="status">{STATUS[row.status]}</span></div>
        {row.proTxHash && <code>{row.proTxHash}</code>}{row.label && <p>{row.label}</p>}
        {row.details && <p>Service: {row.details.service || 'Not configured'} · NEVM: {row.details.nevmAddress || 'Not registered'}</p>}
        <p>{row.message}</p>
        {['verified', 'failed'].includes(row.status) && row.stage !== 'lookup' && <label className="node-import__selection"><input type="checkbox" checked={row.selected} disabled={busy} onChange={(event) => updateRow(row.id, { selected: event.target.checked })} />Select line {row.lineNo}</label>}
      </li>)}</ul>}
      <div className="sentry-actions">
        {rows.some((row) => row.status === 'failed' && row.stage === 'lookup') && <button type="button" className="button button--ghost" disabled={busy} onClick={() => verify(rows.filter((row) => row.status === 'failed' && row.stage === 'lookup'))}>Retry failed lookups</button>}
        <button type="button" className="button button--primary" disabled={busy || !selectedCount || overLimit} onClick={() => importRows()}>Watch selected nodes ({selectedCount})</button>
        {rows.some((row) => row.status === 'failed' && row.stage === 'watch') && <button type="button" className="button button--ghost" disabled={busy} onClick={() => importRows(true)}>Retry failed imports</button>}
      </div>
      {busy && <p role="status">Checking one node at a time. Closing stops the remaining requests; an import already sent may still finish.</p>}
    </section>}
    <VaultImportModal open={visible && votingOpen} onClose={() => setVotingOpen(false)} />
  </>;
}
