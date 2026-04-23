// Per-network consensus param resolution. Covers the env-var
// normalisation rules and a spot-check that every supported
// network's values match Syscoin Core's kernel/chainparams.cpp.
// Codex PR20 round 3 P1.

import {
  resolveNetworkId,
  getNetworkParams,
  SUPPORTED_NETWORKS,
} from './networkParams';

describe('resolveNetworkId', () => {
  test('returns mainnet for missing / empty / null inputs', () => {
    expect(resolveNetworkId(undefined)).toBe('mainnet');
    expect(resolveNetworkId(null)).toBe('mainnet');
    expect(resolveNetworkId('')).toBe('mainnet');
    expect(resolveNetworkId('   ')).toBe('mainnet');
  });

  test('accepts canonical and short forms, case-insensitive', () => {
    expect(resolveNetworkId('mainnet')).toBe('mainnet');
    expect(resolveNetworkId('main')).toBe('mainnet');
    expect(resolveNetworkId('MAIN')).toBe('mainnet');
    expect(resolveNetworkId('testnet')).toBe('testnet');
    expect(resolveNetworkId('test')).toBe('testnet');
    expect(resolveNetworkId('TestNet')).toBe('testnet');
    expect(resolveNetworkId('regtest')).toBe('regtest');
    expect(resolveNetworkId('reg')).toBe('regtest');
  });

  test('strips surrounding whitespace', () => {
    expect(resolveNetworkId('  testnet  ')).toBe('testnet');
    expect(resolveNetworkId('\tregtest\n')).toBe('regtest');
  });

  test('falls back to mainnet for unknown labels (typo guard)', () => {
    // Silent fallback is deliberate: a misspelled env var would
    // otherwise leave SUPERBLOCK_CYCLE_SEC multiplied by zero and
    // the wizard would ship zero-width windows that Core rejects
    // outright. Mainnet is the production default and the safest
    // failure mode — worst-case the user's testnet build renders
    // mainnet-sized windows, which is obviously wrong on the UI
    // but still gets submitted as valid epochs.
    expect(resolveNetworkId('signet')).toBe('mainnet');
    expect(resolveNetworkId('foobar')).toBe('mainnet');
    expect(resolveNetworkId('42')).toBe('mainnet');
  });
});

describe('SUPPORTED_NETWORKS', () => {
  test('mainnet matches Core kernel/chainparams.cpp:152', () => {
    const p = SUPPORTED_NETWORKS.mainnet;
    expect(p.id).toBe('mainnet');
    expect(p.superblockCycleBlocks).toBe(17520);
    expect(p.superblockMaturityWindowBlocks).toBe(1728);
    expect(p.targetBlockTimeSec).toBe(150);
  });

  test('testnet matches Core kernel/chainparams.cpp:314', () => {
    const p = SUPPORTED_NETWORKS.testnet;
    expect(p.id).toBe('testnet');
    expect(p.superblockCycleBlocks).toBe(60);
    expect(p.superblockMaturityWindowBlocks).toBe(20);
    expect(p.targetBlockTimeSec).toBe(150);
  });

  test('regtest matches Core kernel/chainparams.cpp:570', () => {
    const p = SUPPORTED_NETWORKS.regtest;
    expect(p.id).toBe('regtest');
    expect(p.superblockCycleBlocks).toBe(10);
    expect(p.superblockMaturityWindowBlocks).toBe(5);
    expect(p.targetBlockTimeSec).toBe(150);
  });

  test('records are frozen so callers cannot mutate consensus values', () => {
    expect(Object.isFrozen(SUPPORTED_NETWORKS)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_NETWORKS.mainnet)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_NETWORKS.testnet)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_NETWORKS.regtest)).toBe(true);
  });
});

describe('getNetworkParams (reads REACT_APP_NETWORK)', () => {
  const originalNetwork = process.env.REACT_APP_NETWORK;
  afterEach(() => {
    if (originalNetwork === undefined) {
      delete process.env.REACT_APP_NETWORK;
    } else {
      process.env.REACT_APP_NETWORK = originalNetwork;
    }
  });

  test('returns mainnet params when REACT_APP_NETWORK is unset', () => {
    delete process.env.REACT_APP_NETWORK;
    expect(getNetworkParams().id).toBe('mainnet');
    expect(getNetworkParams().superblockCycleBlocks).toBe(17520);
  });

  test('returns testnet params when REACT_APP_NETWORK=testnet', () => {
    process.env.REACT_APP_NETWORK = 'testnet';
    expect(getNetworkParams().id).toBe('testnet');
    expect(getNetworkParams().superblockCycleBlocks).toBe(60);
  });

  test('returns regtest params when REACT_APP_NETWORK=regtest', () => {
    process.env.REACT_APP_NETWORK = 'regtest';
    expect(getNetworkParams().id).toBe('regtest');
    expect(getNetworkParams().superblockCycleBlocks).toBe(10);
  });
});
