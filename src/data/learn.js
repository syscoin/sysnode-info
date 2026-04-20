export const QUICK_FACTS = [
  {
    label: 'Collateral',
    value: '100,000 SYS',
  },
  {
    label: 'Seniority',
    value: 'Reward Incentives',
  },
  {
    label: 'Governance',
    value: 'Funding Builders',
  },
  {
    label: 'Payout Frequency',
    value: 'Every 3-4 days',
  },
];

export const LEARN_CARDS = [
  {
    title: 'What Syscoin is',
    copy:
      'Syscoin is a Bitcoin-powered modular network designed to extend Bitcoin with scalable execution, data availability, and application layers while preserving a security-first foundation.',
  },
  {
    title: 'Sentry Nodes matter',
    copy:
      'Sentry Nodes are incentivized full nodes that strengthen finality, improve network stability, and give long-term operators a direct role in decentralized governance.',
  },
  {
    title: 'What they are not',
    copy:
      'Sentry Nodes are not block producers, not privacy providers, and not a small authority layer the network must trust. They add services on top of Proof-of-Work without replacing it.',
  },
  {
    title: 'Seniority by Design',
    copy:
      'Syscoin rewards consistency. As collateral matures through the 1 Year and 2.5 Year milestones, reward amounts increase and operators are encouraged to stay active for the long term.',
  },
];

export const CORE_ROLES = [
  'Deliver additive finality through multi-quorum chainlocks that help defend the network against 51% attacks and selfish mining.',
  'Reinforce network stability through long-term incentives and a mature operator base.',
  'Enable decentralized governance by allowing Sentry Node owners to vote on proposals for superblock funding.',
  'Preserve independent validation by operating as incentivized full nodes rather than as a trusted shortcut around consensus.',
];

export const REQUIREMENTS = [
  'Operating a Sentry Node requires 100,000 SYS as collateral.',
  'After activation, nodes usually pass through a deterministic qualification period of about one week, depending on network size.',
  'Payment frequency is shaped by how many Sentry Nodes are online. With roughly 2,000 live nodes, payouts are typically around once every three days.',
  'Reward Payouts increase with seniority at 1 year (35%) and 2.5 years (100%).',
];

export const REGISTRY_POINTS = [
  'The authoritative Sentry Node registry lives on Syscoin Core (UTXO), where collateral, ownership, operator details, and seniority are tracked.',
  'Syscoin also provides a read-only NEVM view of that registry so smart contracts and rollups can reference Sentry metadata without a separate indexer.',
  'A NEVM address can only be associated with one Sentry Node at a time, and the node must have already completed three payout rounds before registration.',
];
