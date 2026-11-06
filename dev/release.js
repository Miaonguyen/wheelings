// Compiles Wheelings.sol alone with the release settings and writes the files needed to deploy and verify it.
const solc = require('solc'); const fs = require('fs');
const optimize = process.env.NOOPT !== '1';
const input = { language: 'Solidity', sources: { 'Wheelings.sol': { content: fs.readFileSync('../contracts/Wheelings.sol', 'utf8') } },
  settings: { optimizer: { enabled: optimize, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter(e => e.severity === 'error'); if (errs.length) { console.log(errs.map(e => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['Wheelings.sol'].Wheelings; const size = c.evm.deployedBytecode.object.length / 2;
console.log('solc', solc.version(), 'optimizer', optimize, 'runtime bytes', size, size <= 24576 ? 'OK' : 'TOO BIG');
if (!optimize) process.exit(0);
fs.mkdirSync('../release', { recursive: true });
fs.writeFileSync('../release/Wheelings.abi.json', JSON.stringify(c.abi, null, 1));
fs.writeFileSync('../release/standard-input.json', JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } }, null, 1));
fs.writeFileSync('../release/metadata.json', c.metadata);
fs.writeFileSync('../release/bytecode.txt', '0x' + c.evm.bytecode.object);
