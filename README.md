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

The frontend reads live dashboard data from the Sysnode backend API. The default production build targets:

```text
https://syscoin.dev
```

The backend aggregates data from a Syscoin Core node, Sentry Node RPC responses, market APIs, and supporting network datasets. For a fork or private deployment, override the API base URL at build time (no code change required):

```bash
REACT_APP_API_BASE=https://your-backend.example npm run build
```

The value is read at build time by both `src/lib/apiClient.js` (authenticated surface) and `src/lib/api.js` (anonymous surface — superblock timing, governance feed, masternode stats); without it, development builds use `http://localhost:3001` and production builds use `https://syscoin.dev`. Keeping both clients on the same override means `REACT_APP_API_BASE` retargets the entire app in a single build.

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

## Security Notes

This frontend should not contain private keys, RPC credentials, server secrets, or privileged voting credentials. Sensitive operations should be handled by secure backend services or wallet flows designed specifically for that purpose.

If you discover a security issue, please avoid opening a public issue with exploit details. Contact the maintainers privately first so it can be reviewed responsibly.

