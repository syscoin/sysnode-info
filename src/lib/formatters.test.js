import {
  formatDayMonth,
  formatShortDate,
  formatUtcTime,
  getCountryFlag,
  getCountryName,
} from './formatters';

describe('date formatters', () => {
  const superblockDate = 'April 20th 2026, 2:15:21 pm';

  test('keeps superblock day and month in UTC', () => {
    expect(formatDayMonth(superblockDate)).toBe('20th April');
  });

  test('keeps governance summary dates in UTC', () => {
    expect(formatShortDate(superblockDate)).toBe('Apr 20, 2026');
    expect(formatUtcTime(superblockDate)).toBe('2:15 PM');
  });
});

describe('country formatters', () => {
  test('uses a regional Middle East label for IRN', () => {
    expect(getCountryName('ARE')).toBe('United Arab Emirates');
    expect(getCountryName('IRN')).toBe('Middle East');
  });

  test('formats country flags from alpha-3 country codes', () => {
    expect(getCountryFlag('ARE')).toBe('🇦🇪');
    expect(getCountryFlag('DEU')).toBe('🇩🇪');
    expect(getCountryFlag('IRN')).toBe('🌐');
    expect(getCountryFlag('UNKNOWN')).toBe('');
  });
});
