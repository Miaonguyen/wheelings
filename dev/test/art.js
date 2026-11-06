// Renders pets at every stage and mood for a visual check.
const hre = require('hardhat'); const { ethers } = require('ethers'); const fs = require('fs');
const art = JSON.parse(fs.readFileSync('build/artifacts.json', 'utf8')); const D = 600;
(async () => { const provider = new ethers.BrowserProvider(hre.network.provider); const send = (m, p = []) => hre.network.provider.send(m, p);
  const signers = await Promise.all([...Array(12).keys()].map(i => provider.getSigner(i)));
  const now = async () => parseInt((await send('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
  const step = async () => { await send('evm_increaseTime', [D]); await send('evm_mine'); };
  const dep = async (n, args) => { const k = await new ethers.ContractFactory(art[n].abi, art[n].bytecode, signers[0]).deploy(...args); await k.waitForDeployment(); return k; };
  const t0 = await now(); const core = await dep('MockCore', [t0 - 1000 * D + 300, D]); const sq = await dep('MockSqueeks', []);
  const W = await dep('Wheelings', [await core.getAddress(), await sq.getAddress()]); const G = { gasLimit: 3_000_000 };
  for (let i = 0; i < 12; i++) { if (i % 3 === 0) await (await sq.give(await signers[i].getAddress())).wait(); await (await W.connect(signers[i]).adopt(G)).wait(); }
  // pet i gets i "running" rounds of max work, with streaks
  for (let k = 0; k < 11; k++) { const r = Number(await W.currentRound());
    for (let i = k + 1; i < 12; i++) await (await W.connect(signers[i]).cheer(i + 1, G)).wait();
    await (await core.setWork(r, [300, 800, 1500, 3000, 6000][k] ?? 10000)).wait(); await step(); await (await core.settle(r)).wait(); }
  for (let i = 0; i < 12; i++) await (await W.connect(signers[0]).resolve(i + 1, G)).wait();
  const out = []; for (let i = 1; i <= 12; i++) { const v = await W.pet(i); out.push({ id: i, xp: Number(v.xp), stage: Number(v.stage), mood: Number(v.mood), golden: v.golden, svg: await W.svgOf(i) }); }
  // a sleepy one: jump 4 days
  await send('evm_increaseTime', [D * 600]); await send('evm_mine'); out.push({ id: 'sleepy', svg: await W.svgOf(12), mood: Number((await W.pet(12)).mood) });
  await send('evm_increaseTime', [-D * 450]).catch(() => {});
  fs.writeFileSync('build/art.json', JSON.stringify(out)); console.log(out.map(o => o.id + ':' + o.stage + '/' + o.mood + '/' + o.xp).join(' '));
})().catch(e => { console.error(e); process.exit(1); });
