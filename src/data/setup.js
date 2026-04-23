import { EXTERNAL_LINKS } from './navigation';

export const SNAPSHOT = [
  {
    label: 'Collateral',
    value: '100,000 SYS',
  },
  {
    label: 'Server Requirements',
    value: '2 cores / 4GB / 80GB',
  },
  {
    label: 'Reward Frequency',
    value: 'Every 3-4 days',
  },
  {
    label: 'ROI',
    value: '5-11%',
  },
];

export const PRE_FLIGHT = [
  'Prepare exactly 100,000 SYS for each Sentry Node you want to register.',
  'If you are preserving an existing node seniority position, lock the current collateral output instead of moving funds to a new transaction.',
  'Keep owner, voting, payout, and fee addresses organized before you start the registration flow.',
  'For self-hosted nodes, deploy a fresh Ubuntu VPS and match the current official guide before choosing an image.',
];

export const HOSTING_MODEL = [
  'Self-host if you want full control over the server, updates, logs, and recovery process.',
  'Use a managed host if you want guided onboarding and less day-to-day infrastructure work.',
  'If you use a hosting provider, parts of the operator key flow may change. Some providers will ask for or supply the BLS public key as part of onboarding.',
  'The collateral, owner, voting, and payout side still matters either way, so do not treat hosting as a substitute for understanding the registration flow.',
];

export const PROVIDERS = [
  {
    eyebrow: 'Managed Host',
    title: 'Allnodes',
    copy:
      'Allnodes has a dedicated Syscoin hosting path. Their current guide says Syscoin nodes are hosted with the Syscoin QT wallet, require 100,000 SYS in a single transaction, and continue from the /sys/host onboarding flow.',
    bullets: [
      'A good fit if you want a guided setup path without maintaining the VPS yourself.',
      'Review current pricing, support coverage, and uptime terms directly with Allnodes before funding a node.',
    ],
    links: [
      {
        href: 'https://www.allnodes.com/sys/host',
        label: 'Allnodes',
        primary: true,
      },
      {
        href: 'https://docs.allnodes.com/nodes/hosting-a-syscoin-masternode-hosted-on-allnodes',
        label: 'Docs',
      },
    ],
  },
  {
    eyebrow: 'Managed Host',
    title: 'NodeHub',
    copy:
      'NodeHub positions itself as infrastructure for sentry nodes and validators, with an account-based platform and API-driven workflows. It is worth evaluating if you prefer a hosted platform model over running your own server.',
    bullets: [
      'Verify current Syscoin availability, pricing, and onboarding steps directly with NodeHub before deploying.',
      'Best treated as a provider to compare alongside Allnodes and self-hosting, rather than as the default path.',
    ],
    links: [
      {
        href: 'https://nodehub.io/',
        label: 'NodeHub',
        primary: true,
      },
      {
        href: 'https://docs.nodehub.io/',
        label: 'Docs',
      },
    ],
  },
  {
    eyebrow: 'Self-host',
    title: 'Bring your own VPS',
    copy:
      'The current Syscoin support guide encourages operators to shop around across VPS providers rather than relying on one recommended host. This route gives you the most control over your Sentry Node.',
    bullets: [
      'The official guide currently names IONOS, OVH, Leaseweb, Hostinger, and InterServer as examples worth checking.',
      'Use a fresh image, stable networking, and hardware that meets or exceeds the current baseline before you begin installation.',
    ],
    links: [
      {
        href: EXTERNAL_LINKS.docs,
        label: 'Setup Guide',
        primary: true,
      },
      {
        href: EXTERNAL_LINKS.support,
        label: 'Support',
      },
    ],
  },
];

export const RESOURCE_LINKS = [
  {
    href: EXTERNAL_LINKS.docs,
    label: 'Official Setup Guide',
    primary: true,
  },
  {
    href: EXTERNAL_LINKS.sentryNodeDocs,
    label: 'Sentry Node Docs',
  },
  {
    href: EXTERNAL_LINKS.wallets,
    label: 'Syscoin Wallets',
  },
  {
    href: EXTERNAL_LINKS.support,
    label: 'Syscoin Support',
  },
];
