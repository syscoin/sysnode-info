# Sysnode

Sysnode is a public dashboard for the Syscoin Sentry Node ecosystem. It gives operators, builders, and community members a clear view of network health, Sentry Node distribution, governance activity, reward context, and SYS market data in one place.

Live site: [sysnode.info](https://sysnode.info/)

## Purpose

Syscoin Sentry Nodes provide an incentivized full-node layer that strengthens network availability, supports decentralized governance, and contributes to finality and resilience across the Syscoin network.

Sysnode is designed to make that information easier to read, easier to verify, and easier to act on. The interface focuses on practical operator context rather than raw data dumps.

## What The Dashboard Shows

- Current Sentry Node count, enabled nodes, locked supply, and ROI range.
- Sentry Node trend data over selectable time ranges.
- Current governance proposals, budgets, support, vote counts, voting deadline, and next superblock.
- Country-level Sentry Node distribution.
- SYS market context including price, volume, market cap, supply, and exchange links.
- Educational pages covering what Sentry Nodes are and how to approach setup.

## Tech Stack

- React 18
- React Router
- Chart.js via `react-chartjs-2`
- Axios
- Create React App build tooling

## Data Source

The frontend reads live dashboard data from the Sysnode backend API. Production is designed for same-origin deployment:

```text
https://sysnode.info/        -> SPA
https://sysnode.info/auth/*  -> backend
https://sysnode.info/vault/* -> backend
https://sysnode.info/gov/*   -> backend
https://sysnode.info/mnstats -> backend
https://sysnode.info/mncount -> backend
https://sysnode.info/govlist -> backend
```

The backend aggregates data from a Syscoin Core node, Sentry Node RPC responses, market APIs, and supporting network datasets. For a fork or private production deployment, keep the same-origin shape and point the reverse proxy at that deployment's backend. This keeps the CSP `connect-src` policy, host-only cookies, and CSRF model in lockstep.

For local or non-production testing, you can override the API base URL while running the dev server:

```bash
REACT_APP_API_BASE=https://your-backend.example npm start
```

The value is read at build time by both `src/lib/apiClient.js` (authenticated surface) and `src/lib/api.js` (anonymous surface — superblock timing, governance feed, masternode stats) outside production. Without it, development requests use `http://localhost:3001`; production requests use same-origin relative paths. Keeping the API under the SPA origin preserves host-only `Secure; SameSite=Lax` cookies and lets the SPA mirror the CSRF cookie into `X-CSRF-Token` without cross-site credentialed fetches.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the site locally:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Build for production:

```bash
npm run build
```

Run tests:

```bash
npm test -- --watchAll=false
```

## Full-stack deployment

The `Deploy production` CI job is restricted to successful pushes on this repo's
exact `master` branch and the branch-restricted GitHub `production` environment.
It uses a new repository-specific forced-command SSH key, never an administrator
key. The existing host independently verifies CI/run/SHA, stages and tests the
commit, and serializes cutovers with backend deployments. See the shared
[host runner and setup policy](https://github.com/syscoin/sysnode-backend/blob/main/deploy/automation/README.md).
No PR/fork receives deployment secrets. The same-origin API, live `.env`, backend,
database and PM2 configuration are preserved; previous frontend artifacts remain
available for code-only rollback.

Environment secrets: `SYSNODE_DEPLOY_KEY`, `SYSNODE_KNOWN_HOSTS`. Environment
variables: `SYSNODE_DEPLOY_HOST`, `SYSNODE_DEPLOY_USER`. Restrict the environment to
`master`, pin the independently verified host key, and test the forced-command
`status` and rejection paths before enabling automatic rollout. The checked-in
client accepts only this repository's push event, exact default ref, SHA, run ID
and attempt. `npm run test:deployment` exercises that boundary.

For a single-host deployment that runs this dashboard alongside the API backend and a Syscoin Core node (mainnet or testnet), see the **Full-stack test deployment** section of the [`sysnode-backend` README](https://github.com/syscoin/sysnode-backend#full-stack-test-deployment-single-host). It covers Node.js setup, Mailpit (open-source SMTP catcher) for verification-email testing, RPC cookie auth against a local `syscoind`, firewall rules, and `pm2` supervision.

## Project Structure

```text
src/
  components/   Shared UI components
  data/         Navigation, exchange, learn, and setup content
  hooks/        Data loading hooks
  lib/          API client and formatting helpers
  pages/        Main dashboard pages
  parts/        Header, footer, and layout parts
```

## Contributing

Community issues and pull requests are welcome. The best contributions keep the dashboard accurate, readable, and useful for real Sentry Node operators.

When contributing:

- Keep UI changes clear and accessible on desktop and mobile.
- Avoid committing generated files such as `build/` or `node_modules/`.
- Keep API response shape changes coordinated with the backend.
- Include tests for formatting, calculations, or data transformation logic where practical.
- Treat governance and operator workflows carefully. Anything related to voting keys, signatures, private keys, or node control should be designed with security review in mind.

## Sentry Node management

`/nodes` manages public watch records by `(network, proTxHash)`. It does not reuse
the voting vault as node-administration authority. Operator, owner and collateral
authorizations stay in Pali. The connected account's public XPUB and change
address are shared with the backend to construct the fee transaction.

Use **Import nodes** for either a reviewed batch of up to 20 public ProTx IDs or
the existing encrypted browser voting-key import. Every invalid, duplicate or
excess line is reported. Existing watch labels are preserved; imports never grant
owner/operator authority. Browser voting keys remain available for phone voting,
and only derived public addresses are used to discover registered nodes.

The governance **Vote** action offers an explicit custody choice: the browser
voting vault, or `sys_signSentryVote` in Pali. The Pali path uses watched node IDs,
not a wallet-key inventory request, and checks a fresh voting context before
requesting approval for up to 20 nodes. Returned compact signatures are verified
against the exact proposal, outcome, time, collateral and registered voting key
before relay. PQ voting remains disabled until supported explicitly. A lost relay
response requires status reconciliation before retrying identical signatures.

Deploy this UI with backend support for atomic `preserveExisting: true` watch
imports and `GET /api/sentry/v1/voting-context`, and with a Pali build exposing the
`governanceVote` capability and `sys_signSentryVote`. Missing support fails closed;
the UI never falls back to overwriting labels or opaque-message signing.

The management API lives at `/api/sentry/v1/` on the same origin. Core capability
metadata selects the legacy or post-quantum codec; unsupported protocol versions
fail closed. NEVM fields distinguish keeping the current value from explicitly
removing the registration. A transaction is only submitted after all required
node authorizations and the separate fee-input signature are complete.

Operation history survives reloads. Use **Resume review** for an unsigned saved
operation or **Check status** for an uncertain submission. No timeout triggers an
automatic replacement or a second publication. Removing a watch record does not
alter the on-chain node. NodeHub hosting is optional and is not a signing authority.

Tests: `npm run test:ci`; `npm run build && npm run test:sentry-browser` runs the
production UI against isolated wallet/API fixtures at 320, 400 and 960px widths.
The separate backend codec tests use real legacy/PQ authorization primitives.

## Security Notes

This frontend should not contain private keys, RPC credentials, server secrets, or privileged voting credentials. Sensitive operations should be handled by secure backend services or wallet flows designed specifically for that purpose.

If you discover a security issue, please avoid opening a public issue with exploit details. Contact the maintainers privately first so it can be reviewed responsibly.

