#!/usr/bin/env node

const { addDescriptorChecksum } = require('../src/lib/syscoin/descriptor');
const { addressFromWif, parseWif } = require('../src/lib/syscoin/wif');

const SUPPORTED_WRAPPERS = new Set(['wpkh', 'pkh', 'combo', 'sh-wpkh']);

function usage() {
  console.log(`Usage:
  node scripts/wif-to-descriptor.js <WIF> [--network mainnet|testnet] [--wrapper wpkh|pkh|combo|sh-wpkh]
  echo "<WIF>" | node scripts/wif-to-descriptor.js [--network mainnet|testnet]

Examples:
  node scripts/wif-to-descriptor.js K... 
  node scripts/wif-to-descriptor.js c... --network testnet
  node scripts/wif-to-descriptor.js K... --wrapper sh-wpkh
`);
}

function parseArgs(argv) {
  const args = {
    network: 'mainnet',
    wrapper: 'wpkh',
    wif: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--network') {
      args.network = argv[++i];
    } else if (arg.startsWith('--network=')) {
      args.network = arg.slice('--network='.length);
    } else if (arg === '--wrapper') {
      args.wrapper = argv[++i];
    } else if (arg.startsWith('--wrapper=')) {
      args.wrapper = arg.slice('--wrapper='.length);
    } else if (!args.wif) {
      args.wif = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';
  return require('fs').readFileSync(0, 'utf8').trim();
}

function descriptorBody(wrapper, wif) {
  if (wrapper === 'sh-wpkh') return `sh(wpkh(${wif}))`;
  return `${wrapper}(${wif})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const wif = args.wif || readStdinIfAvailable();
  if (!wif) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!SUPPORTED_WRAPPERS.has(args.wrapper)) {
    throw new Error(`Unsupported wrapper: ${args.wrapper}`);
  }

  const parsed = parseWif(wif, args.network);
  const votingAddress = addressFromWif(wif, args.network);
  const descriptor = descriptorBody(args.wrapper, wif);
  const checksummedDescriptor = addDescriptorChecksum(descriptor);

  console.error('WARNING: This descriptor contains private key material. Keep it local.');
  console.log(`network=${parsed.network.name}`);
  console.log(`compressed=${parsed.compressed}`);
  console.log(`votingAddress=${votingAddress}`);
  console.log(`descriptor=${descriptor}`);
  console.log(`checksummedDescriptor=${checksummedDescriptor}`);
}

try {
  main();
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}
