export const coldNetworkStats = {
  stats: {
    mn_stats: { total: '0', enabled: '0', pose_banned: '0', total_locked: '0.00',
      coins_percent_locked: 'NaN%', current_supply: '0.00', collateral_req: '100,000',
      roi: 'Infinity%', roi_one: 'Infinity%', roi_two: 'Infinity%', payout_frequency: '0ms' },
    price_stats: { price_usd: '0.0000', volume_usd: '0.00', market_cap_usd: '0.00' },
    blockchain_stats: { version: 0, connections: '0', genesis: 0, avg_block: '0ms' },
    superblock_stats: { superblock_date: 0, superblock_next_epoch_sec: 0, next_superblock: 'SB0 - 0' },
    income_stats: { usd: { daily: '$NaN' }, sys: { daily: 'Infinity SYS' } },
  },
  mapData: { DEU: { masternodes: 120 } },
};

export function validNetworkStats(now = Date.now()) {
  const income = { usd: { daily: '$1.00', monthly: '$30.00', yearly: '$365.00' },
    sys: { daily: '10 SYS', monthly: '300 SYS', yearly: '3,650 SYS' } };
  return {
    stats_meta: { groups: Object.fromEntries(['chain', 'node', 'governance', 'market'].map((name) =>
      [name, { status: 'ready', updated_at: now }])) },
    stats: {
      mn_stats: { total: '3,123', enabled: '3,000', pose_banned: '123', total_locked: '300,000,000',
        coins_percent_locked: '37.50%', current_supply: '800,000,000', collateral_req: '100,000',
        roi: '3.65%', roi_one: '4.56%', roi_two: '4.92%', payout_frequency: '2 days',
        masternode_price_usd: '$10,000', masternode_price_btc: '0.1 BTC' },
      price_stats: { price_usd: '0.1', price_btc: '0.000001', volume_usd: '100000',
        market_cap_usd: '80000000', circulating_supply: '800000000', price_change: '-1.25%' },
      blockchain_stats: { version: 320000, connections: '2,100,000', protocol: 70016,
        sub_version: '/Syscoin/', genesis: '2018-01-01', avg_block: '2 minutes' },
      superblock_stats: { superblock_date: 'October 30th 2026, 1:00:00 pm',
        superblock_next_epoch_sec: Math.floor(now / 1000) + 86400, next_superblock: 'SB 42' },
      income_stats: income, income_stats_seniority_one_year: income, income_stats_seniority_two_year: income,
    },
    mapData: { DEU: { masternodes: 120 } },
  };
}
