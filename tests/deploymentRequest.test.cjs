'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { inputs, privateKeyText } = require('../scripts/request-deploy.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'syscoin/sysnode-info', GITHUB_REF: 'refs/heads/master', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', SYSNODE_DEPLOY_HOST: '62.238.27.161', SYSNODE_DEPLOY_USER: 'ubuntu', SYSNODE_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-only\n-----END OPENSSH PRIVATE KEY-----', SYSNODE_KNOWN_HOSTS: 'host ssh-ed25519 synthetic' };
test('real OpenSSH key parses after final-LF and CRLF secret normalization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-key-format-'));
  fs.chmodSync(root, 0o700);
  try {
    const original = path.join(root, 'generated');
    cp.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', original], { stdio: 'ignore' });
    const source = fs.readFileSync(original, 'utf8');
    const expectedPublic = cp.execFileSync('ssh-keygen', ['-y', '-f', original], { encoding: 'utf8' });
    for (const variant of [source, source.trimEnd(), source.replace(/\n/g, '\r\n'), source.trimEnd().replace(/\n/g, '\r\n')]) {
      const normalized = path.join(root, 'normalized');
      fs.writeFileSync(normalized, privateKeyText(variant), { mode: 0o600 });
      const parsedPublic = cp.execFileSync('ssh-keygen', ['-y', '-f', normalized], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(parsedPublic, expectedPublic);
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('deploy request is fixed to this repository default-branch push and run attempt', () => {
  assert.equal(inputs('frontend', env).command, `deploy ${sha} 123 2`);
  for (const mutation of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SERVER_URL: 'https://other.invalid' }, { GITHUB_RUN_ID: '123\n' }, { GITHUB_SHA: 'a'.repeat(39) }]) assert.throws(() => inputs('frontend', { ...env, ...mutation }));
});
test('SSH destination cannot become an option or remote command', () => {
  for (const mutation of [{ SYSNODE_DEPLOY_HOST: '-oProxyCommand=bad' }, { SYSNODE_DEPLOY_HOST: 'host;id' }, { SYSNODE_DEPLOY_USER: 'ubuntu;id' }, { SYSNODE_DEPLOY_KEY: '' }, { SYSNODE_KNOWN_HOSTS: '' }]) assert.throws(() => inputs('frontend', { ...env, ...mutation }));
});
test('workflow keeps all CI gates before production and never cancels default-branch deploys', () => {
  const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  assert.match(text, /name: Deploy production/); assert.match(text, /needs: \[test\]/); assert.match(text, /environment: production/);
  assert.match(text, /github.event_name == 'push'.*github.repository == 'syscoin\/sysnode-info'.*github.ref == 'refs\/heads\/master'/);
  assert.match(text, /persist-credentials: false/); assert.match(text, /ref: \$\{\{ github.sha \}\}/);
});
