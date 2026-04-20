import React from 'react';
import { Link } from 'react-router-dom';

import DefinitionGrid from '../components/DefinitionGrid';
import ExternalButton from '../components/ExternalButton';
import PageMeta from '../components/PageMeta';
import { EXTERNAL_LINKS } from '../data/navigation';
import {
  CORE_ROLES,
  LEARN_CARDS,
  QUICK_FACTS,
  REGISTRY_POINTS,
  REQUIREMENTS,
} from '../data/learn';

export default function Learn() {
  return (
    <main className="page-main">
      <PageMeta
        title="Learn"
        description="Learn how Syscoin Sentry Nodes support finality, network resilience, seniority rewards, and decentralized governance."
      />

      <section className="page-hero">
        <div className="site-wrap page-hero__layout">
          <div>
            <p className="eyebrow">Learn More Today</p>
            <h1>Overview of Syscoin Sentry Nodes.</h1>
            <p className="page-hero__copy">
              Syscoin is a Bitcoin-powered modular network built for scalable
              execution, data availability, and long-term decentralization. Sentry
              Nodes are the incentivized full-node layer that adds finality,
              strengthens network stability, and gives operators a direct role in
              governance.
            </p>
          </div>

          <div className="page-hero__visual panel">
            <div>
              <p className="eyebrow">Quick facts</p>
            </div>
            <DefinitionGrid items={QUICK_FACTS} />
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap">
          <div className="action-grid">
            {LEARN_CARDS.map(function renderCard(card) {
              return (
                <article key={card.title} className="action-card">
                  <h3>{card.title}</h3>
                  <p>{card.copy}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap dashboard-grid dashboard-grid--split">
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Network Role</p>
              </div>
            </div>

            <ul className="content-list">
              {CORE_ROLES.map(function renderRole(role) {
                return <li key={role}>{role}</li>;
              })}
            </ul>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Ownership and Incentives</p>
              </div>
            </div>

            <ul className="content-list">
              {REQUIREMENTS.map(function renderRequirement(requirement) {
                return <li key={requirement}>{requirement}</li>;
              })}
            </ul>
          </section>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap dashboard-grid dashboard-grid--split">
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Registry and NEVM</p>
              </div>
            </div>

            <ul className="content-list">
              {REGISTRY_POINTS.map(function renderPoint(point) {
                return <li key={point}>{point}</li>;
              })}
            </ul>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Continue with Official Syscoin Resources</p>
              </div>
            </div>

            <div className="panel-actions panel-actions--stack">
              <ExternalButton
                className="button button--primary button--full"
                href={EXTERNAL_LINKS.sentryNodeDocs}
              >
                Sentry Node Documents
              </ExternalButton>
              <ExternalButton
                className="button button--ghost button--full"
                href={EXTERNAL_LINKS.syscoin}
              >
                Visit Syscoin.org
              </ExternalButton>
              <Link className="button button--ghost button--full" to="/network">
                Checkout the Network Dashboard
              </Link>
              <Link className="button button--ghost button--full" to="/setup">
                Setup a Sentry Node
              </Link>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
