// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom/extend-expect';

// Bump jest's default 5s test timeout to 20s. The auth/vault crypto
// layer runs real PBKDF2 (600k SHA-512 iterations) in jsdom, so a
// single unlock / derive cycle can take a couple of seconds under
// load — and when multiple jest workers contend for the host CPU
// (CI or a developer laptop doing anything else), the default
// timeout is dramatically under-spec. Individual tests that need
// more time still raise it locally; this is the baseline.
jest.setTimeout(20000);

// TextEncoder / TextDecoder polyfill:
// jsdom 16 (bundled with react-scripts 5) doesn't expose these as globals.
// The auth/vault crypto layer needs them for UTF-8 <-> bytes round-trips.
// Node 20+ ships them on `util`; aliasing to globalThis is safe and matches
// the browser contract.
const nodeUtil = require('util');
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = nodeUtil.TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = nodeUtil.TextDecoder;
}

// WebCrypto polyfill for jsdom:
// The auth + vault layer relies on `globalThis.crypto.subtle` (PBKDF2, HKDF,
// AES-GCM). jsdom ships a partial `crypto` stub without `subtle`, so we
// expose Node 20+'s webcrypto implementation on `globalThis.crypto`. Using
// `Object.defineProperty` avoids "Cannot redefine property" errors from the
// jsdom-provided getter while preserving the live value everywhere our
// modules reference it.
const nodeCrypto = require('crypto');
if (
  nodeCrypto.webcrypto &&
  (!globalThis.crypto || !globalThis.crypto.subtle)
) {
  Object.defineProperty(globalThis, 'crypto', {
    value: nodeCrypto.webcrypto,
    configurable: true,
    writable: true,
  });
}
