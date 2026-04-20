import React from 'react';

import DefinitionGrid from '../components/DefinitionGrid';
import ExternalButton from '../components/ExternalButton';
import PageMeta from '../components/PageMeta';
import {
  HOSTING_MODEL,
  PRE_FLIGHT,
  PROVIDERS,
  RESOURCE_LINKS,
  SNAPSHOT,
} from '../data/setup';

export default function Setup() {
  return (
    <main className="page-main">
      <PageMeta
        title="Setup"
        description="Plan a Syscoin Sentry Node setup with collateral requirements, hosting options, pre-flight checks, and official setup resources."
      />

      <section className="page-hero">
        <div className="site-wrap page-hero__layout">
          <div>
            <p className="eyebrow">Setup</p>
            <h1>Plan your Sentry Node journey.</h1>
            <p className="page-hero__copy">
              This page is the operator briefing. It tells you what to prepare,
              what the official Syscoin flow expects, and where a managed host may
              make more sense than running your own VPS. Use it to choose the
              right path, then follow the live official guide for the command-by-command
              setup.
            </p>
          </div>

          <div className="page-hero__visual panel">
            <div>
              <p className="eyebrow">Operator snapshot</p>
            </div>
            <DefinitionGrid items={SNAPSHOT} className="definition-grid--setup" />
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap dashboard-grid dashboard-grid--split">
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Before You Start</p>
              </div>
            </div>

            <ul className="content-list">
              {PRE_FLIGHT.map(function renderRequirement(requirement) {
                return <li key={requirement}>{requirement}</li>;
              })}
            </ul>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Deployment Model</p>
              </div>
            </div>

            <ul className="content-list">
              {HOSTING_MODEL.map(function renderPoint(point) {
                return <li key={point}>{point}</li>;
              })}
            </ul>
          </section>
        </div>
      </section>

      <section className="page-section">
        <div className="site-wrap">
          <div className="section-heading">
            <p className="eyebrow">Hosting Options</p>
          </div>

          <div className="action-grid">
            {PROVIDERS.map(function renderProvider(provider) {
              return (
                <article key={provider.title} className="action-card setup-card">
                  <p className="setup-card__eyebrow">{provider.eyebrow}</p>
                  <h3>{provider.title}</h3>
                  <p>{provider.copy}</p>
                  {provider.bullets && provider.bullets.length ? (
                    <ul className="setup-card__list">
                      {provider.bullets.map(function renderBullet(bullet) {
                        return <li key={bullet}>{bullet}</li>;
                      })}
                    </ul>
                  ) : null}
                  <div className="setup-card__links">
                    {provider.links.map(function renderLink(link) {
                      return (
                        <ExternalButton
                          key={link.label}
                          className={
                            link.primary
                              ? 'button button--primary button--small setup-card__button'
                              : 'button button--ghost button--small setup-card__button'
                          }
                          href={link.href}
                        >
                          {link.label}
                        </ExternalButton>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="page-section page-section--last">
        <div className="site-wrap dashboard-grid dashboard-grid--split">
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Official Resources</p>
              </div>
            </div>

            <p className="panel__intro">
              Sysnode should help you choose the right setup path. The official
              Syscoin guide should still be your source of truth for the current
              installation commands, registration flow, and troubleshooting notes.
            </p>

            <div className="panel-actions panel-actions--stack">
              {RESOURCE_LINKS.map(function renderLink(link) {
                return (
                  <ExternalButton
                    key={link.label}
                    className={link.primary ? 'button button--primary button--full' : 'button button--ghost button--full'}
                    href={link.href}
                  >
                    {link.label}
                  </ExternalButton>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">What to Expect</p>
              </div>
            </div>

            <ul className="content-list">
              <li>
                Newly activated Sentry Nodes normally pass through a qualification
                period before they begin regular payouts.
              </li>
              <li>
                Payment cadence depends on how many nodes are online, so it changes
                as the network set changes.
              </li>
              <li>
                Seniority matters. The longer a node holds its collateral position,
                the higher its reward rate becomes at the 1-year and 2.5-year
                milestones.
              </li>
              <li>
                If you are using a third-party host, keep reviewing their current
                terms and service details as part of your ongoing operator process.
              </li>
            </ul>
          </section>
        </div>
      </section>
    </main>
  );
}
