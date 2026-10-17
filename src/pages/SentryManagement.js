import React, { useEffect, useRef, useState } from 'react';
import PageMeta from '../components/PageMeta';
import { getPali } from '../lib/paliProvider';
import { normalizeProTxHash, serviceChanges, sentryService, SENTRY_OPERATIONS } from '../lib/sentryService';
import './SentryManagement.css';

const ERROR_COPY = {
  core_sentry_capabilities_required: 'The configured Core node needs the Sentry capabilities update before secure signing can be enabled.',
  sentry_not_configured: 'Node management is not configured on this server yet.',
  nevm_address_in_use: 'Another registered node already uses this NEVM address.',
  node_banned: 'Restore the node’s service endpoint first. Its NEVM address cannot change while the node is banned.',
  node_not_confirmed: 'Wait for the node registration to confirm before updating it.',
  network_mismatch: 'The wallet, backend and node must use the same Syscoin network.',
  operation_changed: 'The prepared transaction no longer matches. Prepare and review a fresh update.',
  node_state_changed: 'The node registration changed after this update was prepared. Prepare and review it again.',
  method_not_supported: 'Update Pali to a version that supports this node operation.',
  pali_unavailable: 'Install or unlock Pali to continue.',
  operation_expired: 'This review expired. Prepare a fresh update before signing.',
  retry_not_ready: 'Wait 30 seconds between publication attempts, then retry the identical transaction.',
  transaction_rejected: 'Core no longer accepts this transaction. Its existing transaction ID is retained; no replacement was created.',
  operator_enrollment_required: 'Enroll the node’s PQ operator key before service updates or revocation.',
  too_many_sentry_requests: 'Too many requests. Please wait before trying again.',
  email_not_verified: 'Verify your Sysnode account email before managing nodes.',
  no_unreserved_fee_funds: 'No confirmed fee funds are available outside protected node collateral. Fund the connected fee account first.',
  collateral_already_registered: 'This collateral already belongs to a registered node. Manage that node instead.',
  collateral_not_confirmed_or_spent: 'Collateral must be confirmed and unspent before registration.',
  INVALID_KEY: 'One of the public keys is invalid for this operation.',
  KEY_MISMATCH: 'The selected authority does not match the on-chain registration.',
  UNSUPPORTED_OPERATION: 'The connected protocol does not support this operation. No legacy fallback was used.',
  context_changed: 'The wallet account or network changed. Review the update again.',
};
function message(error) { return ERROR_COPY[error?.code || error?.message] || error?.message || 'The operation could not be completed. No automatic retry was sent.'; }
const INITIAL = { nevmMode: 'keep', nevmAddress: '', serviceMode: 'keep', service: '', payoutMode: 'keep', payout: '' };
const REVIEW_LABELS = { nevmAddress: 'NEVM address', service: 'Service endpoint', operatorPayoutScript: 'Operator payout script', collateral: 'Collateral output', collateralSatoshis: 'Collateral amount (satoshis)', ownerKeyId: 'Owner key identity', votingKeyId: 'Voting key identity', payoutAddress: 'Payout address', operatorRewardBasisPoints: 'Operator reward (basis points)', operatorPublicKey: 'Operator public key', pqVotingPublicKey: 'PQ voting public key', pqOwnerPublicKey: 'PQ owner public key', collateralSigningMessage: 'Collateral authorization message', previousPayoutAddress: 'Current payout address', previousVotingKeyId: 'Current voting key identity', previousOperatorPublicKey: 'Current operator public key', previousPQVotingPublicKey: 'Current PQ voting key', previousPQOwnerPublicKey: 'Current PQ owner key', reason: 'Revocation reason' };

