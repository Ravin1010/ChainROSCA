# ChainROSCA

A decentralized Rotating Savings and Credit Association financial DApp for the
SC6113 individual assignment. This is a standalone project for small trusted
savings groups.

**Current status: Iteration 8 — responsive frontend and MetaMask/Ethers.js integration implemented.**
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
The read-only Flask/Web3.py API and optional MongoDB history index are implemented.
The responsive browser interface uses MetaMask for signing and direct Ethereum
reads. Render deployment and Iteration 9 final integration remain later work.

Join-request history uses `getJoinRequestCount(groupId)` and
`getJoinRequestsPage(groupId, offset, limit)` with pages of 1–20 entries.
These replace the full-list getter without capping the total number of applicants.

## Iteration 6 Sepolia deployment

ChainROSCA is deployed once on Sepolia (chain ID **11155111**) at
[`0xF3cd73c19b49b58dFa743fB3165Aa753e839b422`](https://sepolia.etherscan.io/address/0xF3cd73c19b49b58dFa743fB3165Aa753e839b422#code),
with **verified source**. The
[deployment transaction](https://sepolia.etherscan.io/tx/0x061154a8273fa4670d44df2099a4860356013a46222c20555493c5842e1aa96b)
was confirmed in block 11931482, using deployer nonce 140.

The local and on-chain runtime match exactly: **13,133 bytes**, keccak256
`0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc`.
Production Solidity is unchanged from frozen source commit
`aa46959ec406e336c58bdc6c343c335a7433caa4`. Solidity 0.8.28, optimizer 200 runs,
and no viaIR are retained. Only the pinned compiler's build identifier is normalized
by stripping `.Emscripten.clang` for Etherscan; the compiler package/binary is unchanged.

The membership-only smoke test passed for Group 1, `ChainROSCA Sepolia Smoke`:
three members, approval-based payout order, ACTIVE status, and Round 1 COLLECTING
with the deployer as recipient. Both temporary member keys existed only in memory.
No contribution, settlement, default, arrears repayment, or withdrawal was performed.

Smoke transactions use staged live-state estimation, a rounded-up 20% gas-limit
margin, fresh fee data, and rolling balance/reserve checks. After group creation,
balance-only read-only state overrides estimate join requests before funding;
funded requests and each approval are then independently re-estimated. Temporary
wallet funding covers only request gas with a 50% balance margin.

`deployment/sepolia.json` records deployment, verification, exact bytecode identity,
and all seven smoke transaction hashes, gas estimates/limits, receipts, funding
amounts, and public member addresses. `static/abi/ChainROSCA.json` is the ABI array
exported from the exact production artifact. The final local regression passes
**164/164 tests**.

The only added development dependency is `@nomicfoundation/hardhat-verify` 2.1.3
(Hardhat 2 compatible), using Etherscan V2. Ordinary compilation/tests need no
secrets. Supply credentials only through the ignored local `.env` or environment;
`.env.example` has empty placeholders. Never store keys or credential-bearing URLs
in logs, metadata, or Git.

```sh
npx hardhat clean
npm run compile
npm test
npm run export:abi
```

An existing deployment journal blocks another deployment. Transaction hashes and
nonces are journaled before broadcast. If confirmation is uncertain, inspect the
transaction, receipt, nonce, and state before any further action. Do not rerun the
completed deployment or smoke sequence. Temporary keys are not persisted, so a
partial smoke sequence requires inspection rather than automatic replacement.
At the Iteration 6 boundary, application integration remained future work; the
Iteration 7 backend described below now provides reads and verified indexing.

After the verifier addition, `npm audit` reports 21 affected development dependency
entries (8 high, 2 moderate, 11 low); `npm audit --omit=dev` reports zero. The added
verifier entry inherits findings through Hardhat, Undici, and ethers v5 ABI tooling.
No automatic audit fixes or frozen-toolchain upgrades were performed.

## Iteration 7 backend and history index

`app.py` provides `create_app(config=None, blockchain=None, database=None)` with
injectable services and a Gunicorn-compatible `app`. `blockchain.py` uses Web3.py
for live reads; `database.py` provides optional PyMongo history; `api_utils.py`
handles bounded validation, safe errors, and runtime-only configuration.

**Ethereum is the financial source of truth.** Current group/member/round state,
join requests, arrears, and payout balances are read from Sepolia, never MongoDB.
The backend never loads a signing key, signs, or sends a blockchain transaction.
Future application writes belong to browser → Ethers.js → MetaMask → Sepolia;
the Iteration 8 frontend below now implements this browser signing boundary.

Startup performs no RPC/Mongo connection. Blockchain calls lazily validate chain
11155111, the authoritative address, nonempty runtime, exact 13,133-byte size and
runtime hash. An address override pointing elsewhere fails closed with HTTP 503.
RPC requests have a five-second timeout and automatic provider retries disabled.
MongoDB uses bounded connection/selection/socket timeouts and a five-second
operation timeout. Failures return clean JSON without connection strings or
provider exception text. `/api/health` remains HTTP 200 with `degraded` status
when dependencies are unavailable.

Runtime configuration (single-line values in ignored `.env` or environment;
environment takes precedence):

| Variable | Purpose |
| --- | --- |
| `SEPOLIA_RPC_URL` | Private read-only RPC connection |
| `CHAINROSCA_ADDRESS` | Optional public address; must match deployment evidence |
| `MONGODB_URI` | Optional private MongoDB connection |
| `MONGODB_DATABASE` | Optional history database name |

A blank contract address defaults to the frozen deployment address. Only these
four variables enter backend configuration. Deployment private keys and Etherscan
keys are deployment-tooling-only. `.env.example` contains blank placeholders;
never add actual credentials to Git. `/api/config` exposes only public network,
contract, explorer, ABI path, and history-source configuration.

| Endpoint | Behavior |
| --- | --- |
| `GET /` | Responsive single-page frontend |
| `GET /api/health` | Flask, chain/runtime, and optional Mongo availability |
| `GET /api/config` | Public configuration only |
| `GET /api/groups/<group_id>` | Live group configuration and status |
| `GET /api/groups/<group_id>/members` | Live members in payout order and global withdrawable balances |
| `GET /api/groups/<group_id>/join-requests` | Live bounded request page: `offset=0`, `limit=20` defaults; limit 1–20 |
| `GET /api/groups/<group_id>/members/<wallet>` | Live member details and global withdrawable balance |
| `GET /api/groups/<group_id>/rounds/<round_number>` | Live round details; positive uint8 round number |
| `GET /api/groups/<group_id>/history` | Supplementary MongoDB event history |
| `GET /api/wallet/<wallet>/history` | Supplementary history matching wallet OR recipient |
| `POST /api/transactions` | Verify an already-submitted transaction hash, then index its receipt |

Addresses accept valid non-checksum casing and normalize to checksum form;
zero-address wallet subjects are rejected. Wei amounts are decimal strings.
Statuses include readable names and numeric `statusCode` fields. Uninitialized
rounds may return `NOT_STARTED` with zero fields. Errors use
`{"error":{"code":"...","message":"..."}}` with bounded public messages.

`POST /api/transactions` accepts **only** `{"txHash":"0x...64 hex characters..."}`.
It independently fetches transaction, receipt, and canonical block; checks chain,
contract target, receipt status/identity; decodes the ABI function and all logs
emitted by ChainROSCA; and requires the corresponding lifecycle/financial event.
Client claims about wallets, amounts, functions, groups, events, status or blocks
are rejected. Foreign-contract logs are ignored; uninterpretable authoritative
logs/calls are rejected. Pending transactions return HTTP 202 and `indexed:false`;
missing transactions return 404; reverted transactions return 422 without success
indexing. This checks mined/canonical state at inspection time, not finalized-chain
assurance; there is no continuous reorg monitor in this iteration.

MongoDB contains only `transactions` and `events`, with unique `txHash` and
`(txHash, logIndex)` indexes respectively. Event query indexes cover group, wallet,
recipient plus block/log order, and event name. Every indexing attempt upserts the
transaction **and every event**, repairing interrupted partial writes on retries;
unique-key races are handled. If Ethereum confirms success but MongoDB fails,
the API returns HTTP 200, `onChainStatus:"confirmed"`, `indexed:false`, and a safe
indexing warning. Retrying the same hash is supported and does not duplicate logs.

History returns `source:"mongodb-index"`, `mayBeIncomplete:true`, newest first by
block number and log index. Filters: `limit` (default 50, maximum 100), exclusive
`beforeBlock`, production `eventName`, and `round` (1–255). `beforeBlock` is a block
boundary: if a block contains more entries than one page, it cannot page within
that block. No unbounded query is offered. Wallet history matches either wallet
or recipient, including wallet-global withdrawals. Mongo outages return 503 for
history while live Ethereum reads continue working.

History covers only transactions explicitly submitted for verification/indexing;
it is neither a complete chain index nor an authoritative financial database.
No `groups` collection, background indexer, or fabricated data exists. Iteration 6
smoke transactions were **not** backfilled into MongoDB.

Run locally and execute offline backend tests:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m unittest discover -s tests -p "test_*.py"
python -m flask --app app run
```

Iteration 7 introduced 55 backend tests; its late-contribution correction raised
the retained baseline to 58. Tests use `unittest`/mocks without network, MongoDB,
or private keys. The frozen Solidity regression passes **164/164 tests**.
GitHub Actions runs it in an independent Python 3.12 job alongside unchanged
Hardhat compile/tests. Requirements and npm dependencies are unchanged in
Iteration 7. A read-only Python integration check confirmed the existing live
Group 1 is ACTIVE, current Round 1 COLLECTING, with three members and an exact
runtime match; no transactions were signed/submitted. Live MongoDB testing was
skipped because local MongoDB configuration was absent/incomplete.

## Iteration 8 browser interface

The Flask-served responsive MVP is implemented with vanilla HTML/CSS/JavaScript
and the fixed Ethers.js **6.17.0 UMD** CDN distribution. No frontend framework,
bundler, or additional npm dependency is used. If Ethers cannot load, a visible
error keeps wallet actions disabled. The browser never receives the backend RPC
URL or any MongoDB credentials. Backend implementation, Solidity, canonical ABI,
and deployment evidence remain frozen.

Views use hash navigation within `/` and survive refresh/deep linking:

- `#/dashboard`: wallet ETH balance, global payout balance, My Groups and
  Available/Open Groups from bounded discovery, plus direct Group ID lookup.
- `#/create`: fixed group terms, 3–5 members, exact ETH amount, and integer-minute
  round/grace durations; creation collects no contribution ETH.
- `#/group/<id>`: group terms, exact member payout order and financial state,
  current round/timing, connected-member contribution/default records, bounded
  join requests, historical arrears, and optional indexed history.
- `#/history`: wallet/recipient indexed event cards with Etherscan links.

**MetaMask is required for live financial reads and writes.** On mobile, open the
DApp inside the MetaMask mobile in-app browser. Connect is always user initiated;
page load never requests accounts. The interface uses MetaMask's selected RPC
through `BrowserProvider`; the signer delegates signing to MetaMask. Flask never
holds wallet private keys. Only Sepolia (11155111 / `0xaa36a7`) is allowed. A wrong
network clears live action controls and offers `wallet_switchEthereumChain`,
without adding a custom RPC. Account/network events invalidate ephemeral state
and rebuild the provider/signer as appropriate. No persistent financial cache is
used. Refresh explicitly reads current Ethereum state.

Discovery replaces pages of at most **20 group IDs**, starting with the latest.
It is not a complete list of historical personal groups; direct ID lookup remains
available. Creator join-request pages contain at most **20 applicants**, without
capping total applicants. Member financial reads and the connected wallet's
historical arrears scan are bounded by the contract's maximum **5 members/rounds**.

All nine contract actions are wired: create group, request join, approve/reject,
cancel OPEN group, contribute, settle, repay historical arrears, and withdraw the
wallet's global payout. Eligibility is re-read before each write, with exact wei
amounts, selected-account/network checks, and Sepolia block timestamps for deadline
boundaries. These checks support the UI; the contract is final authority. No partial
contribution/repayment inputs are offered. Completed/cancelled groups remain
viewable; an unwithdrawn allocation remains withdrawable after completion.

Final approval explicitly warns that it fills the group, activates immediately,
starts Round 1, and freezes membership/payout order; confirmation is required
before MetaMask opens. Cancellation and underfunded settlement also require
confirmation. Contribution, repayment and withdrawal show exact amounts for review.

A shared transaction runner presents Awaiting MetaMask → Submitted → Confirming →
Confirmed, or Failed for a known rejection/revert. Duplicate writes are locked.
Hashes link to Etherscan. Uncertain confirmations retain the hash, keep further
writes locked, and offer a read-only confirmation check; transactions are never
automatically resubmitted. After successful mining, the browser sends **only**
`{"txHash":"..."}` to the backend. Indexing failure leaves the transaction
Confirmed with a history-availability warning. Relevant live state refreshes after
confirmation. New group IDs come from the authoritative `GroupCreated` receipt
log, never from a potentially concurrent `groupCount()` read.

History is clearly labelled **Indexed history** and may be incomplete. A MongoDB
outage does not fail the group's live financial view. Cards display available
member/recipient/amount, group/round, block/time and transaction link information.
The existing backend's exclusive `beforeBlock` pagination is retained, including
its inability to page within one block. No smoke history is backfilled.

The CSS targets 360px mobile widths upward with wrapping text/addresses/amounts,
stacked forms/cards, flexible navigation and touch-sized buttons. Labels, semantic
controls, visible focus, readable contrast, text status badges and live status
regions support keyboard/screen-reader use. All untrusted on-chain/indexed text
is rendered as text, never HTML.

Run offline frontend checks after `npm ci`:

```sh
node --check static/js/helpers.js
node --check static/js/app.js
node --test tests/test_frontend.js
python -m unittest discover -s tests -p "test_*.py"
```

Current offline results: **41/41 frontend tests**, **60/60 Python tests** (the 58
backend tests plus two template/static checks), and **164/164 Solidity tests**.

Frontend tests use Node's built-in test/assert modules, the existing Ethers package,
and a small fake DOM/provider: no browser/MetaMask/CDN/network access is required.
CI runs these checks alongside the frozen Hardhat regression and Python backend
suite. Offline tests cover validation/eligibility, receipt parsing, transaction
and indexing states, account/network changes, duplicate-write prevention, final
activation confirmation, history outages and safe text rendering.

No live write, wallet funding, contract redeployment, MetaMask automation, MongoDB
production setup, or Render deployment is performed in Iteration 8. Actual wallet
approval and visual desktop/mobile browser validation remain user checks; no
browser is installed in this workspace. Iteration 9 is not started.

## Technology stack

- GitHub repository/workspace and version control
- Solidity 0.8.28, Hardhat 2 with JavaScript configuration, and Ethers.js 6
- Flask / Python with Web3.py; HTML, CSS, and JavaScript
- Ethereum Sepolia; later: MetaMask, minimal MongoDB, and Render hosting

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
Sepolia tooling and deployment evidence are described above.

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
No fixes, upgrades, or dependency changes were applied during Iteration 5.

## Python / Flask setup

Use Python 3.10 or newer (verified with Python 3.12):

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m flask --app app run
```

Open http://127.0.0.1:5000/ to view the frontend. Startup and that page need
no blockchain or MongoDB credentials; API reads/indexing use runtime configuration
as described above. Gunicorn is included for later Render deployment;
the Flask application is not deployed.

## Environment and repository layout

`.env.example` contains blank anticipated configuration values. If needed later,
copy it to `.env` and supply local values. **Never commit secrets or private keys.**

- `contracts/`, `test/`, `scripts/`, `deployment/`: Solidity and deployment tooling
- `templates/`, `static/css/`, `static/js/`, `static/abi/`: Flask frontend assets
- `app.py`: application factory, frontend root route, and JSON API
- `blockchain.py`, `database.py`: read-only Ethereum and optional indexed history services

Generated Hardhat artifacts, local dependencies, and virtual environments are
ignored. `static/abi/` remains tracked for the eventual submission ABI.
