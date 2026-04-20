const COUNTRY_NAMES = {
  AUT: 'Austria',
  BGR: 'Bulgaria',
  BRA: 'Brazil',
  CAN: 'Canada',
  CYP: 'Cyprus',
  DEU: 'Germany',
  DNK: 'Denmark',
  FIN: 'Finland',
  FRA: 'France',
  GBR: 'United Kingdom',
  IND: 'India',
  IRN: 'Iran',
  ITA: 'Italy',
  JPN: 'Japan',
  LTU: 'Lithuania',
  NLD: 'Netherlands',
  NOR: 'Norway',
  POL: 'Poland',
  SGP: 'Singapore',
  SWE: 'Sweden',
  TUR: 'Turkey',
  USA: 'United States',
};

export function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/\$/g, '')
    .replace(/BTC/g, '')
    .replace(/SYS/g, '')
    .replace(/%/g, '')
    .trim();

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat('en-US', options).format(Number(value) || 0);
}

export function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function normalizeDateValue(dateValue, options) {
  if (!dateValue) {
    return null;
  }

  if (dateValue instanceof Date) {
    return Number.isNaN(dateValue.getTime()) ? null : dateValue;
  }

  if (typeof dateValue === 'number') {
    const numericDate = new Date(dateValue);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }

  const normalizedString = String(dateValue)
    .replace(/(\d{1,2})(st|nd|rd|th)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const assumeUtc = Boolean(options && options.assumeUtc);
  const hasExplicitTimezone = /\b(?:UTC|GMT|Z|[+-]\d{2}:?\d{2})\b/i.test(normalizedString);
  const includesTime = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?/i.test(normalizedString);

  if (assumeUtc && includesTime && !hasExplicitTimezone) {
    const parsedUtcDate = new Date(`${normalizedString} UTC`);
    if (!Number.isNaN(parsedUtcDate.getTime())) {
      return parsedUtcDate;
    }
  }

  const parsedDate = new Date(normalizedString);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

export function formatCurrency(value) {
  const numericValue = Number(value) || 0;
  const absoluteValue = Math.abs(numericValue);
  const decimals = absoluteValue >= 100 ? 0 : absoluteValue >= 1 ? 2 : 4;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numericValue);
}

export function formatPercent(value, digits) {
  return `${parseNumber(value).toFixed(digits === undefined ? 2 : digits)}%`;
}

export function formatToken(value, symbol, digits) {
  const precision = digits === undefined ? 0 : digits;

  return `${formatNumber(parseNumber(value), {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })} ${symbol}`;
}

export function formatDateLabel(dateValue, range) {
  const date = normalizeDateValue(dateValue);

  if (!date) {
    return String(dateValue);
  }

  const longRange = range === '365d' || range === 'all';

  return new Intl.DateTimeFormat('en-AU', {
    month: 'short',
    day: longRange ? undefined : 'numeric',
    year: longRange ? '2-digit' : undefined,
  }).format(date);
}

export function formatLongDate(dateValue) {
  const date = normalizeDateValue(dateValue);

  if (!date) {
    return String(dateValue);
  }

  return new Intl.DateTimeFormat('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatShortDate(dateValue) {
  const date = normalizeDateValue(dateValue, { assumeUtc: true });

  if (!date) {
    return String(dateValue || 'TBD');
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatUtcTime(dateValue) {
  const date = normalizeDateValue(dateValue, { assumeUtc: true });

  if (!date) {
    return String(dateValue || 'TBD');
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  }).format(date);
}

function getOrdinalSuffix(day) {
  if (day >= 11 && day <= 13) {
    return 'th';
  }

  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function formatDayMonth(dateValue) {
  const date = normalizeDateValue(dateValue, { assumeUtc: true });

  if (!date) {
    return String(dateValue || 'TBD');
  }

  const day = date.getDate();
  const month = new Intl.DateTimeFormat('en-AU', {
    month: 'long',
  }).format(date);

  return `${day}${getOrdinalSuffix(day)} ${month}`;
}

export function formatDateFromEpoch(epoch) {
  if (!epoch) {
    return 'TBD';
  }

  return formatLongDate(epoch * 1000);
}

export function getCountryName(code) {
  return COUNTRY_NAMES[code] || code;
}

export function getProposalDurationMonths(startEpoch, endEpoch) {
  if (!startEpoch || !endEpoch || endEpoch <= startEpoch) {
    return 1;
  }

  const durationInSeconds = endEpoch - startEpoch;
  const durationInDays = durationInSeconds / 86400;

  return Math.max(1, Math.round(durationInDays / 30.4375));
}

export function sortHistory(historyData) {
  return (historyData || []).slice().sort(function sortByDate(a, b) {
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });
}
