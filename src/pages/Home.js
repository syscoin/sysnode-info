import React from 'react';
import { Link } from 'react-router-dom';

import CountryList from '../components/CountryList';
import DataState from '../components/DataState';
import DefinitionGrid from '../components/DefinitionGrid';
import ExchangeGrid from '../components/ExchangeGrid';
import NetworkGraphic from '../components/NetworkGraphic';
import PageMeta from '../components/PageMeta';
import TrendChart from '../components/TrendChart';
import SYS_EXCHANGES from '../data/exchanges';
import useNetworkData from '../hooks/useNetworkData';
import {
  formatDayMonth,
  formatCompactNumber,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatToken,
  parseNumber,
} from '../lib/formatters';

const ACTION_CARDS = [
  {
    title: 'Check the Network',
    copy: 'See Syscoin Sentry Node count, locked collateral, rewards, and price in one place.',
    linkLabel: 'Open Dashboard',
    to: '/network',
  },
  {
    title: 'Track Current Proposals',
    copy: 'See which proposals are active, when the next superblock is due, and where things stand.',
    linkLabel: 'View Governance',
    to: '/governance',
  },
  {
    title: 'Setup Your Sentry Node',
    copy: 'Start with the key setup steps, then jump to the official guide for the exact commands.',
    linkLabel: 'Get Started Today',
    to: '/setup',
  },
];

export default function Home() {
  const { loading, error, history, stats } = useNetworkData();
  const networkStats = stats && stats.stats ? stats.stats.mn_stats : null;
  const priceStats = stats && stats.stats ? stats.stats.price_stats : null;
  const superblockStats = stats && stats.stats ? stats.stats.superblock_stats : null;
  const enabledCount = parseNumber(networkStats && networkStats.enabled);
  const totalCount = parseNumber(networkStats && networkStats.total);
  const mapEntries = Object.entries(stats && stats.mapData ? stats.mapData : {}).sort(
    function sortCountries(a, b) {
      return Number(b[1].masternodes || 0) - Number(a[1].masternodes || 0);
    }
  );
  const topCountries = mapEntries.slice(0, 7);
  const highlightCards = networkStats && superblockStats
    ? [
        {
          label: 'Enabled Sentry Nodes',
          value: formatNumber(enabledCount),
          hint: `${formatNumber(totalCount)} Total Sentry Nodes`,
        },
        {
          label: 'Locked Supply',
          value: formatPercent(networkStats.coins_percent_locked, 2),
          hint: `${formatCompactNumber(parseNumber(networkStats.total_locked))} SYS Locked`,
        },
        {
          label: 'Node ROI',
          value: networkStats.roi,
          hint: `${networkStats.roi_one} After One Year`,
        },
        {
          label: 'Next Superblock',
          value: formatDayMonth(superblockStats.superblock_date),
          hint: superblockStats.next_superblock,
        },
      ]
    : [];
  const marketItems =
    priceStats && networkStats
      ? [
          {
            label: 'SYS Price',
            value: formatCurrency(parseNumber(priceStats.price_usd)),
          },
          {
            label: '24h Change',
            value: formatPercent(priceStats.price_change, 2),
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
            label: 'Current Supply',
            value: formatToken(networkStats.current_supply, 'SYS', 0),
          },
          {
            label: 'Locked Supply',
            value: formatToken(networkStats.total_locked, 'SYS', 0),
          },
        ]
      : [];

  return (
    <main className="page-main">
      <PageMeta
        title="Overview"
        description="Track Syscoin Sentry Node count, locked supply, rewards, proposals, locations, and SYS market context in one clean dashboard."
      />

      <section className="hero">
        <div className="site-wrap hero__layout">
          <div className="hero__content">
            <span className="hero__eyebrow">Sentry Node Dashboard</span>
            <h1>Operate the quorum layer behind Syscoin.</h1>
            <p className="hero__copy">
              Track network state, TVL, Node Rewards, and Proposals for the Sentry Node network that underpins decentralized finality on Syscoin.
            </p>

            <div className="hero__actions">
              <Link className="button button--primary" to="/network">
                Explore the network
              </Link>
              <Link className="button button--ghost" to="/governance">
                View Proposals
              </Link>
            </div>

            <div className="hero__highlights">
              <div className="hero-chip">
                <span>Collateral</span>
                <strong>
                  {networkStats ? formatToken(networkStats.collateral_req, 'SYS') : '100,000 SYS'}
                </strong>
              </div>
              <div className="hero-chip">
                <span>Sentry Node ROI</span>
                <strong>{networkStats ? networkStats.roi : 'Loading...'}</strong>
              </div>
              <div className="hero-chip">
                <span>Next Superblock</span>
                <strong>
                  {superblockStats ? formatDayMonth(superblockStats.superblock_date) : 'Loading...'}
                </strong>
              </div>
            </div>
          </div>

          <div className="hero__visual panel learn-hero-visual">
            <div className="hero__visual-copy">
              <p className="eyebrow">Secure Global P2P Network</p>
            </div>

            <NetworkGraphic />
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap">
          <DataState
            error={error}
            loading={loading && !stats}
            loadingMessage="Loading the latest network overview..."
          />

          {stats ? (
            <div className="metric-grid metric-grid--overview">
              {highlightCards.map(function renderCard(card) {
                return (
                  <article key={card.label} className="metric-card">
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <p>{card.hint}</p>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      {stats ? (
        <section className="page-section page-section--tight">
          <div className="site-wrap dashboard-grid dashboard-grid--feature">
            <TrendChart
              defaultRange="all"
              eyebrow="Sentry Node Trend"
              title="Sentry Nodes Over Time"
              historyData={history}
            />

            <aside className="panel stack-panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Sentry Node Snapshot</p>
                </div>
              </div>

              <div className="stat-list">
                <div className="stat-list__row">
                  <span>Enabled Sentry Nodes</span>
                  <strong>{formatNumber(enabledCount)}</strong>
                </div>
                <div className="stat-list__row">
                  <span>TVL</span>
                  <strong>{formatToken(networkStats.total_locked, 'SYS', 0)}</strong>
                </div>
                <div className="stat-list__row">
                  <span>Base ROI</span>
                  <strong>{networkStats.roi}</strong>
                </div>
                <div className="stat-list__row">
                  <span>1 Year ROI</span>
                  <strong>{networkStats.roi_one}</strong>
                </div>
                <div className="stat-list__row">
                  <span>2.5 Year ROI</span>
                  <strong>{networkStats.roi_two}</strong>
                </div>
                <div className="stat-list__row">
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
            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Sentry Node Locations</p>
                </div>
              </div>

              <CountryList entries={topCountries} enabledCount={enabledCount} minimumWidth={6} />
            </section>

            <section className="panel panel--market">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Syscoin Market</p>
                </div>
              </div>

              <DefinitionGrid items={marketItems} />
              <ExchangeGrid exchanges={SYS_EXCHANGES} />
            </section>
          </div>
        </section>
      ) : null}

      <section className="page-section page-section--last">
        <div className="site-wrap">
          <div className="section-heading">
            <p className="eyebrow">Manage your Syscoin Sentry Node setup.</p>
            <h2>What do you need today?</h2>
          </div>

          <div className="action-grid">
            {ACTION_CARDS.map(function renderAction(card) {
              return (
                <article key={card.title} className="action-card">
                  <h3>{card.title}</h3>
                  <p>{card.copy}</p>
                  <Link to={card.to}>{card.linkLabel}</Link>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}
