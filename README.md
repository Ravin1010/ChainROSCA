# ChainROSCA

A decentralized Rotating Savings and Credit Association financial DApp for the
SC6113 individual assignment. This is a standalone project for small trusted
savings groups.

**Current status: Iteration 5 — contract test and security hardening completed.**
`contracts/ChainROSCA.sol` supports group creation (3–5 members), join requests,
creator approval/rejection, approval-based payout order, and cancellation before
activation. The creator is Member 1. Final approval automatically activates the
group and initializes Round 1 timing metadata; there is no `startGroup()` function.
ACTIVE members, including the scheduled recipient, can contribute the exact fixed
ETH amount once in the current round. Payments through the normal deadline are
on-time; payments after it through the grace deadline are late but accepted.
Contribution records and member/round accounting are updated, and ETH stays in the
contract. Anyone can settle a fully funded round immediately, or an underfunded
round strictly after grace expires. Missing contributions become permanent
historical defaults, with member arrears and round shortfall recorded. Settlement
allocates the actual collected ETH to the recipient and automatically advances
through the fixed payout order. Members can repay exact historical arrears,
updating the original round's recovery/shortfall accounting and crediting its
original recipient while preserving default history. Global payouts can be
withdrawn in full with checks/effects/interactions and a local reentrancy guard.
Completion is automatic once the final round settles and all arrears are cleared;
unwithdrawn payouts do not block it. The core Solidity lifecycle is implemented.
Flask, MongoDB, frontend integration, and deployment remain later work.

Join-request history uses `getJoinRequestCount(groupId)` and
`getJoinRequestsPage(groupId, offset, limit)` with pages of 1–20 entries.
These replace the full-list getter without capping the total number of applicants.

## Technology stack

- GitHub repository/workspace and version control
- Solidity 0.8.28, Hardhat 2 with JavaScript configuration, and Ethers.js 6
- Flask / Python with Web3.py; HTML, CSS, and JavaScript
- Later: Ethereum Sepolia, MetaMask, minimal MongoDB, and Render hosting

## Node / Hardhat setup

Use Node.js 22 or 24 LTS (verified with Node.js 24) and npm:

```sh
npm ci
npm run compile
npm test
```

Hardhat uses the pinned `solc` npm package for compilation; no separate compiler
download is required. `test/ChainROSCA.test.js` verifies the Iteration 1 lifecycle,
validation, authorization, activation metadata, cancellation, and Iteration 2
contributions, timing boundaries, accounting, custody, and Iteration 3 settlement,
defaults, payout allocations, round progression, and Iteration 4 repayment,
withdrawal safety, completion, and ABI scope. `contracts/test/WithdrawalReceiver.sol`
is a test-only receiver for failed transfers and reentrancy checks.
No deployment scripts or Sepolia network are configured in this iteration.

## Security/testing status

Iteration 5 retains the 149-test baseline and adds 15 adversarial/invariant tests
(164 passing). Production Solidity, the test receiver, compiler configuration,
dependencies, and CI are unchanged. Complete 3-, 4-, and 5-member rotations cover
repeated defaults, out-of-order recovery, automatic completion, and withdrawals.
An independent test model checks payments, allocations, custody, member debt,
per-round accounting, immutable default history, and one-time transition events
after each meaningful action. Cross-group/round snapshots, exact timing boundaries,
failed transactions, rejecting receivers, and nested withdrawals are checked.
Pagination regression tests remain intact.

Manual state-changing-function review:

