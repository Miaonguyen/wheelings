# Wheelings

On-chain pets that grow on Squeektoshi's real wheel.

Adopt a Wheeling for free on Sepolia (one per wallet, soulbound). While the hamster runs, cheer the 10-minute round in progress. When SqueekCore settles that round on Sepolia, your pet gains XP equal to the round's real work, read straight from `SqueekCore.roundPage`. Back-to-back cheered runs build a streak bonus up to ×2. A cheered round where the wheel stood still is a nap: no XP and the streak resets.

- **Stages:** Egg → Pup (first XP) → Runner (5,000) → Champion (20,000) → Legend (60,000)
- **Moods:** Happy, Hungry (no cheer for a day), Sleepy (three days)
- **Golden collar** for holders of a Squeek NFT
- **Art and metadata fully on-chain** (`tokenURI` returns JSON with an SVG); ERC-721 + ERC-5192 (locked) + ERC-4906 (metadata updates)
- **Leaderboard** read from the contract (`pets(start, count)`), feed from `Resolved` events

Nobody, including the deployer, can set XP: the contract has no owner and no admin functions. All growth comes from SqueekCore's certified round pages.

## Contracts (Sepolia)

| | |
|---|---|
| SqueekCore | `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4` |
| Squeek NFT (golden collar) | `0xc4c7982657f00509548f3a3a41db7fa439a6856b` |
| Wheelings | [`0x13c421454de930e373647cb45dd35a963c21c0a3`](https://sepolia.etherscan.io/address/0x13c421454de930e373647cb45dd35a963c21c0a3) (block 12073396) |

Constructor: `Wheelings(address core, address squeeks)`. Compiler: solc 0.8.26, optimizer on (200 runs), EVM `cancun`. `release/standard-input.json` is the exact compiler input for verification.

## How a round is scored

1. `cheer(id)` records the round in progress (owner only, once per round, up to 24 waiting).
2. SqueekCore settles rounds in batches. Anyone can call `resolve(id)`; `cheer` also resolves first.
3. For each waiting round ≤ `settledThroughRound`, the contract reads `roundPage(r-1, r, 1)`: work = `end.cumulativeWork − start.cumulativeWork` (capped at `maxWorkPerRound`).
4. Work > 0: XP += work × (1 + (min(streak,5) − 1) / 4). Work = 0: a nap.
5. If SqueekCore cannot serve a settled round, the cheer stays waiting (no fake nap). After a day the owner may `dropOldest(id)`.

## Files

- `index.html` — the whole dapp (no build step, no external scripts). Multi-wallet connect (EIP-6963 + injected), reads Sepolia over public RPCs.
- `contracts/Wheelings.sol` — the contract.
- `release/` — ABI, standard JSON input, metadata.
- `dev/` — Hardhat tests (contract unit/model tests, Playwright end-to-end against a mock SqueekCore).

Testnet only. Nothing here has value.
