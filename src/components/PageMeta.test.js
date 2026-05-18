import React, { act } from 'react';
import { render, waitFor } from '@testing-library/react';
import { Router } from 'react-router-dom';
import { createMemoryHistory } from 'history';

import PageMeta from './PageMeta';

afterEach(() => {
  document.title = '';
  document.head
    .querySelectorAll(
      'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]'
    )
    .forEach((element) => {
      element.remove();
    });
});

test('updates og:url when only the location changes', async () => {
  const staticOgUrl = document.createElement('meta');
  staticOgUrl.setAttribute('property', 'og:url');
  staticOgUrl.setAttribute('content', 'https://sysnode.info/');
  document.head.appendChild(staticOgUrl);

  const history = createMemoryHistory({
    initialEntries: ['/verify-email?token=alpha'],
  });

  render(
    <Router history={history}>
      <PageMeta title="Verify email" description="Finish creating your Sysnode account." />
    </Router>
  );

  expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute(
    'content',
    'http://localhost/verify-email?token=alpha'
  );
  expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();

  await act(async () => {
    history.push('/verify-email?token=beta');
  });

  await waitFor(() =>
    expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute(
      'content',
      'http://localhost/verify-email?token=beta'
    )
  );
  expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
});
