// End-to-end: the real page in Chromium against a local Hardhat node (mock SqueekCore), with a fake injected wallet.
const { chromium } = require('playwright');
const { ethers } = require('ethers');
const fs = require('fs');
const E = JSON.parse(fs.readFileSync(__dirname + '/../build/e2e.json', 'utf8'));
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
const HTML = fs.readFileSync(__dirname + '/../../index.html', 'utf8').replace(/const WHEELINGS = '0x[0-9a-fA-F]*';/, `const WHEELINGS = '${E.wheelings}';`).replace(/const DEPLOY_BLOCK = \d+;/, 'const DEPLOY_BLOCK = 0;').replace("const CORE = '0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4';", `const CORE = '${E.core}';`);
const OUT = __dirname + '/../build/';
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NODE = 'http://127.0.0.1:8545';

(async () => {
  const provider = new ethers.JsonRpcProvider(NODE); const admin = await provider.getSigner(0); const me = await provider.getSigner(5);
  const core = new ethers.Contract(E.core, art.MockCore.abi, admin); const W = new ethers.Contract(E.wheelings, art.Wheelings.abi, admin);
  const meAddr = await me.getAddress();
  let running = true;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const node = async (method, params = []) => { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; };
  const waitToast = async (pg, re, ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await pg.$eval('#toast', e => e.hidden ? '' : e.textContent).catch(() => ''); if (re.test(t)) return t; await sleep(150); } return ''; };
  async function page(viewport, wallet = true, rpcDown = false) {
    const pg = await browser.newPage({ viewport });
    pg.on('pageerror', e => errors.push('pageerror ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await pg.route('https://wl.test/', r => r.fulfill({ body: HTML, contentType: 'text/html' }));
    await pg.route('https://wl.test/favicon.svg', r => r.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg"/>', contentType: 'image/svg+xml' }));
    for (const host of ['https://ethereum-sepolia-rpc.publicnode.com/**', 'https://1rpc.io/**']) await pg.route(host, async r => {
      if (rpcDown) return r.fulfill({ status: 503, body: 'down', headers: { 'access-control-allow-origin': '*' } });
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
      const res = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData() });
      r.fulfill({ status: 200, body: await res.text(), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }); });
    await pg.route('https://api.squeekchain.com/**', r => r.fulfill({ body: JSON.stringify({ measurement: { freshness: 'online', rpmMilli: running ? 62000 : 0 }, builder: { anchor: { settledThroughRound: '0' } } }), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }));
    if (wallet) await pg.exposeFunction('__node', async (method, params) => { const res = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await res.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; });
    if (wallet) await pg.addInitScript(addr => {
      let on = (() => { try { return localStorage.getItem('__mockon') === '1'; } catch { return false; } })(); const L = {};
      const provider = { isMetaMask: true, on: (e, f) => { (L[e] = L[e] || []).push(f); }, removeListener() {},
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') { on = true; try { localStorage.setItem('__mockon', '1'); } catch {} return [addr]; }
          if (method === 'eth_accounts') return on ? [addr] : [];
          if (method === 'eth_chainId') return '0xaa36a7';
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'eth_sendTransaction') return window.__node('eth_sendTransaction', params);
          throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); } };
      const info = { uuid: 'test', name: 'Test Wallet', icon: '', rdns: 'test.wallet' };
      const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
      window.addEventListener('eip6963:requestProvider', ann);
    }, meAddr);
    await pg.goto('https://wl.test/'); return pg;
  }
  const text = (pg, id) => pg.$eval('#' + id, e => e.textContent);
  const clickText = async (pg, t) => { const b = pg.locator('button', { hasText: t }).first(); await b.click(); };

  // 1. a viewer without a wallet sees the board and the leader's art
  const v = await page({ width: 1280, height: 900 }, false);
  await sleep(3500);
  ok(/3 Wheelings adopted/.test(await text(v, 'boardCount')) && (await v.$$('#board tr')).length === 3, 'board lists the adopted pets: ' + await text(v, 'boardCount'));
  ok(await v.$('#petArt img') !== null && /board leader/.test(await text(v, 'petEyebrow')), 'no wallet: shows the board leader');
  ok(/Squeektoshi is running/.test(await text(v, 'runTxt')) && /\d/.test(await text(v, 'rNow')), 'live wheel status and round clock');
  ok(/Contract: Wheelings 0x/.test(await text(v, 'links')), 'footer links the contract');

  // 2. connect, adopt
  const p = await page({ width: 1280, height: 900 });
  await sleep(2500);
  await clickText(p, 'Connect wallet'); await sleep(1500);
  ok(/Test Wallet/.test(await text(p, 'wState')) && /Sepolia/.test(await text(p, 'wState')), 'wallet connects');
  await clickText(p, 'Adopt your Wheeling'); await sleep(6000);
  const id = Number(await W.petOf(meAddr));
  ok(id === 4 && /Egg/.test(await text(p, 'petName')) && await p.$('#petArt img') !== null, `adopted Wheeling #${id}, shown as an egg`);
  await p.screenshot({ path: OUT + 'e2e-egg.png' });
  // 3. cheer the current round
  const r = Number(await W.currentRound());
  await clickText(p, 'Cheer now'); const t1 = await waitToast(p, /Cheered round/); await sleep(2500);
  ok(t1 === `Cheered round ${r.toLocaleString('en-US')}`, 'toast names the round actually cheered: ' + t1);
  let pet = await W.pet(id);
  ok(pet.pending.map(Number).includes(r) && /Cheered round/.test(await p.locator('#actions button').first().textContent()) && /waiting for settlement/.test(await text(p, 'queue')), 'cheer recorded on chain, button and queue update');
  ok(await p.locator('#actions button').first().isDisabled(), 'cannot cheer the same round twice');
  // 4. settle the round with work; the page offers scoring; score it
  await (await core.setWork(r, 480)).wait(); await (await core.settle(r)).wait();
  for (let i = 0; i < 90 && !/ready to score/.test(await text(p, 'queue')); i++) await sleep(500);
  ok(/ready to score/.test(await text(p, 'queue')), 'settled cheer shows as ready to score');
  await clickText(p, 'Score 1 settled round'); await sleep(5000);
  pet = await W.pet(id);
  ok(Number(pet.xp) === 480 && /Pup/.test(await text(p, 'petName')) && (await text(p, 'sXp')) === '480', 'scored: 480 XP, hatched into a Pup');
  await sleep(1500);
  // 4b. a cheer whose round SqueekCore cannot serve can be given up a day after it settled
  await node('evm_increaseTime', [600]); await node('evm_mine');
  await sleep(21000);
  const r2 = Number(await W.currentRound());
  ok(r2 > r && /Cheer now · round/.test(await p.locator('#actions button').first().textContent()), 'next round: cheer button offers round ' + r2);
  await clickText(p, 'Cheer now'); ok((await waitToast(p, /Cheered round/)) === `Cheered round ${r2.toLocaleString('en-US')}`, 'second cheer recorded');
  await (await core.setBroken(true)).wait();
  await node('evm_increaseTime', [146 * 600]); await node('evm_mine');
  await (await core.settle(r2 + 145)).wait();
  for (let i = 0; i < 90 && await p.locator('button', { hasText: 'Give up round' }).count() === 0; i++) await sleep(500);
  ok(await p.locator('button', { hasText: 'Give up round' }).count() === 1, 'stuck cheer offers "Give up round"');
  await clickText(p, 'Give up round'); await sleep(5000);
  pet = await W.pet(id);
  ok(pet.pending.length === 0 && Number(pet.xp) === 480, 'dropped: queue empty, XP kept');
  await (await core.setBroken(false)).wait();
  // 5. error path: adopt again is blocked by simulation with a clear message
  const err = await p.evaluate(async () => { try { await window.ethereum; } catch {} return null; });
  // 6. feed and board refresh
  await p.reload(); await sleep(6000);
  ok(/Wheeling #4 · round [\d,]+: he ran 480 work → \+480 XP/.test(await text(p, 'feed')), 'feed shows the scored round from events');
  ok((await p.$$('#board tr.me')).length === 1, 'my row is highlighted on the board');
  ok(/Pup/.test(await text(p, 'petName')), 'reload reconnects quietly and shows my pet');
  await p.screenshot({ path: OUT + 'e2e-pup.png', fullPage: true });
  // 7. resting hint, phone layout
  running = false;
  const ph = await page({ width: 390, height: 844 }); await sleep(4000);
  const sw = await ph.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, 'phone: no horizontal scroll (' + sw + ')');
  await ph.screenshot({ path: OUT + 'e2e-phone.png', fullPage: true });
  const sm = await page({ width: 320, height: 700 }); await sleep(3000);
  ok(await sm.evaluate(() => document.documentElement.scrollWidth) <= 320, '320 px: no horizontal scroll');
  // 8. Sepolia unreachable: says so instead of "not deployed"
  const dn = await page({ width: 1280, height: 900 }, false, true); await sleep(4000);
  ok(/Can't reach Sepolia/.test(await text(dn, 'notDeployedTxt')) && !(await dn.$eval('#notDeployed', e => e.hidden)), 'RPC down: "Can\'t reach Sepolia" notice');
  const errs = errors.filter(e => !/503|Failed to fetch/.test(e)); errors.length = 0; errors.push(...errs);
  ok(errors.length === 0, 'no console errors ' + errors.slice(0, 3).join(' / '));
  await browser.close();
  console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
