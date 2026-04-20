// Email normalization MUST match sysnode-backend/lib/email.js exactly —
// the email is the PBKDF2 salt, so a divergence here makes login impossible
// across devices or after a cache clear.
//
// Rules (mirrored from the backend):
//   1. NFKC compatibility decomposition + recomposition.
//   2. Trim surrounding whitespace.
//   3. Lowercase via the invariant Unicode mapping.

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().toLowerCase();
}

// Permissive syntax check (also mirrored). Rejects obvious malformations but
// leaves deliverability to the verification-link round trip.
export function isValidEmailSyntax(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 254) return false;
  const atIdx = value.indexOf('@');
  if (atIdx < 1 || atIdx !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, atIdx);
  const domain = value.slice(atIdx + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (/\s/.test(value)) return false;
  if (domain.length === 0 || domain.indexOf('.') === -1) return false;
  const labels = domain.split('.');
  if (labels.some(function rejectBadLabel(l) {
    return !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l);
  })) {
    return false;
  }
  if (!/^[A-Za-z0-9._%+\-]+$/.test(local)) return false;
  return true;
}
