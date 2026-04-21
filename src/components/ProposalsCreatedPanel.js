import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { proposalService } from '../lib/proposalService';

// ProposalsCreatedPanel
// ---------------------
// Small panel rendered on the Governance page above the watchlist for
// authenticated users. Surfaces:
//
//   - A "Create proposal" CTA.
//   - A compact "Drafts (N)" row that expands to show the user's
//     drafts with Resume / Delete actions. No banners, matches the
//     UX brief — drafts are discoverable but unobtrusive.
//   - An "In-flight submissions" row listing any proposals that are
//     currently prepared / awaiting collateral confirmations — one
//     click deep-links to the status page.

function fmtSats(sats) {
  if (!sats) return '';
  try {
    const n = BigInt(sats);
    const whole = n / 100000000n;
    const frac = n % 100000000n;
    if (frac === 0n) return whole.toString();
    const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fs}`;
  } catch (_e) {
    return '';
  }
}

function statusLabel(status) {
  switch (status) {
    case 'prepared':
      return 'Awaiting payment';
    case 'awaiting_collateral':
      return 'Confirming collateral';
    case 'submitted':
      return 'On-chain';
    case 'failed':
      return 'Failed';
    default:
      return status || '';
  }
}

export default function ProposalsCreatedPanel() {
  const [drafts, setDrafts] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, s] = await Promise.all([
        proposalService.listDrafts(),
        proposalService.listSubmissions(),
      ]);
      setDrafts(Array.isArray(d) ? d : []);
      setSubmissions(Array.isArray(s) ? s : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const inFlight = useMemo(
    () =>
      submissions.filter(
        (s) => s.status === 'prepared' || s.status === 'awaiting_collateral'
      ),
    [submissions]
  );

  async function onDeleteDraft(id) {
    if (!window.confirm('Delete this draft?')) return;
    setDeletingId(id);
    try {
      await proposalService.deleteDraft(id);
      setDrafts((xs) => xs.filter((x) => x.id !== id));
    } catch (err) {
      setError(err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      className="panel proposals-created"
      data-testid="proposals-created-panel"
    >
      <header className="proposals-created__header">
        <div>
          <p className="eyebrow">Your proposals</p>
          <h2>Create a governance proposal</h2>
        </div>
        <Link
          to="/governance/new"
          className="button button--primary"
          data-testid="create-proposal-cta"
        >
          New proposal
        </Link>
      </header>

      {error ? (
        <div className="auth-alert auth-alert--error" role="alert">
          Could not load your proposals: {error.code || 'error'}
        </div>
      ) : null}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          {drafts.length > 0 ? (
            <div className="proposals-created__row">
              <button
                type="button"
                className="proposals-created__toggle"
                onClick={() => setDraftsOpen((v) => !v)}
                aria-expanded={draftsOpen}
                data-testid="proposals-drafts-toggle"
              >
                <span>Drafts ({drafts.length})</span>
                <span aria-hidden="true">{draftsOpen ? '▾' : '▸'}</span>
              </button>
              {draftsOpen ? (
                <ul
                  className="proposals-created__list"
                  data-testid="proposals-drafts-list"
                >
                  {drafts.map((d) => (
                    <li key={d.id} className="proposals-created__item">
                      <div className="proposals-created__item-main">
                        <strong>{d.name || '(untitled draft)'}</strong>
                        {d.paymentAmountSats ? (
                          <small>
                            {fmtSats(d.paymentAmountSats)} SYS ·{' '}
                            {d.paymentCount || 1}×
                          </small>
                        ) : null}
                      </div>
                      <div className="proposals-created__item-actions">
                        <Link
                          to={`/governance/new?draft=${d.id}`}
                          className="button button--ghost button--small"
                        >
                          Resume
                        </Link>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onDeleteDraft(d.id)}
                          disabled={deletingId === d.id}
                        >
                          {deletingId === d.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {inFlight.length > 0 ? (
            <ul
              className="proposals-created__list"
              data-testid="proposals-inflight-list"
            >
              {inFlight.map((s) => (
                <li key={s.id} className="proposals-created__item">
                  <div className="proposals-created__item-main">
                    <strong>{s.title || s.name}</strong>
                    <small>{statusLabel(s.status)}</small>
                  </div>
                  <div className="proposals-created__item-actions">
                    <Link
                      to={`/governance/proposal/${s.id}`}
                      className="button button--ghost button--small"
                    >
                      Open
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {drafts.length === 0 && inFlight.length === 0 ? (
            <p className="proposals-created__empty">
              You don't have any drafts or in-flight submissions. Use{' '}
              <em>New proposal</em> to get started.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
