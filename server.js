const express = require('express');
const path = require('path');

const app = express();
app.disable('x-powered-by');

function originFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch (_err) {
    return null;
  }
}

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

const connectSrc = uniqueSources([
  "'self'",
  'https://syscoin.dev',
  originFromUrl(process.env.REACT_APP_API_BASE),
  ...splitCspSources(process.env.SYSNODE_CSP_CONNECT_SRC),
]);

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