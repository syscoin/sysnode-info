const nowSec = Math.floor(Date.now() / 1000);
const daySec = 24 * 60 * 60;

const nextVotingDeadlineSec = nowSec + 4 * daySec + 2 * 60 * 60 + 9 * 60;
const nextSuperblockSec = nowSec + 7 * daySec + 2 * 60 * 60 + 13 * 60;
const nextVotingDeadlineIso = new Date(nextVotingDeadlineSec * 1000).toISOString();
const nextSuperblockIso = new Date(nextSuperblockSec * 1000).toISOString();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatUtcClock(epochSec) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  }).format(new Date(epochSec * 1000));
}

function makeHistory(days, startUsers, dailyStep) {
  return Array.from({ length: days }, function buildEntry(_, index) {
    const dayOffset = days - index - 1;
    const epochMs = (nowSec - dayOffset * daySec) * 1000;
    const cycle = Math.sin(index / 8) * 18;
    const drift = (index % 11) - 5;

    return {
      date: new Date(epochMs).toISOString(),
      users: Math.round(startUsers + index * dailyStep + cycle + drift),
    };
  });
}

function makeProposal({
  key,
  name,
  title,
  absoluteYesCount,
  yesCount,
  noCount,
  paymentAmount,
  createdDaysAgo,
  startDaysAgo,
  endDaysFromNow,
  url,
}) {
  return {
    AbsoluteYesCount: absoluteYesCount,
    CreationTime: nowSec - createdDaysAgo * daySec,
    Hash: key,
    Key: key,
    NoCount: noCount,
    ObectType: 1,
    YesCount: yesCount,
    end_epoch: nowSec + endDaysFromNow * daySec,
    fCachedDelete: false,
    name,
    payment_amount: paymentAmount,
    start_epoch: nowSec - startDaysAgo * daySec,
    title,
    url,
  };
}

export const MOCK_API_LATENCY_MS = 180;

export const mockNetworkStats = {
  stats: {
    blockchain_stats: {
      avg_block: '2.5 min',
      connections: 2365400,
      genesis: '2014-08-16T00:00:00Z',
      protocol: '70931',
      sub_version: '/SyscoinCore:4.4.2/',
      version: '4.4.2',
    },
    income_stats: {
      sys: {
        daily: '21.4 SYS',
        monthly: '652 SYS',
        yearly: '7,823 SYS',
      },
      usd: {
        daily: '$1.87',
        monthly: '$56.83',
        yearly: '$682',
      },
    },
    income_stats_seniority_one_year: {
      sys: {
        daily: '23.6 SYS',
        monthly: '719 SYS',
        yearly: '8,626 SYS',
      },
      usd: {
        daily: '$2.06',
        monthly: '$62.69',
        yearly: '$752',
      },
    },
    income_stats_seniority_two_year: {
      sys: {
        daily: '25.8 SYS',
        monthly: '786 SYS',
        yearly: '9,435 SYS',
      },
      usd: {
        daily: '$2.25',
        monthly: '$68.53',
        yearly: '$822',
      },
    },
    mn_stats: {
      coins_percent_locked: 31.77,
      collateral_req: 100000,
      current_supply: 750500000,
      enabled: 2384,
      masternode_price_usd: 8725,
      payout_frequency: 'every 10.7 days',
      pose_banned: 62,
      roi: '7.82%',
      roi_one: '8.61%',
      roi_two: '9.48%',
      total: 2446,
      total_locked: 238400000,
    },
    price_stats: {
      circulating_supply: 749500000,
      market_cap_usd: 65390000,
      price_btc: 0.00000124,
      price_change: 3.42,
      price_usd: 0.08725,
      volume_usd: 1986500,
    },
    superblock_stats: {
      budget: 76543,
      next_superblock: `${formatUtcClock(nextSuperblockSec)} (UTC)`,
      superblock_date: nextSuperblockIso,
      superblock_next_epoch_sec: nextSuperblockSec,
      voting_deadline: nextVotingDeadlineIso,
    },
  },
  mapData: {
    USA: { masternodes: 482 },
    DEU: { masternodes: 341 },
    NLD: { masternodes: 260 },
    SGP: { masternodes: 228 },
    CAN: { masternodes: 216 },
    FIN: { masternodes: 182 },
    FRA: { masternodes: 171 },
    GBR: { masternodes: 160 },
    SWE: { masternodes: 146 },
    LTU: { masternodes: 120 },
    POL: { masternodes: 78 },
  },
};

export const mockNodeHistory = makeHistory(220, 2142, 1.05);

export const mockGovernanceFeed = [
  makeProposal({
    key: 'a1'.repeat(32),
    name: 'SMT',
    title: 'Scaling the Ecosystem',
    absoluteYesCount: 462,
    yesCount: 478,
    noCount: 16,
    paymentAmount: 12000,
    createdDaysAgo: 110,
    startDaysAgo: 12,
    endDaysFromNow: 48,
    url: 'https://syscoin.org/news',
  }),
  makeProposal({
    key: 'b2'.repeat(32),
    name: 'Foundation',
    title: 'Budget Proposal',
    absoluteYesCount: 388,
    yesCount: 406,
    noCount: 18,
    paymentAmount: 18000,
    createdDaysAgo: 96,
    startDaysAgo: 10,
    endDaysFromNow: 44,
    url: 'https://syscoin.org',
  }),
  makeProposal({
    key: 'c3'.repeat(32),
    name: 'Lunos',
    title: 'R&D for Compliance-First Edge-Chain on zkSys',
    absoluteYesCount: 341,
    yesCount: 356,
    noCount: 15,
    paymentAmount: 22000,
    createdDaysAgo: 138,
    startDaysAgo: 9,
    endDaysFromNow: 43,
    url: 'https://syscoin.org',
  }),
  makeProposal({
    key: 'd4'.repeat(32),
    name: 'Core Contributors',
    title: 'Developer Tooling Sprint',
    absoluteYesCount: 248,
    yesCount: 259,
    noCount: 11,
    paymentAmount: 30000,
    createdDaysAgo: 64,
    startDaysAgo: 7,
    endDaysFromNow: 37,
    url: 'https://syscoin.org',
  }),
  makeProposal({
    key: 'e5'.repeat(32),
    name: 'Syscoin Growth',
    title: 'Exchange Liquidity Program',
    absoluteYesCount: 205,
    yesCount: 213,
    noCount: 8,
    paymentAmount: 15000,
    createdDaysAgo: 52,
    startDaysAgo: 6,
    endDaysFromNow: 31,
    url: 'https://syscoin.org',
  }),
  makeProposal({
    key: 'f6'.repeat(32),
    name: 'Community DAO',
    title: 'Regional Community Events',
    absoluteYesCount: 129,
    yesCount: 142,
    noCount: 13,
    paymentAmount: 8000,
    createdDaysAgo: 40,
    startDaysAgo: 4,
    endDaysFromNow: 28,
    url: 'https://syscoin.org',
  }),
];

export function getMockNetworkStats() {
  return clone(mockNetworkStats);
}

export function getMockNodeHistory() {
  return clone(mockNodeHistory);
}

export function getMockGovernanceFeed() {
  return clone(mockGovernanceFeed);
}
