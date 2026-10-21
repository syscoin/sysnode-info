import React from 'react';

const LABELS = { chain: 'Chain', node: 'Sentry node', governance: 'Governance', market: 'Market' };

export default function NetworkDataStatus({ groups, historyError }) {
  const observations = Object.entries(groups || {});
  // The page already has one clear outage message when every live group is
  // unavailable. Do not repeat it in four more warning panels.
  const allUnavailable = observations.length > 0 && observations.every(([, group]) => group.status === 'unavailable');
  const notices = new Map();
  for (const [name, group] of observations) {
    if (allUnavailable || group.status === 'ready') continue;
    const key = `${group.status}:${group.updatedAt || ''}`;
    const notice = notices.get(key) || { ...group, names: [] };
    notice.names.push(LABELS[name]);
    notices.set(key, notice);
  }
  return <div className="network-data-status" aria-live="polite">
    {[...notices.entries()].map(([key, group]) => (
      <p className="notice notice--warning" key={key}>
        {group.names.join(', ')} statistics {group.status === 'stale' ? 'are stale' :
          group.status === 'unverified' ? 'have no source freshness timestamp' : 'are unavailable'}.
        {group.updatedAt ? ` Last successful update: ${new Date(group.updatedAt).toLocaleString()}.` : ''}
      </p>
    ))}
    {historyError ? <p className="notice notice--warning">{historyError}</p> : null}
  </div>;
}
