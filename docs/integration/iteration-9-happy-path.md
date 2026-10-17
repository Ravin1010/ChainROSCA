# Iteration 9B — live Sepolia browser happy-path evidence

The existing Iteration 8 application completed the 20-transaction happy path against the authoritative deployment. This continuation retained transaction 1 and reused Group 2. No second group creation, deployment, funding transfer, default, arrears repayment, or production implementation change occurred.

Confirmed transaction interval (UTC): **2026-10-17T15:36:12.000Z – 2026-10-17T15:51:36.000Z**. Final browser assertions completed at 2026-10-17T15:51:40.480Z.

## Frozen baseline and safety gate

- Branch: `feature/chainrosca`; starting HEAD and evidence-commit parent: `6edf8d611342db558f979a7f397ae2a2beda1333`. Tracked tree was clean before continuation.
- Main remains `85ba63549fdbf676b24e03ac0c0d5feebe3bb134`.
- Network: Ethereum Sepolia, chain ID `11155111` (`0xaa36a7`).
- Contract: [0xF3cd73c19b49b58dFa743fB3165Aa753e839b422](https://sepolia.etherscan.io/address/0xF3cd73c19b49b58dFa743fB3165Aa753e839b422#code). Existing verified deployment retained.
- Runtime: **13,133 bytes**; keccak256 `0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc`. Local artifact and live runtime match exactly; published ABI equals artifact ABI.
- All three E2E secrets were present and all three in-memory derived public addresses matched. Values were never printed, persisted, or passed to Flask/browser state.
- Group count was 2 during the continuation gate. Group 1 was compared to its pre-run snapshot and remained untouched. Group 2 and the retained receipts were checked before continuing; no new write occurred during the browser/account-switch gates.

Public account labels used below:

| Label | Public address | Original pre-run balance (wei) | Confirmed/pending nonce before tx 5 | Final confirmed/pending nonce |
| --- | --- | --- | --- | --- |
| A1 | `0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd` | 178488155120626061 | 148 | 156 |
| A2 | `0x3e094d9068b48850f09Fc7cc70A7E24E5ed0442a` | 473366407956874919 | 301 | 305 |
| A3 | `0x890F63435Cf6F4D526F7062A282A94c74A50cFa3` | 63047830922985689 | 11 | 15 |

Every confirmed/pending pair matched. Live balances covered contribution values, conservative gas budgets, and reserves. Each write received a fresh gas estimate with a 20% integer-safe gas-limit margin; no extra funding was performed.

## Browser and temporary-runner boundary

Playwright/Chromium ran the unchanged frontend at `http://127.0.0.1:5000`, with an EIP-1193 test provider injected before initialization. Signing remained inside the Node test process. Flask and Chromium did not receive the E2E secrets. The provider enforced the armed function, account, exact arguments/value, chain, target, nonce, balance, and sequential single submission. It forbade createGroup during this continuation.

Chromium runtime dependencies and browser binaries were installed outside tracked project source. Flask startup and public config checks passed. The actual application loaded, displayed the selected public account, refreshed on A1 → A2 → A3 → A1, and passed 360-pixel dashboard/group overflow checks. Pending write controls were disabled and already-paid contribution controls became ineligible.

Temporary corrections accepted explicit indexing-unavailable outcomes independently of successful receipts and normalized address comparisons. After tx 4, an immediate latest-state read appeared stale. A new uncached read at receipt block 11935070 and at latest both confirmed the expected registered member and OPEN two-member group. The temporary runner disabled provider caching and pinned post-receipt assertions to each receipt block. Transactions 1–4 were reconciled and skipped, never replayed.

The production final-approval confirmation was displayed and accepted, including immediate activation, Round 1 start, and fixed membership/payout order. Contribution and withdrawal confirmations were also accepted through the actual frontend.

## Group configuration

| Field | Value |
| --- | --- |
| Group ID | 2 |
| Name | ChainROSCA Integration Test |
| Creator | A1 |
| Target members | 3 |
| Contribution (wei) | 100000000000000 (0.0001 ETH) |
| Round duration | 3600 seconds (60 minutes) |
| Grace period | 600 seconds (10 minutes) |
| Payout/member order | A1 → A2 → A3 |

## Ordered authoritative transaction journal

All 20 receipts succeeded at the same frozen contract. Sender labels resolve to the public addresses above. Block timestamps are UTC. Tx 1 is the original confirmed creation (nonce 146, block 11935033, gas 1,027,945).

| # | Action | Sender | Nonce | Transaction | Block | UTC | Gas used | Decoded events | Receipt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Create group | A1 | 146 | [0xe79d71e248b4989e93d9a10b086d1590e839eed633aa07925c19629506e18e0d](https://sepolia.etherscan.io/tx/0xe79d71e248b4989e93d9a10b086d1590e839eed633aa07925c19629506e18e0d) | 11935033 | 2026-10-17T15:36:12.000Z | 1027945 | GroupCreated, MemberJoined | SUCCESS |
| 2 | Request join account 2 | A2 | 300 | [0x0a9ef243a31aa06abbb8ac8148f61e48c926df61d4dbc0151d54adc112f716ce](https://sepolia.etherscan.io/tx/0x0a9ef243a31aa06abbb8ac8148f61e48c926df61d4dbc0151d54adc112f716ce) | 11935068 | 2026-10-17T15:43:36.000Z | 469503 | JoinRequested | SUCCESS |
| 3 | Request join account 3 | A3 | 10 | [0x0ab4e0b9a7f9b3318a239464997d2175c63d38078f4dcde2dcc0d4c8359a42ec](https://sepolia.etherscan.io/tx/0x0ab4e0b9a7f9b3318a239464997d2175c63d38078f4dcde2dcc0d4c8359a42ec) | 11935069 | 2026-10-17T15:43:48.000Z | 371583 | JoinRequested | SUCCESS |
| 4 | Approve account 2 | A1 | 147 | [0xab3d778e954c1ece7d4de1076523edb6696d04cb83a2de792314db980b3981b8](https://sepolia.etherscan.io/tx/0xab3d778e954c1ece7d4de1076523edb6696d04cb83a2de792314db980b3981b8) | 11935070 | 2026-10-17T15:44:00.000Z | 272430 | JoinApproved, MemberJoined | SUCCESS |
| 5 | Final approval account 3 | A1 | 148 | [0x0e89f149287c6856c4deeaf7dd1a4629d5b6b95db8daaa2310870e006dafbe54](https://sepolia.etherscan.io/tx/0x0e89f149287c6856c4deeaf7dd1a4629d5b6b95db8daaa2310870e006dafbe54) | 11935086 | 2026-10-17T15:47:12.000Z | 1080895 | JoinApproved, MemberJoined, GroupStarted | SUCCESS |
| 6 | Round 1 contribution account 1 | A1 | 149 | [0xc90dffb3aaa52dbfde015098babdef9b5819ff1d9451397af110ed84468e2c59](https://sepolia.etherscan.io/tx/0xc90dffb3aaa52dbfde015098babdef9b5819ff1d9451397af110ed84468e2c59) | 11935087 | 2026-10-17T15:47:24.000Z | 490934 | ContributionMade | SUCCESS |
| 7 | Round 1 contribution account 2 | A2 | 301 | [0x3605c06ae1eca51afa68705bdce6bfd0743f6954a250def2ae6bcee67b356955](https://sepolia.etherscan.io/tx/0x3605c06ae1eca51afa68705bdce6bfd0743f6954a250def2ae6bcee67b356955) | 11935088 | 2026-10-17T15:47:36.000Z | 393014 | ContributionMade | SUCCESS |
| 8 | Round 1 contribution account 3 | A3 | 11 | [0x33fedd7a4d140aeca90fd4855fcc650259ab890a328193fb96fcb2d6d6c06e0b](https://sepolia.etherscan.io/tx/0x33fedd7a4d140aeca90fd4855fcc650259ab890a328193fb96fcb2d6d6c06e0b) | 11935089 | 2026-10-17T15:47:48.000Z | 393014 | ContributionMade | SUCCESS |
| 9 | Settle round 1 | A1 | 150 | [0x1f82709a291399664fad9125c0f23d70ebb0635efa3529554cb3d81b0a74c061](https://sepolia.etherscan.io/tx/0x1f82709a291399664fad9125c0f23d70ebb0635efa3529554cb3d81b0a74c061) | 11935090 | 2026-10-17T15:48:00.000Z | 841747 | RoundSettled, PayoutAllocated | SUCCESS |
| 10 | Round 2 contribution account 1 | A1 | 151 | [0xb36746878f5f754a55ce2dde11b094059570783d0fc5df6358192c0c5ec23dc8](https://sepolia.etherscan.io/tx/0xb36746878f5f754a55ce2dde11b094059570783d0fc5df6358192c0c5ec23dc8) | 11935092 | 2026-10-17T15:48:24.000Z | 393014 | ContributionMade | SUCCESS |
| 11 | Round 2 contribution account 2 | A2 | 302 | [0x8f834e2292011e6a3c50ffffac72a150a8cafca5c3b967e3e29641a6956471d1](https://sepolia.etherscan.io/tx/0x8f834e2292011e6a3c50ffffac72a150a8cafca5c3b967e3e29641a6956471d1) | 11935096 | 2026-10-17T15:49:12.000Z | 295094 | ContributionMade | SUCCESS |
| 12 | Round 2 contribution account 3 | A3 | 12 | [0xaeedfdd7241f1e00536c86f105424066c5bb14318e975ca3bf44859bf1da4a69](https://sepolia.etherscan.io/tx/0xaeedfdd7241f1e00536c86f105424066c5bb14318e975ca3bf44859bf1da4a69) | 11935097 | 2026-10-17T15:49:24.000Z | 295094 | ContributionMade | SUCCESS |
| 13 | Settle round 2 | A1 | 152 | [0xbae160a4fbb60927bfe707744a84240d9de8e8ca6bb19c6a4afd75ecc6be7603](https://sepolia.etherscan.io/tx/0xbae160a4fbb60927bfe707744a84240d9de8e8ca6bb19c6a4afd75ecc6be7603) | 11935098 | 2026-10-17T15:49:36.000Z | 841747 | RoundSettled, PayoutAllocated | SUCCESS |
| 14 | Round 3 contribution account 1 | A1 | 153 | [0xb8606d021aa5ffc55383c654dcfadebc7c1813e44648b0cf227d695294831ce2](https://sepolia.etherscan.io/tx/0xb8606d021aa5ffc55383c654dcfadebc7c1813e44648b0cf227d695294831ce2) | 11935100 | 2026-10-17T15:50:00.000Z | 393014 | ContributionMade | SUCCESS |
| 15 | Round 3 contribution account 2 | A2 | 303 | [0x03bb9cf03c7819fa5c1b97e97e1663465993ac50556fee549e79d4beb1c9571c](https://sepolia.etherscan.io/tx/0x03bb9cf03c7819fa5c1b97e97e1663465993ac50556fee549e79d4beb1c9571c) | 11935102 | 2026-10-17T15:50:24.000Z | 295094 | ContributionMade | SUCCESS |
| 16 | Round 3 contribution account 3 | A3 | 13 | [0x9d4d95b84da9d51b027115961deb7b24b8d668c4e6ee83aaadac6c14c85a49c4](https://sepolia.etherscan.io/tx/0x9d4d95b84da9d51b027115961deb7b24b8d668c4e6ee83aaadac6c14c85a49c4) | 11935103 | 2026-10-17T15:50:36.000Z | 295094 | ContributionMade | SUCCESS |
| 17 | Settle round 3 | A1 | 154 | [0x225e51a6510b61b7e7072555b357a441af5439264962607271c95d0458741b9b](https://sepolia.etherscan.io/tx/0x225e51a6510b61b7e7072555b357a441af5439264962607271c95d0458741b9b) | 11935105 | 2026-10-17T15:51:00.000Z | 229988 | RoundSettled, PayoutAllocated, MemberCompleted, MemberCompleted, MemberCompleted, GroupCompleted | SUCCESS |
| 18 | Withdraw account 1 | A1 | 155 | [0xd927cb50c644a133524e9e35700afeda8ced8c02e242760f6108ed5342eb9efd](https://sepolia.etherscan.io/tx/0xd927cb50c644a133524e9e35700afeda8ced8c02e242760f6108ed5342eb9efd) | 11935106 | 2026-10-17T15:51:12.000Z | 43100 | PayoutWithdrawn | SUCCESS |
| 19 | Withdraw account 2 | A2 | 304 | [0x1a6a937b9f51816991e7ffe2fda2876ffda4f54844bf98a4c49b2517d04c56aa](https://sepolia.etherscan.io/tx/0x1a6a937b9f51816991e7ffe2fda2876ffda4f54844bf98a4c49b2517d04c56aa) | 11935107 | 2026-10-17T15:51:24.000Z | 43100 | PayoutWithdrawn | SUCCESS |
| 20 | Withdraw account 3 | A3 | 14 | [0x8d59d71f64359d63b0ea460e358f74c61ef28efc4e25379f7a711b965cf74099](https://sepolia.etherscan.io/tx/0x8d59d71f64359d63b0ea460e358f74c61ef28efc4e25379f7a711b965cf74099) | 11935108 | 2026-10-17T15:51:36.000Z | 43100 | PayoutWithdrawn | SUCCESS |

### Per-write resulting state

| # | Verified state |
| --- | --- |
| 1 | Group 2 OPEN; creator registered, payoutRound 1; memberCount 1; currentRound 0; Round 1 NOT_STARTED. |
| 2 | A2 request PENDING; applicant remains non-member; memberCount 1. |
| 3 | A3 request PENDING; applicant remains non-member; memberCount 1. |
| 4 | A2 APPROVED and REGISTERED, payoutRound 2; memberCount 2; OPEN; currentRound 0. |
| 5 | A3 APPROVED, payoutRound 3; all members ACTIVE; group ACTIVE/currentRound 1; Round 1 COLLECTING, recipient A1, expected 300000000000000, count 0. |
| 6 | Round 1: contributionCount 1, initiallyCollected 100000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 7 | Round 1: contributionCount 2, initiallyCollected 200000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 8 | Round 1: contributionCount 3, initiallyCollected 300000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 9 | Round 1 SETTLED; count 3; collected/allocated 300000000000000 to A1; recovery/shortfall 0. Group ACTIVE/currentRound 2; next round COLLECTING, recipient A2. |
| 10 | Round 2: contributionCount 1, initiallyCollected 100000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 11 | Round 2: contributionCount 2, initiallyCollected 200000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 12 | Round 2: contributionCount 3, initiallyCollected 300000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 13 | Round 2 SETTLED; count 3; collected/allocated 300000000000000 to A2; recovery/shortfall 0. Group ACTIVE/currentRound 3; next round COLLECTING, recipient A3. |
| 14 | Round 3: contributionCount 1, initiallyCollected 100000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 15 | Round 3: contributionCount 2, initiallyCollected 200000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 16 | Round 3: contributionCount 3, initiallyCollected 300000000000000; exact 100000000000000 wei contributed; duplicate action disabled. |
| 17 | Round 3 SETTLED; count 3; collected/allocated 300000000000000 to A3; recovery/shortfall 0. Group COMPLETED/currentRound 3; all members COMPLETED; each global withdrawable 300000000000000. |
| 18 | A1 withdrew 300000000000000; corresponding global withdrawable 0. |
| 19 | A2 withdrew 300000000000000; corresponding global withdrawable 0. |
| 20 | A3 withdrew 300000000000000; corresponding global withdrawable 0. |

### Gas and fee journal

| # | Raw RPC estimate | Gas limit | Max fee cap (wei/gas) | Actual gas used | Effective gas price (wei/gas) |
| --- | --- | --- | --- | --- | --- |
| 1 | 1037271 | 1244726 | 111702 | 1027945 | 60360 |
| 2 | 474396 | 569276 | 322184 | 469503 | 163686 |
| 3 | 375699 | 450839 | 327370 | 371583 | 171054 |
| 4 | 275759 | 330911 | 342106 | 272430 | 164249 |
| 5 | 1090641 | 1308770 | 500574 | 1080895 | 260115 |
| 6 | 495998 | 595198 | 520228 | 490934 | 283554 |
| 7 | 397300 | 476760 | 567106 | 393014 | 289565 |
| 8 | 397300 | 476760 | 579127 | 393014 | 295791 |
| 9 | 849595 | 1019514 | 591581 | 841747 | 307577 |
| 10 | 397300 | 476760 | 615153 | 393014 | 322548 |
| 11 | 298603 | 358324 | 645095 | 295094 | 304543 |
| 12 | 298603 | 358324 | 609085 | 295094 | 321332 |
| 13 | 849595 | 1019514 | 642663 | 841747 | 333313 |
| 14 | 397300 | 476760 | 666625 | 393014 | 352125 |
| 15 | 298603 | 358324 | 704249 | 295094 | 342279 |
| 16 | 298603 | 358324 | 684557 | 295094 | 354435 |
| 17 | 232981 | 279578 | 708869 | 229988 | 370317 |
| 18 | 155144 | 186173 | 740633 | 43100 | 396999 |
| 19 | 155144 | 186173 | 793997 | 43100 | 417990 |
| 20 | 155144 | 186173 | 835979 | 43100 | 427668 |

## Backend handoff and UI confirmation

Ethereum receipt success was authoritative. The frontend handed off only the transaction hash to `POST /api/transactions`. MongoDB was unconfigured throughout. HTTP 200 / onChainStatus confirmed / indexed false and transient 5xx outcomes did not block the lifecycle. Live state stayed usable while Indexed History reported unavailable.

Tx 1 originally received HTTP 503; a later idempotent verification of the same hash returned HTTP 200 / confirmed / indexed false. Its original frontend post-confirmation state was not captured before the previous runner stopped. Tx 4 also lacks its original UI capture because the temporary state assertion paused first; same-hash read/index reconciliation returned confirmed. These historical captures are not reconstructed or claimed as observed.

For tx 2 only, the temporary browser runner deliberately returned one labelled HTTP 503 for the history handoff. The actual production UI remained **Confirmed** and displayed **“Transaction confirmed on Sepolia. History indexing is currently unavailable.”** No blockchain transaction was retried. All captured confirmation states for txs 2, 3 and 5–20 likewise remained Confirmed with the history warning. No indexing failure was observed to override chain success.

| # | Handoff attempted | HTTP | onChainStatus | indexed | Outcome | Frontend observation | Response source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | yes | 503 initially; 200 on same-hash verification | confirmed on later verification | false on later verification | unavailable/transient-error | Original confirmation UI not captured | Original transient 503; later read/index check |
| 2 | yes | 503 | not returned | not returned | unavailable/transient-error | Confirmed; history warning; live refresh passed | controlled browser HTTP 503 |
| 3 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 4 | yes | 200 | confirmed | false | confirmed-not-indexed | Original confirmation UI not captured | idempotent same-hash read/index reconciliation |
| 5 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 6 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 7 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 8 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 9 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 10 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 11 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 12 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 13 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 14 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 15 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 16 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 17 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 18 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 19 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |
| 20 | yes | 200 | confirmed | false | confirmed-not-indexed | Confirmed; history warning; live refresh passed | Production backend response |

## Final on-chain assertions

Group 2: **COMPLETED**, targetMembers 3, memberCount 3, currentRound 3. The name, creator, amount, duration, and grace remain as configured.

| Member | Exists | Payout round | Status | totalContributed (wei) | totalArrearsRepaid | outstandingArrears | defaultCount | Final withdrawable (wei) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | true | 1 | COMPLETED | 300000000000000 | 0 | 0 | 0 | 0 |
| A2 | true | 2 | COMPLETED | 300000000000000 | 0 | 0 | 0 | 0 |
| A3 | true | 3 | COMPLETED | 300000000000000 | 0 | 0 | 0 | 0 |

| Round | Recipient | Status | expectedAmount | initiallyCollected | recoveredArrears | outstandingShortfall | contributionCount |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A1 | SETTLED | 300000000000000 | 300000000000000 | 0 | 0 | 3 |
| 2 | A2 | SETTLED | 300000000000000 | 300000000000000 | 0 | 0 | 3 |
| 3 | A3 | SETTLED | 300000000000000 | 300000000000000 | 0 | 0 | 3 |

Each of the nine member/round contribution records has contributed=true, defaulted=false, arrearsRepaid=false. Every receipt used ContributionMade (on-time). No historical default was created. Each allocation was 300000000000000 wei, and each corresponding PayoutWithdrawn event paid that exact amount. Final wallet balances were not used as payout assertions because gas affects them.

An independent final read-only audit rechecked all 20 successful receipts, target/function/value/nonce, UTC block timestamps, member/round/contribution state, final nonces, runtime identity, ABI equality, and the unchanged Group 1 snapshot.

## Screenshots

- [Account 1 connected dashboard during continuation.](screenshots/01-dashboard-account1.png)
- [Reused OPEN Group 2 after tx 4: A2 registered and A3 pending.](screenshots/02-open-group.png)
- [Atomic activation and Round 1; Confirmed status with history warning.](screenshots/04-active-round1.png)
- [Completed group after final settlement, before withdrawals.](screenshots/05-completed-group.png)
- [Final completed state after all withdrawals; all allocations zero.](screenshots/06-final-zero-withdrawable.png)

## Final local regression and scope

- `node --check static/js/helpers.js` and `node --check static/js/app.js`: passed.
- `node --test tests/test_frontend.js`: 41/41 passed.
- `python -m unittest discover -s tests -p "test_*.py"` (existing venv): 60/60 passed.
- `npx hardhat clean`, `npm run compile`, `npm test`: clean compilation; 164/164 Solidity tests passed.
- Runtime remains 13,133 bytes with the exact frozen hash; live/local bytecode equality and ABI/artifact equality passed after the clean rebuild.
- Production Solidity, test helper, frontend/backend, ABI, deployment evidence, scripts, compiler settings, dependencies, and CI are unchanged. Only this evidence document and the five purposeful screenshots are committed.
- Known credential literal/pattern scan and screenshot inspection passed. `.env` remains ignored and untracked. No private key was persisted/logged or included in evidence; temporary test tooling stays outside tracked source.
- Main is unchanged. Iteration 10 was not started. This run used an injected test provider; it does not claim to test a real MetaMask extension approval screen.
