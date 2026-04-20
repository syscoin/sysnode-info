import { useEffect } from 'react';

const SITE_NAME = 'Sysnode';
const DEFAULT_TITLE = 'Sysnode | Syscoin Sentry Node Dashboard';
const DEFAULT_DESCRIPTION =
  'Track Syscoin Sentry Node count, locked supply, rewards, governance proposals, setup guidance, and market context in one clean dashboard.';

function ensureMeta(selector, attributeName, attributeValue) {
  let element = document.head.querySelector(selector);

  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attributeName, attributeValue);
    document.head.appendChild(element);
  }

  return element;
}

export default function PageMeta(props) {
  const description = props.description || DEFAULT_DESCRIPTION;
  const fullTitle = props.title ? `${props.title} | ${SITE_NAME}` : DEFAULT_TITLE;

  useEffect(
    function syncDocumentMeta() {
      document.title = fullTitle;

      ensureMeta('meta[name="description"]', 'name', 'description').setAttribute(
        'content',
        description
      );
      ensureMeta('meta[property="og:title"]', 'property', 'og:title').setAttribute(
        'content',
        fullTitle
      );
      ensureMeta(
        'meta[property="og:description"]',
        'property',
        'og:description'
      ).setAttribute('content', description);
      ensureMeta('meta[property="og:type"]', 'property', 'og:type').setAttribute(
        'content',
        'website'
      );
      ensureMeta('meta[property="og:site_name"]', 'property', 'og:site_name').setAttribute(
        'content',
        SITE_NAME
      );
      ensureMeta('meta[property="og:url"]', 'property', 'og:url').setAttribute(
        'content',
        window.location.href
      );
      ensureMeta('meta[name="twitter:card"]', 'name', 'twitter:card').setAttribute(
        'content',
        'summary'
      );
      ensureMeta('meta[name="twitter:title"]', 'name', 'twitter:title').setAttribute(
        'content',
        fullTitle
      );
      ensureMeta(
        'meta[name="twitter:description"]',
        'name',
        'twitter:description'
      ).setAttribute('content', description);
    },
    [description, fullTitle]
  );

  return null;
}
