# ChainROSCA

A decentralized Rotating Savings and Credit Association financial DApp for the
SC6113 individual assignment. This is a standalone project for small trusted
savings groups.

**Current status: Iteration 4 — arrears repayment, payout withdrawal, and completion.**
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
Further testing/security hardening, Flask, MongoDB, frontend integration, and
deployment remain later work.

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
