'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { inputs } = require('../scripts/request-deploy.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'syscoin/sysnode-info', GITHUB_REF: 'refs/heads/master', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', SYSNODE_DEPLOY_HOST: '62.238.27.161', SYSNODE_DEPLOY_USER: 'ubuntu', SYSNODE_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-only', SYSNODE_KNOWN_HOSTS: 'host ssh-ed25519 synthetic' };
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
