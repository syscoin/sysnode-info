import React from 'react';

import BreakdownChart from '../components/BreakdownChart';
import CountryList from '../components/CountryList';
import DataState from '../components/DataState';
import DefinitionGrid from '../components/DefinitionGrid';
import NetworkDataStatus from '../components/NetworkDataStatus';
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
} from '../lib/formatters';
import { metricNumber, metricFormat, metricText, metricDate } from '../lib/networkStats';

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
  const { statsLoading, historyLoading, error, historyError, groups, history, stats } = useNetworkData();
  const networkStats = stats && stats.stats ? stats.stats.mn_stats : null;
  const incomeStats = stats && stats.stats ? stats.stats.income_stats : null;
  const oneYearIncome =
    stats && stats.stats ? stats.stats.income_stats_seniority_one_year : null;
  const longTermIncome =
    stats && stats.stats ? stats.stats.income_stats_seniority_two_year : null;
  const priceStats = stats && stats.stats ? stats.stats.price_stats : null;
  const blockchainStats = stats && stats.stats ? stats.stats.blockchain_stats : null;
  const superblockStats = stats && stats.stats ? stats.stats.superblock_stats : null;
  const enabledCount = metricNumber(networkStats && networkStats.enabled);
  const bannedCount = metricNumber(networkStats && networkStats.pose_banned);
  const lockedSupply = metricNumber(networkStats && networkStats.total_locked);
  const currentSupply = metricNumber(networkStats && networkStats.current_supply);
  const remainingSupply = currentSupply !== null && lockedSupply !== null
    ? Math.max(currentSupply - lockedSupply, 0) : null;
  const topCountries = Object.entries(stats && stats.mapData ? stats.mapData : {})
    .sort(function sortCountries(a, b) {
      return Number(b[1].masternodes || 0) - Number(a[1].masternodes || 0);
    })
    .slice(0, 8);

  const priceBtcValue = metricNumber(priceStats && priceStats.price_btc);
  const readablePriceBtc = priceBtcValue !== null && priceBtcValue >= 0 ? `${priceBtcValue.toFixed(8)} BTC` : 'Unavailable';
  const networkHeroCards = [
        {
          label: 'Total Nodes',
          value: metricFormat(networkStats?.total, formatNumber),
        },
        {
          label: 'Enabled Nodes',
          value: metricFormat(enabledCount, formatNumber),
        },
        {
          label: 'Locked Supply',
          value: metricFormat(networkStats?.coins_percent_locked, formatPercent, 2),
        },
        {
          label: 'ROI',
          value: networkStats?.roi && networkStats?.roi_two ? `${networkStats.roi}-${networkStats.roi_two}` : 'Unavailable',
        },
        {
          label: 'Payout Frequency',
          value: metricText(networkStats?.payout_frequency),
        },
        {
          label: 'Next Superblock',
          value: superblockStats ? formatDayMonth(superblockStats.superblock_date) : 'Unavailable',
        },
      ];
  const marketItems =
    priceStats
      ? [
          {
            label: 'SYS price',
            value: metricFormat(priceStats.price_usd, formatCurrency),
          },
          {
            label: 'SYS / BTC',
            value: readablePriceBtc,
          },
          {
            label: '24h Volume',
            value: metricFormat(priceStats.volume_usd, formatCurrency),
          },
          {
            label: 'Market Cap',
            value: metricFormat(priceStats.market_cap_usd, formatCurrency),
          },
          {
            label: '24h Change',
            value: metricFormat(priceStats.price_change, formatPercent, 2),
          },
          {
            label: 'Circulating Supply',
            value: metricFormat(priceStats.circulating_supply, formatToken, 'SYS', 0),
          },
        ]
      : [];
  const chainItems = blockchainStats
    ? [
        {
          label: 'Current Block Height',
          value: metricFormat(blockchainStats.connections, formatNumber),
        },
        {
          label: 'Average Block Time',
          value: metricText(blockchainStats.avg_block),
        },
        {
          label: 'Version',
          value: metricFormat(blockchainStats.version, String),
        },
        {
          label: 'Sub-version',
          value: metricText(blockchainStats.sub_version),
        },
        {
          label: 'Protocol',
          value: metricFormat(blockchainStats.protocol, String),
        },
        {
          label: 'Genesis Block',
          value: metricDate(blockchainStats.genesis, formatLongDate),
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
                  <strong>{statsLoading && !stats ? 'Loading...' : card.value}</strong>
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
            loading={statsLoading && !stats}
            loadingMessage="Loading the live dashboard..."
          />
          <NetworkDataStatus groups={groups} historyError={historyError} />
        </div>
      </section>

      {!historyLoading || stats ? (
        <section className="page-section page-section--tight">
          <div className="site-wrap dashboard-grid dashboard-grid--feature">
            <TrendChart
              defaultRange="all"
              eyebrow="Sentry Nodes Over Time"
              title="Node count trend"
              historyData={history}
            />

            {networkStats ? <aside className="panel stack-panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Sentry Node Stats</p>
                </div>
              </div>

              <div className="metric-stack">
                <div className="metric-stack__item">
                  <span>Base ROI</span>
                  <strong>{metricText(networkStats.roi)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>1 Year Seniority ROI</span>
                  <strong>{metricText(networkStats.roi_one)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>2.5 Year Seniority ROI</span>
                  <strong>{metricText(networkStats.roi_two)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Payout Frequency</span>
                  <strong>{metricText(networkStats.payout_frequency)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Locked Supply</span>
                  <strong>{metricFormat(networkStats.coins_percent_locked, formatPercent, 2)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Sentry Node Price</span>
                  <strong>{metricFormat(networkStats.masternode_price_usd, formatCurrency)}</strong>
                </div>
                <div className="metric-stack__item">
                  <span>Next Superblock</span>
                  <strong>{superblockStats ? formatDayMonth(superblockStats.superblock_date) : 'Unavailable'}</strong>
                </div>
              </div>
            </aside> : null}
          </div>
        </section>
      ) : null}

      {networkStats ? (
        <section className="page-section">
          <div className="site-wrap dashboard-grid dashboard-grid--split">
            <BreakdownChart
              eyebrow="Syscoin Sentry Node Status"
              title="Node status mix"
              centerValue={metricFormat(enabledCount, formatNumber)}
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

            {currentSupply !== null && lockedSupply !== null ? <BreakdownChart
              eyebrow="Syscoin Sentry Node TVL"
              title="Locked supply mix"
              centerValue={metricFormat(networkStats.coins_percent_locked, formatPercent, 2)}
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
            /> : <section className="panel"><p className="eyebrow">Syscoin Sentry Node TVL</p>
              <p>Supply proportions are unavailable until a current supply observation is available.</p>
              <p>Locked collateral: {metricFormat(lockedSupply, formatToken, 'SYS', 0)}</p>
            </section>}
          </div>
        </section>
      ) : null}

      {networkStats ? (
        <section className="page-section">
          <div className="site-wrap">
            <div className="section-heading">
              <p className="eyebrow">Reward Payouts</p>
              <h2>Get paid to secure the Syscoin Network</h2>
            </div>

            <div className="tier-grid">
              <IncomeTierCard
                label="New Sentry Node"
                roi={metricText(networkStats.roi)}
                yearlyUsd={metricText(incomeStats?.usd?.yearly)}
                yearlySys={metricText(incomeStats?.sys?.yearly)}
                monthlyUsd={metricText(incomeStats?.usd?.monthly)}
                monthlySys={metricText(incomeStats?.sys?.monthly)}
                dailyUsd={metricText(incomeStats?.usd?.daily)}
                dailySys={metricText(incomeStats?.sys?.daily)}
              />
              <IncomeTierCard
                label="1 Year Seniority"
                roi={metricText(networkStats.roi_one)}
                yearlyUsd={metricText(oneYearIncome?.usd?.yearly)}
                yearlySys={metricText(oneYearIncome?.sys?.yearly)}
                monthlyUsd={metricText(oneYearIncome?.usd?.monthly)}
                monthlySys={metricText(oneYearIncome?.sys?.monthly)}
                dailyUsd={metricText(oneYearIncome?.usd?.daily)}
                dailySys={metricText(oneYearIncome?.sys?.daily)}
              />
              <IncomeTierCard
                label="2.5 Year Seniority"
                roi={metricText(networkStats.roi_two)}
                yearlyUsd={metricText(longTermIncome?.usd?.yearly)}
                yearlySys={metricText(longTermIncome?.sys?.yearly)}
                monthlyUsd={metricText(longTermIncome?.usd?.monthly)}
                monthlySys={metricText(longTermIncome?.sys?.monthly)}
                dailyUsd={metricText(longTermIncome?.usd?.daily)}
                dailySys={metricText(longTermIncome?.sys?.daily)}
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
