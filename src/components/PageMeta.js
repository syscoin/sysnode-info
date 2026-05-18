import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SITE_NAME = 'Sysnode';
const DEFAULT_TITLE = 'Sysnode | Syscoin Sentry Node Dashboard';
const DEFAULT_DESCRIPTION =
  'Live Syscoin Sentry Node stats, governance proposals, rewards, setup guidance, and market data.';
const SITE_URL = 'https://sysnode.info';
const SOCIAL_IMAGE_URL = `${SITE_URL}/social-card.png?v=20260518b`;
const SOCIAL_IMAGE_ALT =
  'Sysnode social share card with the Syscoin logo, Sysnode wordmark, and a connected globe network illustration.';
const TWITTER_HANDLE = '@syscoin';

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
  const location = useLocation();
  const description = props.description || DEFAULT_DESCRIPTION;
  const fullTitle = props.title ? `${props.title} | ${SITE_NAME}` : DEFAULT_TITLE;
  const pageUrl = `${window.location.origin}${location.pathname}${location.search}${location.hash}`;

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
        pageUrl
      );
      ensureMeta('meta[property="og:image"]', 'property', 'og:image').setAttribute(
        'content',
        SOCIAL_IMAGE_URL
      );
      ensureMeta(
        'meta[property="og:image:secure_url"]',
        'property',
        'og:image:secure_url'
      ).setAttribute('content', SOCIAL_IMAGE_URL);
      ensureMeta(
        'meta[property="og:image:type"]',
        'property',
        'og:image:type'
      ).setAttribute('content', 'image/png');
      ensureMeta(
        'meta[property="og:image:width"]',
        'property',
        'og:image:width'
      ).setAttribute('content', '1200');
      ensureMeta(
        'meta[property="og:image:height"]',
        'property',
        'og:image:height'
      ).setAttribute('content', '630');
      ensureMeta(
        'meta[property="og:image:alt"]',
        'property',
        'og:image:alt'
      ).setAttribute('content', SOCIAL_IMAGE_ALT);
      ensureMeta('meta[name="twitter:card"]', 'name', 'twitter:card').setAttribute(
        'content',
        'summary_large_image'
      );
      ensureMeta('meta[name="twitter:site"]', 'name', 'twitter:site').setAttribute(
        'content',
        TWITTER_HANDLE
      );
      ensureMeta(
        'meta[name="twitter:creator"]',
        'name',
        'twitter:creator'
      ).setAttribute('content', TWITTER_HANDLE);
      ensureMeta('meta[name="twitter:title"]', 'name', 'twitter:title').setAttribute(
        'content',
        fullTitle
      );
      ensureMeta(
        'meta[name="twitter:description"]',
        'name',
        'twitter:description'
      ).setAttribute('content', description);
      ensureMeta('meta[name="twitter:image"]', 'name', 'twitter:image').setAttribute(
        'content',
        SOCIAL_IMAGE_URL
      );
      ensureMeta(
        'meta[name="twitter:image:alt"]',
        'name',
        'twitter:image:alt'
      ).setAttribute('content', SOCIAL_IMAGE_ALT);
    },
    [description, fullTitle, pageUrl]
  );

  return null;
}
