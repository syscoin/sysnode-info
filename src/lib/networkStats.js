import { parseUtcDateValue } from './formatters';

// The public dashboard must distinguish an absent observation from a real zero.
// Keep this validation local to network metrics; other wallet/count formatters
// intentionally have different fallback semantics.
export function metricNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const cleaned = typeof value === 'string'
    ? value.replace(/[$,%]/g, '').replace(/\s*(?:SYS|BTC)\s*$/i, '').trim()
    : value;
  if (cleaned === '') return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

const count = (value) => {
  const number = metricNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const positive = (value) => {
  const number = metricNumber(value);
  return number !== null && number > 0;
};
const nonnegative = (value) => {
  const number = metricNumber(value);
  return number !== null && number >= 0;
};
const MARKET_FIELDS = ['price_usd', 'price_btc', 'circulating_supply', 'total_supply',
  'volume_usd', 'volume_btc', 'market_cap_usd', 'market_cap_btc', 'price_change'];

export function hasFreshStatsGroups(payload, names, nowMs = Date.now()) {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'stats_meta')) return true;
  const groups = payload.stats_meta && payload.stats_meta.groups;
  return !!groups && names.every((name) => {
    const group = groups[name];
    const updatedAt = metricNumber(group && group.updated_at);
    return group && group.status === 'ready' && updatedAt !== null && updatedAt > 0 &&
      updatedAt <= nowMs + 60000 && nowMs - updatedAt <= 120000;
  });
}

function numericFields(group) {
  if (!group || typeof group !== 'object') return null;
  return Object.fromEntries(Object.entries(group).map(([key, value]) => [
    key,
    metricNumber(value) === null ? null : value,
  ]));
}

function incomeFields(group) {
  if (!group || typeof group !== 'object') return null;
  return Object.fromEntries(['usd', 'btc', 'sys'].map((currency) => [
    currency, numericFields(group[currency]) || {},
  ]));
}

function normalizeMapData(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).flatMap(([country, entry]) => {
    const nodes = entry && typeof entry === 'object' ? count(entry.masternodes) : null;
    return nodes === null ? [] : [[country, { ...entry, masternodes: nodes }]];
  }));
}

export function normalizeNetworkStats(payload, now = Date.now()) {
  const raw = payload && payload.stats && typeof payload.stats === 'object' ? payload.stats : {};
  const metadata = payload && Object.prototype.hasOwnProperty.call(payload, 'stats_meta')
    ? payload.stats_meta?.groups || {} : null;
  const chain = raw.blockchain_stats;
  const node = raw.mn_stats;
  const governance = raw.superblock_stats;
  const market = raw.price_stats;
  const valid = {
    chain: !!chain && positive(chain.connections) && positive(chain.version),
    node: !!node && count(node.total) !== null && count(node.enabled) !== null &&
      count(node.pose_banned) !== null && count(node.enabled) <= count(node.total) &&
      nonnegative(node.total_locked),
    governance: !!governance && positive(governance.superblock_next_epoch_sec) &&
      !!parseUtcDateValue(governance.superblock_date),
    market: !!market && (metadata
      ? MARKET_FIELDS.some((key) => key === 'price_change'
        ? metricNumber(market[key]) !== null : nonnegative(market[key]))
      : positive(market.price_usd) && nonnegative(market.volume_usd) && nonnegative(market.market_cap_usd)),
  };
  // Older servers have no health metadata. Require a real chain observation,
  // not the cold-start all-zero object, before showing their derived metrics.
  if (!metadata && !valid.chain) valid.node = false;
  const groups = {};
  for (const name of Object.keys(valid)) {
    const observation = metadata && metadata[name];
    const updatedAt = metricNumber(observation && observation.updated_at);
    const timestampValid = updatedAt !== null && updatedAt > 0 && updatedAt <= now + 60000;
    const explicitStatus = observation && observation.status;
    const available = valid[name] && (!metadata || (
      timestampValid && (explicitStatus === 'ready' || explicitStatus === 'stale')
    ));
    groups[name] = {
      status: !available ? 'unavailable' : metadata
        ? (explicitStatus === 'ready' && now - updatedAt > 120000 ? 'stale' : explicitStatus)
        : 'unverified',
      updatedAt: available && timestampValid ? updatedAt : null,
    };
  }
  const available = (name) => groups[name].status !== 'unavailable';
  const sanitizedNode = available('node') ? { ...node } : null;
  if (sanitizedNode) {
    for (const key of ['roi', 'roi_one', 'roi_two', 'coins_percent_locked',
      'masternode_price_usd', 'masternode_price_btc']) {
      sanitizedNode[key] = metricNumber(node[key]) === null ? null : node[key];
    }
    if (count(node.enabled) === 0) {
      sanitizedNode.roi = sanitizedNode.roi_one = sanitizedNode.roi_two = null;
      sanitizedNode.payout_frequency = null;
    }
    if (!available('market')) {
      sanitizedNode.masternode_price_usd = sanitizedNode.masternode_price_btc = null;
      sanitizedNode.current_supply = sanitizedNode.coins_percent_locked = null;
    }
  }
  const sanitized = {
    mn_stats: sanitizedNode,
    blockchain_stats: available('chain') ? chain : null,
    superblock_stats: available('governance') ? governance : null,
    price_stats: available('market') ? numericFields(market) : null,
  };
  for (const key of ['income_stats', 'income_stats_seniority_one_year', 'income_stats_seniority_two_year']) {
    sanitized[key] = available('node') && count(node.enabled) > 0 ? incomeFields(raw[key]) : null;
    if (sanitized[key] && !available('market')) {
      sanitized[key].usd = {};
      sanitized[key].btc = {};
    }
  }
  const timestamps = Object.values(groups).map((group) => group.updatedAt).filter(Boolean);
  return {
    groups,
    // A fresh market quote must not make an older chain observation look new.
    loadedAt: timestamps.length ? new Date(Math.min(...timestamps)) : null,
    stats: Object.values(groups).some((group) => group.status !== 'unavailable')
      ? { ...payload, stats: sanitized, mapData: available('node') ? normalizeMapData(payload.mapData) : {} }
      : null,
  };
}

export function normalizeNodeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry) => entry && count(entry.users) !== null &&
    Number.isFinite(Date.parse(entry.date)) ? [{ ...entry, users: count(entry.users) }] : []);
}

export function metricText(value) {
  return !['number', 'string'].includes(typeof value) || value === '' || /(?:NaN|Infinity)/.test(String(value))
    ? 'Unavailable' : value;
}

export function metricFormat(value, formatter, ...args) {
  const number = metricNumber(value);
  return number === null ? 'Unavailable' : formatter(number, ...args);
}

export function metricDate(value, formatter) {
  return ['number', 'string'].includes(typeof value) && parseUtcDateValue(value)
    ? formatter(value) : 'Unavailable';
}
