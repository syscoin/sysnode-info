'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

test('the actual production server keeps static routes, same-origin CSP and untrusted forwarding headers', async () => {
  const root = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-static-runtime-'));
  fs.mkdirSync(path.join(fixture, 'build'));
  fs.writeFileSync(path.join(fixture, 'build/index.html'), '<!doctype html><title>Static runtime fixture</title>');
  fs.writeFileSync(path.join(fixture, 'build/asset.txt'), 'fixture asset');
  const actualRequire = createRequire(path.join(root, 'server.js'));
  const actualExpress = actualRequire('express');
  let app;
  let server;
  const express = Object.assign(() => {
    app = actualExpress();
    const listen = app.listen;
    // Only the listening address is test-specific; execute the unchanged
    // production middleware/routes against real Express and HTTP requests.
    app.listen = (port, callback) => {
      server = listen.call(app, port, '127.0.0.1', callback);
      return server;
    };
    return app;
  }, actualExpress);
  try {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
      require: (name) => name === 'express' ? express : actualRequire(name),
      __dirname: fixture,
      process: { env: { PORT: '0' } },
      console: { log() {} },
    }, { filename: 'server.js' });
    await once(server, 'listening');
    assert.equal(app.get('trust proxy'), false);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/nodes`, {
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'attacker.example' },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Static runtime fixture/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'(;|$)/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    const asset = await fetch(`${origin}/asset.txt`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'fixture asset');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('proxy-addr does not treat an IPv4-mapped short subnet as every IPv4 address', () => {
  const trust = require('proxy-addr').compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.7'), false);
});

test('form-data escapes control characters in multipart field names', () => {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('email"\r\nX-QA-Injected: yes\r\nfield="', 'test@example.invalid');
  const body = form.getBuffer().toString('utf8');
  assert.equal(body.includes('\r\nX-QA-Injected:'), false);
  assert.match(body, /%0D%0A/);
});

test('axios ignores an inherited parseReviver when decoding JSON responses', async () => {
  const axios = require('axios');
  const client = axios.create({
    adapter: async (config) => ({ data: '{"verified":true}', status: 200, statusText: 'OK', headers: {}, config }),
  });
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'parseReviver');
  try {
    Object.defineProperty(Object.prototype, 'parseReviver', {
      configurable: true,
      value: (key, value) => key === 'verified' ? false : value,
    });
    const response = await client.get('/auth/me');
    assert.deepEqual(response.data, { verified: true });
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'parseReviver', previous);
    else delete Object.prototype.parseReviver;
  }
});
