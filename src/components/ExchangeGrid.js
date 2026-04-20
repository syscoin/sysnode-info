import React from 'react';

export default function ExchangeGrid(props) {
  return (
    <div className="market-exchanges market-exchanges--compact">
      <div className="market-exchanges__header">
        <div>
          <strong>Get your Syscoin on these exchanges and more</strong>
        </div>
        <a
          href="https://www.coingecko.com/en/coins/syscoin"
          target="_blank"
          rel="noopener noreferrer"
        >
          View all markets
        </a>
      </div>

      <div className="market-exchanges__grid market-exchanges__grid--compact">
        {props.exchanges.map(function renderExchange(exchange) {
          return (
            <a
              key={exchange.name}
              className="market-exchange-card market-exchange-card--compact"
              href={exchange.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src={exchange.logo}
                alt={`${exchange.name} logo`}
                loading="lazy"
                width="32"
                height="32"
              />
              <span>{exchange.name}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
