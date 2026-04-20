import React from 'react';

import { formatNumber, formatPercent, getCountryName } from '../lib/formatters';

export default function CountryList(props) {
  return (
    <div className="country-list">
      {props.entries.map(function renderCountry(entry) {
        const code = entry[0];
        const count = Number(entry[1].masternodes || 0);
        const share = props.enabledCount ? (count / props.enabledCount) * 100 : 0;
        const minimumWidth = props.minimumWidth === undefined ? 4 : props.minimumWidth;

        return (
          <div key={code} className="country-list__row">
            <div className="country-list__label">
              <span className="country-list__count">{formatNumber(count)} nodes</span>
              <strong>{getCountryName(code)}</strong>
            </div>
            <div className="country-list__bar">
              <span style={{ width: `${Math.max(share, minimumWidth)}%` }} />
            </div>
            <div className="country-list__value">{formatPercent(share, 1)}</div>
          </div>
        );
      })}
    </div>
  );
}