export default function SentryManagement({ service = sentryService }) {
  const [capabilities, setCapabilities] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [operations, setOperations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [nodeHash, setNodeHash] = useState('');
  const [label, setLabel] = useState('');
  const [draft, setDraft] = useState(INITIAL);
  const [prepared, setPrepared] = useState(null);
  const [managementOperation, setManagementOperation] = useState('register');
  const [managementFields, setManagementFields] = useState({});
  const [feeRate, setFeeRate] = useState('10');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  const field = (key) => (event) => { generation.current += 1; setDraft((value) => ({ ...value, [key]: event.target.value })); setPrepared(null); };

  useEffect(() => {
    mounted.current = true;
    let active = true;
    Promise.all([service.capabilities(), service.nodes(), service.operations()]).then(([caps, list, history]) => {
      if (active) { setCapabilities(caps); setNodes(list); setOperations(history); }
    }).catch((err) => active && setError(message(err)));
    const provider = getPali();
    const changed = () => { generation.current += 1; setPrepared(null); setError(ERROR_COPY.context_changed); };
    provider?.on?.('accountsChanged', changed); provider?.on?.('chainChanged', changed);
    return () => {
      active = false; mounted.current = false; generation.current += 1;
      provider?.removeListener?.('accountsChanged', changed); provider?.removeListener?.('chainChanged', changed);
    };
  }, [service]);
  async function perform(phase, fn) {
    if (locked.current) return;
    locked.current = true; setBusy(phase); setError(''); setNotice('');
    const token = generation.current;
    const assertCurrent = () => { if (!mounted.current || generation.current !== token) throw new Error('context_changed'); };
    try { await fn(assertCurrent); }
    catch (err) { if (mounted.current) setError(message(err)); }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  async function select(node) {
    await perform('Loading node', async (assertCurrent) => {
      const value = await service.context(node.network, node.proTxHash); assertCurrent();
      setSelected(node); setContext(value); setDraft(INITIAL); setPrepared(null);
    });
  }
  async function addNode(event) {
    event.preventDefault();
    await perform('Looking up node', async (assertCurrent) => {
      const proTxHash = normalizeProTxHash(nodeHash);
      const list = await service.watch({ network: capabilities.network, proTxHash, label: label.trim() }); assertCurrent();
      setNodes(list); setNodeHash(''); setLabel('');
    });
  }
  async function stopWatching(node) {
    await perform('Removing watch record', async (assertCurrent) => {
      await service.unwatch(node); assertCurrent();
      setNodes((items) => items.filter((item) => item.network !== node.network || item.proTxHash !== node.proTxHash));
      if (selected?.network === node.network && selected?.proTxHash === node.proTxHash) { setSelected(null); setContext(null); setPrepared(null); }
    });
  }
  async function linkNode() {
    await perform('Waiting for Pali to verify this node', async (assertCurrent) => {
      const result = await service.linkNode(selected.proTxHash, context.chain.genesisHash); assertCurrent();
      if (result?.linked !== true || result.proTxHash !== selected.proTxHash || result.genesisHash !== context.chain.genesisHash) throw new Error('Pali did not confirm the selected node and network.');
      setNotice('Node linked in Pali. This did not sign or broadcast a transaction.');
    });
  }
  async function prepare(event) {
    event.preventDefault();
    await perform('Preparing update', async (assertCurrent) => {
      const changes = serviceChanges(draft);
      const walletCaps = await service.walletCapabilities(); assertCurrent();
      if (!walletCaps?.operations?.includes('updateService')) throw new Error('Update Pali to a version with Sentry operator signing.');
      const funding = await service.fundingIdentity(); assertCurrent();
      const rate = Number(feeRate);
      if (!Number.isInteger(rate) || rate < 1 || rate > 1000) throw new Error('Fee rate must be 1 to 1000 satoshis per vbyte.');
      const result = await service.prepare({ network: selected.network, proTxHash: selected.proTxHash, changes, feeRate: rate, ...funding }); assertCurrent();
      setPrepared(result);
    });
  }
  async function signAndSubmit() {
    await perform('Waiting for operator approval in Pali', async (assertCurrent) => {
      let request = prepared.prepared.request;
      let authorization;
      for (let slot = 0; slot < 3; slot += 1) {
        authorization = await service.signOperation(request); assertCurrent();
        if (authorization.complete !== false) break;
        request = { ...request, transactionHex: authorization.transactionHex };
        setBusy('Waiting for the next required authority in Pali');
      }
      if (authorization.complete === false) throw new Error('Required node authorizations are incomplete. No fee transaction was signed.');
      const funded = await service.authorize(prepared.id, authorization); assertCurrent();
      setBusy('Waiting for fee approval in Pali');
      const signed = await service.signFees(funded.psbt); assertCurrent();
      setBusy('Submitting signed transaction');
      // No frontend retry on a timeout. The operation id remains in the
      // durable server history for readback after reload or disconnect.
      const id = prepared.id;
      setPrepared(null);
      setOperations((items) => [{ id, network: prepared.network || capabilities.network, status: 'submission_unknown' }, ...items.filter((item) => item.id !== id)]);
      const result = await service.submit(id, signed);
      if (mounted.current) { setOperations(await service.operations()); setError(result.status === 'submission_unknown' ? 'Submission status is unknown. Use Check status below; do not create a duplicate update.' : ''); }
    });
  }
  async function prepareManagement(event) {
    event.preventDefault();
    await perform('Preparing node operation', async (assertCurrent) => {
      const walletCaps = await service.walletCapabilities(); assertCurrent();
      if (!walletCaps?.operations?.includes(managementOperation)) throw new Error('This Pali version does not support the selected operation. Update Pali first.');
      const funding = await service.fundingIdentity(); assertCurrent();
      const changes = {};
      for (const key of ['service', 'ownerAddress', 'votingAddress', 'operatorPublicKey', 'pqOwnerPublicKey', 'pqVotingPublicKey', 'payoutAddress']) {
        if (managementFields[key]?.trim()) changes[key] = managementFields[key].trim();
      }
      for (const name of ['operatorPublicKey', 'pqOwnerPublicKey', 'pqVotingPublicKey']) {
        if (changes[name]) {
          const bytes = name === 'operatorPublicKey' && !['registerOperator', 'rotateOperator'].includes(managementOperation) ? 48 : 32;
          if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(changes[name])) throw new Error(`Enter the ${bytes}-byte public key, not a private key, for ${name}.`);
        }
      }
      if (managementOperation === 'register') changes.operatorRewardBasisPoints = Number(managementFields.operatorRewardBasisPoints || 0);
      if (managementOperation === 'revoke') changes.reason = Number(managementFields.reason || 0);
      if (managementOperation === 'registerOperator' || managementOperation === 'rotateOperator') {
        changes.operatorPublicKey = (managementFields.operatorPublicKey || '').trim();
        changes.childKeyCommitment = (managementFields.childKeyCommitment || '').trim();
        changes.keyVersion = Number(managementFields.keyVersion);
        if (!/^[0-9a-fA-F]{160}$/.test(changes.childKeyCommitment)) throw new Error('The public child-key commitment must contain exactly 80 bytes of hexadecimal data.');
      }
      const rate = Number(feeRate);
      if (!Number.isInteger(rate) || rate < 1 || rate > 1000) throw new Error('Fee rate must be 1 to 1000 satoshis per vbyte.');
      const result = await service.prepare({ operation: managementOperation, network: capabilities.network, feeRate: rate,
        ...(managementOperation === 'register' ? { collateralOutpoint: { txid: normalizeProTxHash(managementFields.collateralTxid), vout: Number(managementFields.collateralVout) } } : { proTxHash: selected.proTxHash }),
        changes, ...funding }); assertCurrent();
      setPrepared(result);
    });
  }
  async function refreshOperation(id) {
    await perform('Checking on-chain status', async (assertCurrent) => {
      const result = await service.reconcile(id); assertCurrent();
      setOperations((items) => items.map((item) => item.id === id ? { ...item, ...result } : item));
    });
  }
  async function retryOperation(id) {
    await perform('Checking and retrying the identical signed transaction', async (assertCurrent) => {
      const result = await service.retry(id); assertCurrent();
      setOperations((items) => items.map((item) => item.id === id ? { ...item, ...result } : item));
      setNotice(result.status === 'submission_unknown'
        ? 'Publication is still uncertain. The original signed transaction and transaction ID are unchanged.'
        : 'The original transaction was found or republished. No new transaction or wallet signature was created.');
    });
  }
  async function resumeOperation(id) {
    await perform('Restoring saved review', async (assertCurrent) => {
      const result = await service.reconcile(id); assertCurrent();
      if (result.status !== 'prepared') throw new Error('This operation has already been submitted. Use Check status.');
      if (result.prepared.request.operation !== 'register') {
        const value = await service.context(result.network, result.proTxHash); assertCurrent();
        setContext(value); setSelected({ network: result.network, proTxHash: result.proTxHash });
      }
      setPrepared({ id: result.id, prepared: result.prepared });
    });
  }
  async function linkRegisteredNode(operation) {
    await perform('Linking confirmed registration in Pali', async (assertCurrent) => {
      const registered = await service.context(operation.network, operation.txid); assertCurrent();
      const result = await service.linkNode(operation.txid, registered.chain.genesisHash); assertCurrent();
      if (result?.linked !== true || result.genesisHash !== registered.chain.genesisHash || result.proTxHash !== operation.txid) throw new Error('Pali did not confirm the registered node.');
      setNotice('Registered node linked in Pali. Its public identity and owned collateral are now tracked there.');
    });
  }
  const request = prepared?.prepared;
  const pq = capabilities?.chain.era === 'pq-v4';
  const managementField = (name, labelText, options = {}) => <label key={name}>{labelText}<input value={managementFields[name] || ''} onChange={(event) => { generation.current += 1; setPrepared(null); setManagementFields((old) => ({ ...old, [name]: event.target.value })); }} disabled={!!busy} {...options} /></label>;
  return <>
    <PageMeta title="Sentry Node management" description="Manage your on-chain Sentry Node registration with local signing in Pali." />
    <section className="page-hero auth-hero"><div className="site-wrap">
      <span className="eyebrow">Sentry Nodes</span><h1>Your node. Your keys.</h1>
      <p className="page-hero__copy">Import operator keys in Pali, not this website. Voting keys in your Sysnode vault do not authorize node administration.</p>
    </div></section>
    <section className="page-section page-section--tight page-section--last"><div className="site-wrap sentry-management">
      {error && <div className="auth-alert auth-alert--error" role="alert">{error}</div>}
      {notice && <p role="status" className="auth-alert">{notice}</p>}
      <p role="status" aria-live="polite">{busy}</p>
      <div className="auth-card">
        <h2>Network and protocol</h2>
        <p>{capabilities ? `${capabilities.network} · ${capabilities.chain.era === 'pq-v4' ? 'Post-quantum' : 'Legacy BLS'}` : 'Checking configured network…'}</p>
        <label>Fee rate (satoshis per vbyte)<input type="number" min="1" max="1000" step="1" value={feeRate} disabled={!!busy} onChange={(event) => { generation.current += 1; setFeeRate(event.target.value); setPrepared(null); }} /></label>
        <p className="auth-card__hint">The exact total is shown before signing. Pali independently enforces your maximum fee; this page cannot raise it.</p>
        <details><summary>Supported operations and hosting</summary>
        <ul>{SENTRY_OPERATIONS.map((operation) => <li key={operation.id}>{operation.label} — {operation.role}: {capabilities?.operations?.includes(operation.id) ? 'Available' : 'Not supported by the connected protocol adapter'}</li>)}</ul>
        <p>Self-hosted nodes use the same on-chain identity as hosted nodes. Changing a hosting provider does not change ownership. NodeHub provisioning is optional and is not enabled here.</p>
        </details>
      </div>
      <details className="auth-card"><summary><h2>Registration and authority management</h2></summary>
        <p>Node ownership, collateral and operator authority are separate roles. Every required role must approve in Pali before the fee transaction is signed.</p>
        <form onSubmit={prepareManagement}>
          <label>Operation<select value={managementOperation} onChange={(event) => { setManagementOperation(event.target.value); setManagementFields({}); setPrepared(null); }} disabled={!!busy}>
            <option value="register">Register a node using existing collateral</option><option value="updateRegistrar">Update owner-authorized registration</option><option value="registerOperator">Enroll or recover a PQ operator</option><option value="rotateOperator">Rotate an active PQ operator</option><option value="revoke">Revoke operator</option>
          </select></label>
          {managementOperation !== 'register' && <p>{selected ? `Selected node: ${selected.label || selected.proTxHash}` : 'Select a node from your watch list first.'}</p>}
          {managementOperation === 'register' && <>
            {managementField('collateralTxid', 'Collateral transaction ID', { required: true, maxLength: 64 })}
            {managementField('collateralVout', 'Collateral output index', { required: true, type: 'number', min: 0, max: 4294967295, step: 1 })}
            {managementField('service', 'Public service IP and port', { required: true })}
            {managementField('ownerAddress', 'Owner address (separate from collateral)', { required: true })}
            {managementField('votingAddress', 'Voting address (separate from collateral)', { required: true })}
            {managementField('operatorRewardBasisPoints', 'Operator reward (basis points, 100 = 1%)', { type: 'number', min: 0, max: 10000, step: 1 })}
          </>}
          {(managementOperation === 'register' || managementOperation === 'updateRegistrar') && <>
            {managementField('payoutAddress', managementOperation === 'register' ? 'Payout address' : 'New payout address (leave blank to keep)', { required: managementOperation === 'register' })}
            {!pq && managementField('operatorPublicKey', managementOperation === 'register' ? 'Operator BLS public key' : 'New operator BLS public key (leave blank to keep)', { required: managementOperation === 'register', maxLength: 96 })}
            {managementOperation === 'updateRegistrar' && managementField('votingAddress', 'New voting address (leave blank to keep)')}
            {(pq || (capabilities?.preparationActive && managementOperation === 'updateRegistrar')) && <>
              {managementField('pqOwnerPublicKey', managementOperation === 'register' ? 'Owner PQ public key' : 'New owner PQ public key (leave blank to keep)', { required: managementOperation === 'register', maxLength: 64 })}
              {managementField('pqVotingPublicKey', managementOperation === 'register' ? 'Voting PQ public key' : 'New voting PQ public key (leave blank to keep)', { required: managementOperation === 'register', maxLength: 64 })}
              <p>PQ operator keys use “Enroll or recover a PQ operator” and “Rotate an active PQ operator”, not a legacy BLS update.</p>
            </>}
          </>}
          {(managementOperation === 'registerOperator' || managementOperation === 'rotateOperator') && <>
            {managementField('operatorPublicKey', 'New PQ operator public key', { required: true, maxLength: 64 })}
            {managementField('keyVersion', 'New global key version', { required: true, type: 'number', min: 1, max: 4294967295, step: 1 })}
            {managementField('childKeyCommitment', 'Public child-key commitment from the node operator tool', { required: true, maxLength: 160 })}
            <p>The public commitment must belong to the prepared operator key tree. Pali signs locally with the matching imported key. Never paste a private key or seed here.</p>
          </>}
          {managementOperation === 'revoke' && <label>Revocation reason<select value={managementFields.reason || '0'} onChange={(event) => setManagementFields({ reason: event.target.value })} disabled={!!busy}><option value="0">Unspecified</option><option value="1">Termination of service</option><option value="2">Compromised keys</option><option value="3">Change of keys</option></select></label>}
          {managementOperation === 'revoke' && <p className="auth-alert auth-alert--error">Revocation disables the node operator. It does not spend or transfer the collateral.</p>}
          <button className="button button--primary" disabled={!!busy || !capabilities?.operations?.includes(managementOperation) || (managementOperation !== 'register' && !selected)}>Prepare operation</button>
        </form>
      </details>
      <div className="auth-card"><h2>Watch a registered node</h2>
        <form onSubmit={addNode}>
          <label>ProTx hash<input value={nodeHash} onChange={(e) => setNodeHash(e.target.value)} autoComplete="off" spellCheck="false" maxLength={64} required /></label>
          <label>Label (optional)<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></label>
          <button className="button button--primary" disabled={!!busy || !capabilities}>Add node</button>
        </form>
        <ul className="sentry-node-list">{nodes.map((node) => <li key={`${node.network}:${node.proTxHash}`}><button className="button button--ghost" disabled={!!busy} onClick={() => select(node)}>{node.label || `${node.proTxHash.slice(0, 12)}…`} <small>{node.network}</small></button><button className="button button--ghost" disabled={!!busy} onClick={() => stopWatching(node)} aria-label="Remove watch record">Stop watching</button></li>)}</ul>
        <p className="auth-card__hint">Stopping a watch only removes the saved shortcut. It does not revoke or delete the on-chain node.</p>
        <p className="auth-card__hint">Preparing an operation shares the connected fee account’s public XPUB and change address with this service. Private keys stay in Pali.</p>
      </div>
      {context && <div className="auth-card"><h2>{selected.label || 'Node registration'}</h2>
        <dl><dt>ProTx hash</dt><dd>{context.node.proTxHash}</dd><dt>Operator public key</dt><dd>{context.node.operatorPublicKey || 'Not enrolled'}</dd><dt>Current service</dt><dd>{['0.0.0.0:0', '[::]:0'].includes(context.node.service) ? 'Not configured' : context.node.service}</dd><dt>Current NEVM address</dt><dd>{context.node.nevmAddress || 'Not registered'}</dd></dl>
        {context.node.poseBanHeight >= 0 && <p className="auth-alert">This node requires service recovery. Set its public IP and port, keeping the NEVM address unchanged. After confirmation, you can update NEVM separately.</p>}
        <button type="button" className="button button--ghost" disabled={!!busy} onClick={linkNode}>Link node to Pali</button>
        <p>Pali independently verifies the node and asks before saving its public metadata. If this wallet owns the collateral, Pali protects that exact output. Import signing keys directly in Pali, never here.</p>
        <form onSubmit={prepare}>
          <label>NEVM address<select value={draft.nevmMode} onChange={field('nevmMode')} disabled={!!busy}><option value="keep">Keep current registration</option><option value="set">Add or update address</option><option value="remove">Remove registration</option></select></label>
          {draft.nevmMode === 'set' && <label>New NEVM address<input value={draft.nevmAddress} onChange={field('nevmAddress')} placeholder="0x…" maxLength={42} spellCheck="false" required /></label>}
          {draft.nevmMode === 'remove' && <p className="auth-alert auth-alert--error">This explicitly unregisters the NEVM address. It is not the same as leaving the field unchanged.</p>}
          <label>Service endpoint<select value={draft.serviceMode} onChange={field('serviceMode')} disabled={!!busy}><option value="keep">Keep current endpoint</option><option value="set">Update public IP and port</option></select></label>
          {draft.serviceMode === 'set' && <label>Public IP and port<input value={draft.service} onChange={field('service')} required /></label>}
          <label>Operator payout<select value={draft.payoutMode} onChange={field('payoutMode')} disabled={!!busy}><option value="keep">Keep current payout</option><option value="set">Update payout address</option><option value="remove">Remove operator payout</option></select></label>
          {draft.payoutMode === 'set' && <label>New payout address<input value={draft.payout} onChange={field('payout')} required /></label>}
          <button className="button button--primary" disabled={!!busy || !capabilities?.operations?.includes('updateService')}>Prepare update</button>
        </form>
      </div>}
      {request && <div className="auth-card" aria-label="Review node update"><h2>Review before signing</h2>
        <dl>{Object.entries(request.review.changes || {}).map(([name, change]) => <React.Fragment key={name}><dt>{REVIEW_LABELS[name] || name}</dt><dd>{change.previous || 'Unregistered'} → {change.next || 'Unregistered'}</dd></React.Fragment>)}{Object.entries(request.review.fields || {}).filter(([, value]) => value !== '').map(([name, value]) => <React.Fragment key={name}><dt>{REVIEW_LABELS[name] || name}</dt><dd>{value}</dd></React.Fragment>)}<dt>Network fee (satoshis)</dt><dd>{request.review.feeSatoshis}</dd></dl>
        {!!request.review.authorizations?.length && <><h3>Required approvals</h3><ul>{request.review.authorizations.map((authorization) => <li key={authorization.id}>{authorization.role} · {authorization.scheme}</li>)}</ul></>}
        <p>Pali independently checks the node authorities and transaction. Approve each required authority, then the network fee. No private key is shared with Sysnode.</p>
        <div className="sentry-actions"><button className="button button--primary" onClick={signAndSubmit} disabled={!!busy}>Review and sign in Pali</button><button className="button button--ghost" onClick={() => setPrepared(null)} disabled={!!busy}>Cancel review</button></div>
      </div>}
      <div className="auth-card"><h2>Operation history</h2><p>Submission records survive reloads. Check status after a connection loss. You can retry the identical signed transaction without creating a new payment or signing again; this is never automatic.</p>
        {operations.length === 0 ? <p>No operations yet.</p> : <ul>{operations.map((operation) => <li key={operation.id}><strong>{operation.status.replace(/_/g, ' ')}</strong> · {operation.network}<code>{operation.txid || operation.id}</code><div className="sentry-actions">{operation.status === 'prepared' && <button className="button button--ghost" disabled={!!busy} onClick={() => resumeOperation(operation.id)}>Resume review</button>}{operation.status === 'confirmed' && operation.operation === 'register' && <button className="button button--ghost" disabled={!!busy} onClick={() => linkRegisteredNode(operation)}>Link registered node to Pali</button>}{['submission_unknown', 'submitting', 'submitted'].includes(operation.status) && <button className="button button--ghost" disabled={!!busy} onClick={() => retryOperation(operation.id)}>Retry identical transaction</button>}<button className="button button--ghost" disabled={!!busy} onClick={() => refreshOperation(operation.id)}>Check status</button></div></li>)}</ul>}
      </div>
    </div></section>
  </>;
}
