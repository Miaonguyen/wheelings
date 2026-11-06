// Deploys MockCore (real genesis/round length), MockSqueeks and Wheelings to a running hardhat node; writes addresses.
const { ethers } = require('ethers'); const fs = require('fs');
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
(async () => {
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545'); const a = await provider.getSigner(0);
  const dep = async (n, args) => { const k = await new ethers.ContractFactory(art[n].abi, art[n].bytecode, a).deploy(...args); await k.waitForDeployment(); return k; };
  const core = await dep('MockCore', [1793022600, 600]); const sq = await dep('MockSqueeks', []);
  const W = await dep('Wheelings', [await core.getAddress(), await sq.getAddress()]);
  const round = Number(await W.currentRound());
  // history: other players, some settled work
  const others = await Promise.all([1, 2, 3].map(i => provider.getSigner(i)));
  await (await sq.give(await others[0].getAddress())).wait();
  for (const s of others) await (await W.connect(s).adopt()).wait();
  await (await core.settle(round - 1)).wait();
  fs.writeFileSync(__dirname + '/../build/e2e.json', JSON.stringify({ core: await core.getAddress(), squeeks: await sq.getAddress(), wheelings: await W.getAddress(), round }));
  console.log('deployed', await W.getAddress(), 'round', round);
})().catch(e => { console.error(e); process.exit(1); });
