const solc = require('solc'); const fs = require('fs');
const files = { 'Wheelings.sol': fs.readFileSync('../contracts/Wheelings.sol', 'utf8'), 'MockCore.sol': fs.readFileSync('contracts/MockCore.sol', 'utf8') };
const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])),
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: process.env.VIAIR === '1', evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter(e => e.severity === 'error'); for (const e of out.errors || []) console.log(e.severity, e.formattedMessage.split('\n').slice(0, 3).join(' | '));
if (errs.length) process.exit(1);
const art = {}; for (const [f, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtimeSize: c.evm.deployedBytecode.object.length / 2 };
fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/artifacts.json', JSON.stringify(art));
for (const [n, a] of Object.entries(art)) console.log(n, 'runtime bytes', a.runtimeSize);
