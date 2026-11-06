// Wheelings contract tests on Hardhat's in-process network (cancun), using the exact solc 0.8.26 bytecode.
const hre = require('hardhat');
const { ethers } = require('ethers');
const fs = require('fs');
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; if (process.env.V) console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const D = 600;

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const signers = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const [a, b, c, d, e] = signers;
  const send = (m, p = []) => hre.network.provider.send(m, p);
  const now = async () => parseInt((await send('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
  const setTime = async t => { const cur = parseInt((await send('eth_getBlockByNumber', ['latest', false])).timestamp, 16); if (t > cur) await send('evm_increaseTime', [t - cur]); await send('evm_mine'); };
  const deploy = async (name, args, from = a) => { const f = new ethers.ContractFactory(art[name].abi, art[name].bytecode, from); const k = await f.deploy(...args); await k.waitForDeployment(); return k; };
  const reverts = async (p, name) => { try { const tx = await p; if (tx && tx.wait) await tx.wait(); return false; } catch (err) { const s = String(err.shortMessage || err.message) + JSON.stringify(err.revert || '', (k, v) => typeof v === 'bigint' ? v.toString() : v) + (err.data || ''); return name ? s.includes(name) || (err.revert && err.revert.name === name) || errSel(name, s) : true; } };
  const iface = new ethers.Interface(art.Wheelings.abi);
  const errSel = (name, s) => { const f = iface.getError(name); return f && s.includes(f.selector.slice(2)); };

  const t0 = await now();
  const genesis = t0 - 1000 * D + 400; // round 1000 is in progress, 400 s left
  const core = await deploy('MockCore', [genesis, D]);
  const sq = await deploy('MockSqueeks', []);
  await (await sq.give(await b.getAddress())).wait();
  const W = await deploy('Wheelings', [await core.getAddress(), await sq.getAddress()]);
  const w = who => W.connect(who);
  const G = { gasLimit: 3_000_000 };
  const round = async () => Number(await W.currentRound());
  const nextRound = async (k = 1) => { const cr = await round(); const tt = Math.max(genesis + (cr + k - 1) * D + 5, (await now()) + 1); await setTime(tt); return tt; };
  const roundAt = t => Math.floor((t - genesis) / D) + 1;

  ok(await W.genesis() == BigInt(genesis) && await W.roundDuration() == 600n && await W.maxWork() == 10000n, 'reads genesis, round length and max work from SqueekCore');
  ok(await round() === roundAt(await now()), 'currentRound follows genesis + N x 600');
  ok(await reverts(deploy('Wheelings', [await sq.getAddress(), await sq.getAddress()])), 'refuses a core that is not SqueekCore');

  // adopt
  await (await w(a).adopt(G)).wait();
  await (await w(b).adopt(G)).wait();
  ok(await W.totalSupply() == 2n && await W.ownerOf(1) === await a.getAddress() && await W.balanceOf(await a.getAddress()) == 1n, 'adopt mints one pet per address');
  ok(await reverts(w(a).adopt.staticCall(), 'AlreadyAdopted'), 'second adoption reverts');
  let p1 = await W.pet(1), p2 = await W.pet(2);
  ok(!p1.golden && p2.golden, 'Squeek holder gets the golden collar');
  ok(p1.stage == 0n && p1.mood == 0n && p1.xp == 0n, 'a new pet is a happy egg');
  ok(await reverts(w(a).transferFrom.staticCall(await a.getAddress(), await c.getAddress(), 1), 'Soulbound') && await reverts(w(a).approve.staticCall(await c.getAddress(), 1), 'Soulbound'), 'pets cannot be transferred or approved');
  ok(await W.supportsInterface('0x80ac58cd') && await W.supportsInterface('0x5b5e139f') && await W.supportsInterface('0xb45a3c0e') && !(await W.supportsInterface('0xffffffff')), 'ERC-721, metadata and ERC-5192 interfaces');
  ok(await W.locked(1) === true && await reverts(W.ownerOf(99), 'NoSuchPet') && await reverts(W.balanceOf(ethers.ZeroAddress), 'NoSuchPet'), 'locked(), unknown ids, balanceOf(0) reverts');
  ok(await W.supportsInterface('0x49064906'), 'ERC-4906 advertised');
  ok((await W.pets(1, ethers.MaxUint256)).length === 2, 'pets() with a huge count does not overflow');

  // cheer + settle + resolve
  let r = await round();
  await (await w(a).cheer(1, G)).wait();
  ok(await reverts(w(a).cheer.staticCall(1), 'AlreadyCheered'), 'one cheer per round');
  ok(await reverts(w(c).cheer.staticCall(1), 'NotYourPet'), 'only the owner can cheer');
  await (await core.setWork(r, 450)).wait();
  await (await w(a).resolve(1, G)).wait(); // not settled yet: nothing happens
  ok((await W.pet(1)).pending.length === 1 && (await W.pet(1)).xp == 0n, 'an unsettled cheer waits');
  await (await core.settle(r)).wait();
  const rc = await (await w(c).resolve(1, G)).wait(); // anyone may resolve
  p1 = await W.pet(1);
  ok(p1.xp == 450n && p1.hits == 1n && p1.streak == 1n && p1.stage == 1n && p1.pending.length === 0, 'settled running round: XP = its work, the egg hatches');
  const ev = rc.logs.map(l => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean).find(x => x.name === 'Resolved');
  ok(ev && ev.args.round == BigInt(r) && ev.args.work == 450n && ev.args.xpGained == 450n, 'Resolved event carries round, work and XP');
  ok(rc.logs.some(l => { try { return iface.parseLog(l).name === 'MetadataUpdate'; } catch { return false; } }), 'MetadataUpdate emitted when a pet changes');
  ok(await W.roundWork(r) == 450n, 'roundWork reads the certified page');
  ok(await reverts(w(a).cheer.staticCall(1), 'AlreadyCheered'), 'a round cannot be cheered again after it was scored');
  ok(await reverts(w(b).cheer.staticCall(2), 'RoundSettled'), 'a round SqueekCore already settled cannot be cheered');

  // streak over consecutive rounds: x1, x1.25, x1.5, x1.75, x2, x2 ...
  let t = await now(); let xpModel = 450, streak = 1;
  for (let k = 1; k <= 6; k++) {
    t = await nextRound(); r = await round(); 
    await (await w(a).cheer(1, G)).wait();
    await (await core.setWork(r, 400)).wait();
    await (await core.settle(r)).wait();
    streak++; xpModel += 400 + Math.floor(400 * (Math.min(streak, 5) - 1) / 4);
  }
  await (await w(a).resolve(1, G)).wait();
  p1 = await W.pet(1);
  ok(p1.xp == BigInt(xpModel) && p1.streak == BigInt(streak) && p1.bestStreak == 7n, `streak bonus maths (${p1.xp} = ${xpModel}, streak ${p1.streak})`);
  // a nap breaks the streak
  t = await nextRound(); r = await round();
  await (await w(a).cheer(1, G)).wait(); await (await core.settle(r)).wait(); await (await w(a).resolve(1, G)).wait();
  p1 = await W.pet(1);
  ok(p1.streak == 0n && p1.naps == 1n && p1.bestStreak == 7n && p1.xp == BigInt(xpModel), 'a nap round: no XP, streak resets, best kept');
  // a gap breaks the streak too
  t = await nextRound(3); r = await round();
  await (await w(a).cheer(1, G)).wait(); await (await core.setWork(r, 300)).wait(); await (await core.settle(r)).wait(); await (await w(a).resolve(1, G)).wait();
  p1 = await W.pet(1); xpModel += 300;
  ok(p1.streak == 1n && p1.xp == BigInt(xpModel), 'a run after a gap starts a new streak');

  // pending queue: six unsettled cheers, the seventh reverts; cheer auto-resolves settled ones
  const settledBefore = Number(await core.settled());
  for (let k = 0; k < 24; k++) { t = await nextRound(); await (await w(a).cheer(1, G)).wait(); }
  ok((await W.pet(1)).pending.length === 24, '24 cheers can wait for settlement');
  t = await nextRound();
  ok(await reverts(w(a).cheer.staticCall(1), 'TooManyPending'), 'a 25th pending cheer reverts');
  const pend = (await W.pet(1)).pending.map(Number);
  await (await core.setWork(pend[0], 100)).wait(); await (await core.setWork(pend[1], 0)).wait(); await (await core.setWork(pend[2], 200)).wait();
  await (await core.settle(pend[2])).wait();
  await (await w(a).cheer(1, G)).wait(); // resolves three, queues the new round
  p1 = await W.pet(1);
  ok(p1.pending.length === 22 && Number(p1.pending[0]) === pend[3] && Number(p1.pending[21]) === await round(), 'cheer scores settled rounds first and keeps order');
  // pend[0]=100 right after the 300 run (streak 2: +25), pend[1] nap, pend[2]=200 (streak 1)
  xpModel += 125 + 200;
  ok(p1.xp == BigInt(xpModel), 'queued rounds scored correctly');

  // broken core: resolve reverts, nothing lost; later it works
  await (await core.settle(await round())).wait();
  await (await core.setBroken(true)).wait();
  const xpBefore = (await W.pet(1)).xp;
  await (await w(c).resolve(1, G)).wait();
  ok((await W.pet(1)).pending.length === 22 && (await W.pet(1)).xp === xpBefore, 'a failing core page leaves cheers pending (no fake naps)');
  ok(await reverts(w(a).dropOldest.staticCall(1), 'NothingToDrop'), 'dropping is refused until a round has been stuck for a day');
  await (await core.setBroken(false)).wait();
  await (await w(c).resolve(1, G)).wait();
  ok((await W.pet(1)).pending.length === 0, 'resolves once the core is back');
  // a round stuck for a day can be dropped by its owner only
  t = await nextRound(); r = await round(); await (await w(a).cheer(1, G)).wait();
  await (await core.setBroken(true)).wait(); await (await core.settle(r + 150)).wait();
  await setTime(genesis + (r + 151) * D + 5);
  ok(await reverts(w(c).dropOldest.staticCall(1), 'NotYourPet'), 'only the owner can drop');
  await (await w(a).dropOldest(1, G)).wait();
  ok((await W.pet(1)).pending.length === 0, 'owner drops a round stuck for a day');
  await (await core.setBroken(false)).wait();

  // moods over time
  const base = await now(); const pm = await W.pet(1); const lastHit = Math.max(Number(pm.lastHit), Number(pm.lastCheer));
  await setTime(genesis + (lastHit + 145) * D - 10);
  ok((await W.pet(1)).mood == 1n, 'hungry a day after the last cheer');
  await setTime(genesis + (lastHit + 433) * D - 10);
  ok((await W.pet(1)).mood == 2n, 'sleepy after three days');
  t = await now();

  // stages
  ok(await W.stageOf(0) == 0n && await W.stageOf(1) == 1n && await W.stageOf(4999) == 1n && await W.stageOf(5000) == 2n && await W.stageOf(20000) == 3n && await W.stageOf(60000) == 4n, 'stage thresholds');

  // max work guard
  r = await round(); await (await w(b).cheer(2, G)).wait(); await (await core.setWork(r, 10001)).wait(); await (await core.settle(r)).wait();
  await (await w(b).resolve(2, G)).wait();
  ok((await W.pet(2)).xp == 10000n && (await W.pet(2)).pending.length === 0, 'a round above max work is clamped to the max, never stuck');

  // tokenURI for every stage/mood/golden mix
  const XML = s => { // tiny well-formedness check: balanced tags
    const st = []; for (const m of s.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) { if (m[3]) continue; if (m[1]) { if (st.pop() !== m[2]) return false; } else st.push(m[2]); } return st.length === 0; };
  const uri = await W.tokenURI(1);
  const j = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  const svg = Buffer.from(j.image.split(',')[1], 'base64').toString('utf8');
  ok(j.name === 'Wheeling #1' && j.attributes.length === 7 && j.attributes.find(x => x.trait_type === 'XP').value === Number((await W.pet(1)).xp), 'tokenURI is valid JSON with traits');
  ok(svg.startsWith('<svg') && XML(svg) && svg.includes('WHEELING #1'), 'image is a well-formed SVG');
  ok((await W.svgOf(2)).includes('#ffd54a'), 'golden collar drawn for a holder');

  // many pets, paging, gas
  for (const s of [c, d, e]) await (await w(s).adopt(G)).wait();
  ok((await W.svgOf(3)).includes('<ellipse cx="200" cy="260" rx="70"') && (await W.pet(3)).xp == 0n, 'an egg is drawn before the first run');
  const page = await W.pets(0, 10);
  ok(page.length === 5 && Number(page[4].id) === 5 && (await W.pets(4, 10)).length === 2 && (await W.pets(9, 3)).length === 0, 'pets() pages through the supply');
  r = await round();
  const g1 = await (await w(c).cheer(3, G)).wait();
  await (await core.setWork(r, 500)).wait(); await (await core.settle(r)).wait();
  t = await nextRound();
  const g2 = await (await w(c).cheer(3, G)).wait(); // resolves 1 + queues 1
  ok(Number(g1.gasUsed) < 150000 && Number(g2.gasUsed) < 180000, `gas: cheer ${g1.gasUsed}, cheer+resolve ${g2.gasUsed}`);
  const svgs = [];
  for (let id = 1; id <= 5; id++) svgs.push(await W.tokenURI(id));
  ok(svgs.every(u => u.startsWith('data:application/json;base64,')), 'tokenURI renders for every pet');
  fs.writeFileSync(__dirname + '/../build/sample-uris.json', JSON.stringify(svgs));

  // randomized model check: 3 pets, 300 random steps vs a JS model
  const model = {}; const pets = [[a, 1], [c, 3], [d, 4]];
  t = await nextRound();
  for (const [, id] of pets) { const v = await W.pet(id); model[id] = { xp: Number(v.xp), streak: Number(v.streak), last: Number(v.lastHit), pending: v.pending.map(Number), hits: Number(v.hits), naps: Number(v.naps), lastCheer: Number(v.lastCheer) }; }
  const workMap = {}; let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let settled = Number(await core.settled());
  const scoreModel = (m, upTo) => { while (m.pending.length && m.pending[0] <= upTo) { const rr = m.pending.shift(); const wk = workMap[rr] || 0;
      if (wk > 0) { m.streak = (m.last !== 0 && rr === m.last + 1) ? m.streak + 1 : 1; const s5 = Math.min(m.streak, 5); m.xp += wk + Math.floor(wk * (s5 - 1) / 4); m.last = rr; m.hits++; } else { m.streak = 0; m.naps++; } } };
  for (let step = 0; step < 160; step++) {
    const x = rnd();
    if (x < 0.35) { t = await nextRound(); const rr = await round(); workMap[rr] = rnd() < 0.6 ? Math.floor(rnd() * 700) : 0; await (await core.setWork(rr, workMap[rr])).wait(); }
    else if (x < 0.75) { const [s, id] = pets[Math.floor(rnd() * 3)]; const m = model[id]; const rr = await round(); scoreModel(m, settled);
      const can = rr > m.lastCheer && rr > settled && m.pending.length < 24;
      const rv = await reverts(w(s).cheer.staticCall(id)); if (!rv) await (await w(s).cheer(id, G)).wait(); if (can && !rv) { m.pending.push(rr); m.lastCheer = rr; } else if (can === !rv) { /* consistent revert */ } else { ok(false, 'cheer outcome differs from model at step ' + step); break; } }
    else if (x < 0.9) { const target = Math.min(await round() - 1, settled + 1 + Math.floor(rnd() * 3)); if (target > settled) { for (let q = settled + 1; q <= target; q++) if (workMap[q] === undefined) { workMap[q] = 0; } await (await core.settle(target)).wait(); settled = target; } }
    else { const [, id] = pets[Math.floor(rnd() * 3)]; await (await w(e).resolve(id, G)).wait(); scoreModel(model[id], settled); }
  }
  let same = true;
  for (const [, id] of pets) { await (await w(e).resolve(id, G)).wait(); scoreModel(model[id], settled); const v = await W.pet(id);
    if (Number(v.xp) !== model[id].xp || Number(v.streak) !== model[id].streak || Number(v.hits) !== model[id].hits || Number(v.naps) !== model[id].naps || v.pending.map(Number).join() !== model[id].pending.join()) { same = false; console.log('  model diff pet', id, Number(v.xp), model[id].xp, Number(v.hits), model[id].hits, v.pending.map(Number).join(), '|', model[id].pending.join()); } }
  ok(same, '160 random steps match the reference model');

  console.log(fail ? `FAILED ${fail} (passed ${pass})` : `ALL PASS (${pass})`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