| Function | Authorization and principal checks |
| --- | --- |
| `createGroup` | Public; nonempty name, size 3–5, positive amount/durations; nonpayable |
| `requestJoin` | Caller requests self; existing OPEN group, nonmember, capacity, NONE/REJECTED request |
| `approveJoinRequest` | Creator; OPEN, nonzero applicant, pending request, nonmember, capacity |
| `rejectJoinRequest` | Creator; OPEN, nonzero applicant, pending request |
| `cancelGroup` | Creator; existing OPEN group |
| `contribute` | Existing ACTIVE group, actual ACTIVE/OUTSTANDING member, initialized COLLECTING round, no prior payment, exact value, inclusive grace |
| `settleRound` | Permissionless; ACTIVE, initialized COLLECTING round, all paid or strictly after grace |
| `repayArrears` | Caller's own default; ACTIVE/COMPLETED group, valid SETTLED round, unrepaid default, exact value |
| `withdrawPayout` | Caller’s positive global balance; zeroed before required-success ETH call; local reentrancy guard |

Source/ABI review found no new defect requiring production repair. Checked
arithmetic and lifecycle guards preserve accounting; repayment retains historical
defaults. The only outgoing call is withdrawal to `msg.sender`; the guard reset
after that call is intentional. There is no delegatecall, selfdestruct, assembly,
tx.origin authorization, receive/fallback, or arbitrary call target. The four
member loops (`cancelGroup`, `settleRound`, `_updateCompletion`, `_activateGroup`)
are bounded by 5; the pagination loop is bounded by 20. The nine state-changing
functions above and the existing read interface are the complete public surface;
only `contribute` and `repayArrears` are payable. No full-history getter remains.

Clean compilation with Solidity 0.8.28, optimizer enabled/200 runs, and no viaIR
produces **13,133 runtime bytes**, leaving **11,443 bytes** below the 24,576-byte
EIP-170 limit, with no compiler warnings. Representative local receipt measurements
(five-member group; reproducible in the gas test):

| Operation | Gas used |
| --- | ---: |
| Final approval / activation | 281,683 |
| First on-time contribution | 131,754 |
| Fully funded non-final settlement | 217,707 |
| Zero-funded non-final settlement after grace (five defaults) | 713,496 |
| First historical arrears repayment | 143,117 |
| Fully funded final settlement and completion | 135,044 |
| Global payout withdrawal | 45,776 |

These measurements reflect different storage writes, not arbitrary pass/fail gas
thresholds; no abnormal growth was observed at the maximum five-member size.

`npm audit` on 17 October 2026 reports **20 affected dependency entries** (7 high,
2 moderate, 11 low; 0 critical), referencing 30 distinct advisory records.
All are development-tool dependencies; `npm audit --omit=dev` reports **0**.
They do not execute in deployed Solidity. Findings include Mocha serialization/diff,
Undici HTTP handling, archive extraction, temporary files, and transitive crypto.
The current serial local tests and pinned local compiler do not exercise the
parallel-worker serialization, downloaded-compiler archive, or SMT temporary-file
paths. Network/provider and malicious-input tooling exposure warrants review
before remote deployment; this is not a claim that the tooling is vulnerability-free.
Review compatible Mocha/diff/serialize-javascript patches and the Hardhat dependency
chain later; npm also proposes major Hardhat/plugin migrations for some findings.
No fixes, upgrades, or dependency changes were applied. Deployment remains future work.

## Python / Flask setup

Use Python 3.10 or newer (verified with Python 3.12):

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m flask --app app run
```

Open http://127.0.0.1:5000/ to view the baseline page. No blockchain or MongoDB
credentials are needed. Gunicorn is included for later Render deployment;
nothing is deployed.

## Environment and repository layout

`.env.example` contains blank anticipated configuration values. If needed later,
copy it to `.env` and supply local values. **Never commit secrets or private keys.**

- `contracts/`, `test/`, `scripts/`, `deployment/`: Solidity and future tooling
- `templates/`, `static/css/`, `static/js/`, `static/abi/`: Flask frontend assets
- `app.py`: minimal home route
- `blockchain.py`, `database.py`: inactive integration placeholders

Generated Hardhat artifacts, local dependencies, and virtual environments are
ignored. `static/abi/` remains tracked for the eventual submission ABI.
