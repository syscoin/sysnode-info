import React from 'react';
import { render, screen } from '@testing-library/react';
import ExchangeGrid from './ExchangeGrid';
import SYS_EXCHANGES from '../data/exchanges';

test.each([[], undefined, null])('omits the exchange section and its market CTA without listings (%p)', (exchanges) => {
  const { container } = render(<ExchangeGrid exchanges={exchanges} />);
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText(/Get your Syscoin|View all markets/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('current exchange data contains no unverified or planned listings', () => {
  expect(SYS_EXCHANGES).toEqual([]);
});

test('can still render an explicitly supplied listing', () => {
  render(<ExchangeGrid exchanges={[{
    name: 'Example exchange',
    href: 'https://exchange.example/trade/SYS-USDT',
    logo: 'https://exchange.example/logo.png',
  }]} />);
  const listing = screen.getByRole('link', { name: /Example exchange/ });
  expect(listing).toHaveAttribute('href', 'https://exchange.example/trade/SYS-USDT');
  expect(listing).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByAltText('Example exchange logo')).toBeInTheDocument();
});
