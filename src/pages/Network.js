import React from 'react';

import BreakdownChart from '../components/BreakdownChart';
import CountryList from '../components/CountryList';
import DataState from '../components/DataState';
import DefinitionGrid from '../components/DefinitionGrid';
import PageMeta from '../components/PageMeta';
import TrendChart from '../components/TrendChart';
import useNetworkData from '../hooks/useNetworkData';
import {
  formatCurrency,
  formatDayMonth,
  formatLongDate,
  formatNumber,
  formatPercent,
  formatToken,
  parseNumber,
} from '../lib/formatters';

function IncomeTierCard(props) {
  return (
    <article className="tier-card">
      <div className="tier-card__header">
        <span>{props.label}</span>
        <strong>{props.roi}</strong>
      </div>
      <div className="tier-card__values">
        <div>
          <span>Yearly</span>
          <strong>{props.yearlyUsd}</strong>
          <small>{props.yearlySys}</small>
        </div>
        <div>
          <span>Monthly</span>
          <strong>{props.monthlyUsd}</strong>
          <small>{props.monthlySys}</small>
        </div>
        <div>
          <span>Daily</span>
          <strong>{props.dailyUsd}</strong>
          <small>{props.dailySys}</small>
        </div>
      </div>
    </article>
  );
}

export default function Network() {
  const { loading, error, history, stats } = useNetworkData();
  const networkStats = stats && stats.stats ? stats.stats.mn_stats : null;
  const incomeStats = stats && stats.stats ? stats.stats.income_stats : null;
  const oneYearIncome =
    stats && stats.stats ? stats.stats.income_stats_seniority_one_year : null;
  const longTermIncome =
    stats && stats.stats ? stats.stats.income_stats_seniority_two_year : null;
  const priceStats = stats && stats.stats ? stats.stats.price_stats : null;
  const blockchainStats = stats && stats.stats ? stats.stats.blockchain_stats : null;
  const superblockStats = stats && stats.stats ? stats.stats.superblock_stats : null;
  const enabledCount = parseNumber(networkStats && networkStats.enabled);
  const bannedCount = parseNumber(networkStats && networkStats.pose_banned);
  const lockedSupply = parseNumber(networkStats && networkStats.total_locked);
  const currentSupply = parseNumber(networkStats && networkStats.current_supply);
  const remainingSupply = Math.max(currentSupply - lockedSupply, 0);
  const topCountries = Object.entries(stats && stats.mapData ? stats.mapData : {})
    .sort(function sortCountries(a, b) {
      return Number(b[1].masternodes || 0) - Number(a[1].masternodes || 0);
    })
    .slice(0, 8);

  const priceBtcValue = parseNumber(priceStats && priceStats.price_btc);
  const readablePriceBtc = priceBtcValue > 0 ? `${priceBtcValue.toFixed(8)} BTC` : 'Unavailable';
  const networkHeroCards = networkStats
    ? [
        {
          label: 'Total Nodes',
          value: formatNumber(parseNumber(networkStats.total)),
        },
        {
          label: 'Enabled Nodes',
          value: formatNumber(enabledCount),
        },
        {
          label: 'Locked Supply',
          value: formatPercent(networkStats.coins_percent_locked, 2),
        },
        {
          label: 'ROI',
          value: `${networkStats.roi}-${networkStats.roi_two}`,
        },
        {
          label: 'Payout Frequency',
          value: networkStats.payout_frequency,
        },
        {
          label: 'Next Superblock',
          value: superblockStats ? formatDayMonth(superblockStats.superblock_date) : 'Loading...',
        },
      ]
    : [];
  const marketItems =
    priceStats && networkStats
      ? [
          {
            label: 'SYS price',
            value: formatCurrency(parseNumber(priceStats.price_usd)),
          },
          {
            label: 'SYS / BTC',
            value: readablePriceBtc,
          },
          {
            label: '24h Volume',
            value: formatCurrency(parseNumber(priceStats.volume_usd)),
          },
          {
            label: 'Market Cap',
            value: formatCurrency(parseNumber(priceStats.market_cap_usd)),
          },
          {
            label: '24h Change',
            value: formatPercent(priceStats.price_change, 2),
          },
          {
            label: 'Circulating Supply',
            value: formatToken(priceStats.circulating_supply, 'SYS', 0),
          },
        ]
      : [];
  const chainItems = blockchainStats
    ? [
        {
          label: 'Current Block Height',
          value: formatNumber(parseNumber(blockchainStats.connections)),
        },
        {
          label: 'Average Block Time',
          value: blockchainStats.avg_block,
        },
        {
          label: 'Version',
          value: blockchainStats.version,
        },
        {
          label: 'Sub-version',
          value: blockchainStats.sub_version,
        },
        {
          label: 'Protocol',
          value: blockchainStats.protocol,
        },
        {
          label: 'Genesis Block',
          value: formatLongDate(blockchainStats.genesis),
        },
      ]
    : [];

  return (
    <main className="page-main">
      <PageMeta
        title="Network"
        description="Live Syscoin Sentry Node metrics, reward tiers, locked supply, chain info, market context, and node geography."
      />

      <section className="page-hero page-hero--network">
        <div className="site-wrap page-hero__layout page-hero__layout--network">
          <div>
            <p className="eyebrow">Syscoin Sentry Node Dashboard </p>
            <h1>See the Syscoin network at a glance.</h1>
            <p className="page-hero__copy">
              Track node count, locked supply, rewards, price, and the next chain info in one place.
            </p>
          </div>

          <div className="page-hero__summary page-hero__summary--network">
            {networkHeroCards.map(function renderCard(card) {
              return (
                <div key={card.label} className="summary-card">
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="page-section page-section--tight">
        <div className="site-wrap">
          <DataState
            error={error}
            loading={loading && !stats}
            loadingMessage="Loading the live dashboard..."
          />
        </div>
      </section>

      {stats ? (
        <section className="page-section page-section--tight">
          <div className="site-wrap dashboard-grid dashboard-grid--feature">
            <TrendChart
              defaultRange="7d"
              eyebrow="Sentry Nodes Over Time"
              title="Node count trend"
              historyData={history}
            />

            <aside className="panel stack-panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Sentry Node Stats</p>
                </div>
              </div>

              <div className="metric-stack">
                <div className="metric-stack__item">
                  <span>Base ROI</span>
                  <strong>{networkStats.roi}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>1 Year Seniority ROI</span>
                  <strong>{networkStats.roi_one}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>2.5 Year Seniority ROI</span>
                  <strong>{networkStats.roi_two}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Payout Frequency</span>
                  <strong>{networkStats.payout_frequency}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Locked Supply</span>
                  <strong>{formatPercent(networkStats.coins_percent_locked, 2)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Sentry Node Price</span>
                  <strong>{formatCurrency(parseNumber(networkStats.masternode_price_usd))}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Next Superblock</span>
                  <strong>{formatDayMonth(superblockStats.superblock_date)}</strong>
                </div>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      {stats ? (
        <section className="page-section">
          <div className="site-wrap dashboard-grid dashboard-grid--split">
            <BreakdownChart
              eyebrow="Syscoin Sentry Node Status"
              title="Node status mix"
              centerValue={formatNumber(enabledCount)}
              centerLabel="enabled nodes"
              items={[
                {
                  label: 'Enabled',
                  value: enabledCount,
                  valueLabel: `${formatNumber(enabledCount)} nodes`,
                  color: '#1e78ff',
                },
                {
                  label: 'PoSe Banned',
                  value: bannedCount,
                  valueLabel: `${formatNumber(bannedCount)} nodes`,
                  color: '#e56b55',
                },
              ]}
            />

            <BreakdownChart
              eyebrow="Syscoin Sentry Node TVL"
              title="Locked supply mix"
              centerValue={formatPercent(networkStats.coins_percent_locked, 2)}
              centerLabel="of current supply locked"
              items={[
                {
                  label: 'Locked Supply',
                  value: lockedSupply,
                  valueLabel: formatToken(lockedSupply, 'SYS', 0),
                  color: '#14b8a6',
                },
                {
                  label: 'Remaining Supply',
                  value: remainingSupply,
                  valueLabel: formatToken(remainingSupply, 'SYS', 0),
                  color: '#b8d5ff',
                },
              ]}
            />
          </div>
        </section>
      ) : null}

      {stats ? (
        <section className="page-section">
          <div className="site-wrap">
            <div className="section-heading">
              <p className="eyebrow">Reward Payouts</p>
              <h2>Get paid to secure the Syscoin Network</h2>
            </div>

            <div className="tier-grid">
              <IncomeTierCard
                label="New Sentry Node"
                roi={networkStats.roi}
                yearlyUsd={incomeStats.usd.yearly}
                yearlySys={incomeStats.sys.yearly}
                monthlyUsd={incomeStats.usd.monthly}
                monthlySys={incomeStats.sys.monthly}
                dailyUsd={incomeStats.usd.daily}
                dailySys={incomeStats.sys.daily}
              />
              <IncomeTierCard
                label="1 Year Seniority"
                roi={networkStats.roi_one}
                yearlyUsd={oneYearIncome.usd.yearly}
                yearlySys={oneYearIncome.sys.yearly}
                monthlyUsd={oneYearIncome.usd.monthly}
                monthlySys={oneYearIncome.sys.monthly}
                dailyUsd={oneYearIncome.usd.daily}
                dailySys={oneYearIncome.sys.daily}
              />
              <IncomeTierCard
                label="2.5 Year Seniority"
                roi={networkStats.roi_two}
                yearlyUsd={longTermIncome.usd.yearly}
                yearlySys={longTermIncome.sys.yearly}
                monthlyUsd={longTermIncome.usd.monthly}
                monthlySys={longTermIncome.sys.monthly}
                dailyUsd={longTermIncome.usd.daily}
                dailySys={longTermIncome.sys.daily}
              />
            </div>
          </div>
        </section>
      ) : null}

      {stats ? (
        <section className="page-section">
          <div className="site-wrap dashboard-grid dashboard-grid--split">
            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Syscoin Market</p>
                </div>
              </div>
              <DefinitionGrid items={marketItems} />
            </section>

            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Syscoin Chain Info</p>
                </div>
              </div>
              <DefinitionGrid items={chainItems} />
            </section>
          </div>
        </section>
      ) : null}

      {stats ? (
        <section className="page-section page-section--last">
          <div className="site-wrap panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Where in the world are Syscoin Sentry Nodes?</p>
              </div>
            </div>

            <CountryList entries={topCountries} enabledCount={enabledCount} />
          </div>
        </section>
      ) : null}
    </main>
  );
}
