import { metricFormat, metricNumber, metricText, normalizeNetworkStats, normalizeNodeHistory } from './networkStats';
import { coldNetworkStats, validNetworkStats } from '../testFixtures/networkStats';

describe('network snapshot validation', () => {
  test('rejects the live cold-start zero/NaN/Infinity snapshot', () => {
    const result = normalizeNetworkStats(coldNetworkStats);
    expect(result.stats).toBeNull();
    expect(result.loadedAt).toBeNull();
    expect(Object.values(result.groups).every((group) => group.status === 'unavailable')).toBe(true);
  });

  test('keeps core data when the independent market group is unavailable', () => {
    const payload = validNetworkStats();
    payload.stats_meta.groups.market = { status: 'unavailable', updated_at: null };
    const result = normalizeNetworkStats(payload);
    expect(result.stats.stats.mn_stats.enabled).toBe('3,000');
    expect(result.stats.stats.mn_stats.roi).toBe('3.65%');
    expect(result.stats.stats.price_stats).toBeNull();
    expect(result.stats.stats.mn_stats.masternode_price_usd).toBeNull();
    expect(result.stats.stats.income_stats.usd).toEqual({});
    expect(result.stats.stats.income_stats.sys.daily).toBe('10 SYS');
    expect(result.stats.stats.mn_stats.current_supply).toBeNull();
    expect(result.stats.stats.mn_stats.coins_percent_locked).toBeNull();
  });

  test('an explicitly ready zero-price quote is a real zero, not an outage', () => {
    const payload = validNetworkStats();
    payload.stats.price_stats.price_usd = '0.00';
    payload.stats.price_stats.price_btc = '0.00000000';
    expect(normalizeNetworkStats(payload).groups.market.status).toBe('ready');
    expect(normalizeNetworkStats(payload).stats.stats.price_stats.price_usd).toBe('0.00');
  });

  test('partial ready market data retains each known field without inventing missing values', () => {
    const payload = validNetworkStats();
    payload.stats.price_stats = { price_usd: '0.12', volume_usd: null, market_cap_usd: null };
    const result = normalizeNetworkStats(payload);
    expect(result.groups.market.status).toBe('ready');
    expect(result.stats.stats.price_stats).toEqual({ price_usd: '0.12', volume_usd: null, market_cap_usd: null });
    payload.stats.price_stats = { unknown: 5 };
    expect(normalizeNetworkStats(payload).groups.market.status).toBe('unavailable');
  });

  test('allows a real zero enabled count while suppressing undefined returns', () => {
    const payload = validNetworkStats();
    payload.stats.mn_stats.enabled = '0';
    payload.stats.mn_stats.roi = 'Infinity%';
    const result = normalizeNetworkStats(payload);
    expect(result.stats.stats.mn_stats.enabled).toBe('0');
    expect(result.stats.stats.mn_stats.roi).toBeNull();
    expect(result.stats.stats.income_stats).toBeNull();
    expect(result.groups.node.status).toBe('ready');
  });

  test('retains the original stale observation time rather than HTTP arrival time', () => {
    const now = 1800000000000;
    const payload = validNetworkStats(now - 300000);
    const result = normalizeNetworkStats(payload, now);
    expect(result.groups.chain.status).toBe('stale');
    expect(result.loadedAt.getTime()).toBe(now - 300000);
  });

  test('a new market quote does not refresh the displayed age of stale chain data', () => {
    const now = 1800000000000;
    const payload = validNetworkStats(now - 300000);
    payload.stats_meta.groups.market.updated_at = now;
    const result = normalizeNetworkStats(payload, now);
    expect(result.groups.market.status).toBe('ready');
    expect(result.loadedAt.getTime()).toBe(now - 300000);
  });

  test('invalid historical rows cannot fabricate zero observations or crash charts', () => {
    expect(normalizeNodeHistory([null, { date: 'not-a-date', users: 0 },
      { date: '2026-10-21', users: 'NaN' }, { date: '2026-10-21', users: 0 },
      { date: '2026-10-20', users: '3,123' }]))
      .toEqual([{ date: '2026-10-21', users: 0 }, { date: '2026-10-20', users: 3123 }]);
  });

  test('malformed location entries cannot crash country sorting or produce false counts', () => {
    const payload = validNetworkStats();
    payload.mapData = { USA: null, CAN: { masternodes: 'NaN' }, DEU: { masternodes: '1,234' } };
    expect(normalizeNetworkStats(payload).stats.mapData).toEqual({ DEU: { masternodes: 1234 } });
  });

  test.each([null, 0, 1800000060001])('rejects invalid or future source timestamp %s', (timestamp) => {
    const payload = validNetworkStats(1800000000000);
    payload.stats_meta.groups.node.updated_at = timestamp;
    expect(normalizeNetworkStats(payload, 1800000000000).groups.node.status).toBe('unavailable');
  });

  test('valid legacy snapshots are explicitly freshness-unverified', () => {
    const payload = validNetworkStats();
    delete payload.stats_meta;
    const result = normalizeNetworkStats(payload);
    expect(result.groups.chain.status).toBe('unverified');
    expect(result.loadedAt).toBeNull();
  });

  test('malformed and missing groups cannot be displayed as successful zeros', () => {
    expect(normalizeNetworkStats({}).stats).toBeNull();
    expect(normalizeNetworkStats({ stats: null }).stats).toBeNull();
    expect(normalizeNetworkStats(null).stats).toBeNull();
    const payload = validNetworkStats();
    payload.stats.mn_stats.total = '-1';
    expect(normalizeNetworkStats(payload).groups.node.status).toBe('unavailable');
  });

  test.each([null, undefined, '', 'Infinity%', '$NaN', {}, false, '$', 'SYS', '%'])('does not format unknown value %s as zero', (value) => {
    expect(metricNumber(value)).toBeNull();
    expect(metricFormat(value, String)).toBe('Unavailable');
  });

  test('zero remains a real value; unsafe derived display strings are absent', () => {
    expect(metricFormat('0', String)).toBe('0');
    expect(metricText('Infinity SYS')).toBe('Unavailable');
    expect(metricText('$NaN')).toBe('Unavailable');
    expect(metricText({})).toBe('Unavailable');
  });
});
