const express = require('express');
const path = require('path');

const app = express();
app.disable('x-powered-by');

function splitCspSources(value) {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((source) => source.trim())
    .filter(Boolean);
}

function uniqueSources(sources) {
  return [...new Set(sources.filter(Boolean))];
}

function explicitConnectSources(value) {
  return splitCspSources(value).filter(
    (source) => !['*', 'http:', 'https:', 'ws:', 'wss:'].includes(source)
  );
}

const connectSrc = uniqueSources([
  "'self'",
  // Key-custody pages must not allow arbitrary HTTPS exfiltration. Keep
  // production same-origin by default; deployments that truly need another
  // endpoint can add exact origins via SYSNODE_CSP_CONNECT_SRC.
  ...explicitConnectSources(process.env.SYSNODE_CSP_CONNECT_SRC),
]);

// HSTS is owned in code so any deployer (behind nginx, Caddy, a managed load
// balancer, or directly on a TLS-terminating Node) gets it without having to
// add a duplicate `add_header Strict-Transport-Security` at the edge. Browsers
// ignore HSTS sent over plain HTTP per RFC 6797 §8.1, so emitting
// unconditionally is safe for non-HTTPS local development and matches helmet's
// behaviour on the backend (sysnode-backend uses `helmet()` defaults, which
// emit the same `max-age=31536000; includeSubDomains`). The matching values
// keep the SPA and API consistent for the same browser session.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "img-src 'self' data: https://coin-images.coingecko.com",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

app.use((_req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
});

// Serve the static files from the React app
app.use(express.static(path.join(__dirname, '/build')));

// Handles any requests that don't match the ones above
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '/build/index.html'));
});

const server = app.listen(process.env.PORT || 3000, listen);

// This call back just tells us that the server has started
function listen() {
  const host = server.address().address;
  const port = server.address().port;
  console.log('React app live at http://' + host + ':' + port);
}