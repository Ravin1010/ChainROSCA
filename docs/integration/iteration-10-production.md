# Iteration 10 — production deployment and hosted validation

Completed on **18 October 2026 (Asia/Kuala_Lumpur)**. Transaction timestamps below are UTC. Exactly two live Sepolia transactions were submitted: createGroup and cancelGroup. No contract redeployment, financial-lifecycle operation, wallet funding, or old-history backfill occurred.

## Production identity

| Field | Verified value |
| --- | --- |
| Repository / branch | Ravin1010/ChainROSCA / feature/chainrosca |
| Starting HEAD / evidence commit parent | `57f9e52817425c43fd2972cff52a01a848518dcb` |
| Render workspace | My Workspace / tea-d6ttr8haae7s73e5oeag |
| Render service | chainrosca / srv-db9qhlnavr4c73f2d26g |
| Public HTTPS URL | https://chainrosca.onrender.com |
| Region / plan | Singapore / free |
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app` |
| Live implementation SHA | `57f9e52817425c43fd2972cff52a01a848518dcb` |
| Automatic deployment | Disabled; final README/evidence commit is not deployed |
| Ethereum network | Sepolia / chain ID 11155111 |
| Verified contract | [0xF3cd73c19b49b58dFa743fB3165Aa753e839b422](https://sepolia.etherscan.io/address/0xF3cd73c19b49b58dFa743fB3165Aa753e839b422#code) |
| Runtime | 13,133 bytes |
| Runtime keccak256 | `0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc` |
| MongoDB database | chainrosca |

Render has exactly four application runtime variables: SEPOLIA_RPC_URL, CHAINROSCA_ADDRESS, MONGODB_URI, and MONGODB_DATABASE. Values of connection secrets are omitted. No wallet/deployment/signing key, explorer key, or Render API credential is configured in the application. Ethereum remains authoritative for all financial state; MongoDB is supplementary indexed history.

## Pre-write gate and test boundary

- Frozen HEAD and clean tracked tree verified. Main remains `85ba63549fdbf676b24e03ac0c0d5feebe3bb134`.
- Production `/` and `/api/config`: HTTP 200, exact public Sepolia/contract/ABI configuration, historySource=mongodb-index. `/api/health`: HTTP 200, status=ok, Flask healthy, MongoDB reachable, Sepolia reachable with exact runtime identity.
- Initial groupCount=2; Group 1 compared against its smoke snapshot; Group 2 compared against the completed Iteration 9 member/round/contribution state. Both unchanged.
- Initial Mongo counts: transactions=0, events=0. Only those two collections exist. No fabricated records or Group 1/2 backfill.
- Dedicated application identity checked in memory. MongoDB session roles were verified as `readWrite` only on `chainrosca`; privileges were never expanded. The same identity successfully performed index/collection access, transaction/event upserts, and history reads.
- Account 1: `0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd`. Its secret was present, the in-memory derived public address matched, and confirmed/pending nonces were 156/156. Pre-write balance was 178486721061916082 wei; conservative two-write gas reserve was 1900422298284 wei.
- Playwright Chromium loaded the actual public HTTPS frontend. A temporary EIP-1193 provider was injected before application initialization; the wallet/key remained only inside the Node process. No key reached Flask or the browser process. Only createGroup and cancelGroup could pass the armed signing bridge; target, arguments, zero value, nonce, chain, fresh RPC estimate and fee/balance reserve were checked. Gas limits used ceil(rawEstimate × 1.20).
- The hosted wallet header matched Account 1 and the browser gate submitted zero transactions before the two explicitly armed actions. Transactions were sequential, journaled by hash/nonce before broadcast, and never replayed.

## Hosted smoke group

| Field | Value |
| --- | --- |
| Receipt-derived group ID | 3 |
| Name | ChainROSCA Hosted Smoke |
| Creator / sole member | 0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd |
| Target members | 3 |
| Contribution | 100000000000000 wei / 0.0001 ETH |
| Round duration | 3600 seconds / 60 minutes |
| Grace period | 600 seconds / 10 minutes |
| Creator payout round | 1 |
| Creation transaction value | 0 wei |

The group ID came from GroupCreated, not an assumed counter. After creation the group was OPEN, memberCount=1, currentRound=0; creator REGISTERED; Round 1 NOT_STARTED. The production cancellation warning was displayed and accepted before the second transaction.

## Authoritative transactions and production indexing

| # | Function | Transaction hash | Nonce | Block | UTC | Gas used | Decoded events | Receipt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | createGroup | [0x69d3e7d3dddab5ec14014e65a0758680794569664b52c54efe2cff49cf7160b4](https://sepolia.etherscan.io/tx/0x69d3e7d3dddab5ec14014e65a0758680794569664b52c54efe2cff49cf7160b4) | 156 | 11935474 | 2026-10-17T17:12:00.000Z | 1027897 | GroupCreated, MemberJoined | SUCCESS |
| 2 | cancelGroup | [0x74d319d1311ef3a615dc8929977c85bc31816cae0802050a03e992dfcf14fffa](https://sepolia.etherscan.io/tx/0x74d319d1311ef3a615dc8929977c85bc31816cae0802050a03e992dfcf14fffa) | 157 | 11935476 | 2026-10-17T17:12:24.000Z | 148493 | GroupCancelled | SUCCESS |

Both senders were `0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd`; both targets were the frozen contract; both transaction values were zero. No contribution ETH was collected.

- Transaction 1: raw RPC estimate 1037222, gas limit 1244667, maxFeePerGas 381713 wei/gas, actual effective gas price 188316 wei/gas. Decoded event arguments: `[{"name":"GroupCreated","args":{"groupId":"3","creator":"0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd","name":"ChainROSCA Hosted Smoke","targetMembers":"3"},"logIndex":570},{"name":"MemberJoined","args":{"groupId":"3","member":"0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd","payoutRound":"1"},"logIndex":571}]`.
- Transaction 2: raw RPC estimate 149665, gas limit 179598, maxFeePerGas 376631 wei/gas, actual effective gas price 184985 wei/gas. Decoded event arguments: `[{"name":"GroupCancelled","args":{"groupId":"3"},"logIndex":256}]`.

For each mined transaction, the actual production frontend called `POST https://chainrosca.onrender.com/api/transactions` with exactly `{ "txHash": "<that hash>" }`. Both responses were HTTP 200, onChainStatus=confirmed, indexed=true. The UI displayed **Confirmed** and **“Confirmed and added to history.”** Pending write controls were disabled.

| Checkpoint | transactions | events | Result |
| --- | --- | --- | --- |
| Before writes | 0 | 0 | PASS |
| After createGroup | 1 | 2 | PASS |
| After cancelGroup | 2 | 3 | PASS |
| After both same-hash POST retries | 2 | 3 | PASS; no duplicates |
| After same-SHA Render redeployment | 2 | 3 | PASS; persisted |

Both hashes were posted once again as idempotent verifier/indexing requests only. Each returned HTTP 200, confirmed, indexed=true. These POST retries did not sign or submit blockchain transactions. Transaction documents and all event fields (excluding generated createdAt timestamps) were independently compared to fresh authoritative receipt decoding; txHash, blockNumber, logIndex, event name and args matched.

## Indexed history and final chain state

`GET /api/groups/3/history` returned HTTP 200, source=mongodb-index, mayBeIncomplete=true, and exactly three events. Their order is descending by block/log index:

| Event | Transaction | Block | Log index |
| --- | --- | --- | --- |
| GroupCancelled | 0x74d319d1311ef3a615dc8929977c85bc31816cae0802050a03e992dfcf14fffa | 11935476 | 256 |
| MemberJoined | 0x69d3e7d3dddab5ec14014e65a0758680794569664b52c54efe2cff49cf7160b4 | 11935474 | 571 |
| GroupCreated | 0x69d3e7d3dddab5ec14014e65a0758680794569664b52c54efe2cff49cf7160b4 | 11935474 | 570 |

The hosted Group Details view rendered all three history cards with matching public Etherscan transaction links. Wallet History shows the two wallet-linked creation events; GroupCancelled has no wallet field and remains available in Group 3 history. Group 1/2 history was not reconstructed. The incomplete-history notice remains appropriate because MongoDB supplements Ethereum rather than replacing it.

| State | Final result |
| --- | --- |
| groupCount | 3 |
| Group 1 | Unchanged: ACTIVE, currentRound 1, three members; original Round 1 COLLECTING |
| Group 2 | Unchanged: COMPLETED, currentRound 3, three members; rounds 1–3 SETTLED |
| Hosted Group 3 | CANCELLED, memberCount 1, currentRound 0 |
| Creator member | exists=true; CANCELLED; payoutRound=1 |
| Hosted Round 1 | NOT_STARTED |
| Hosted group financial fields | No contributions, arrears, defaults, allocations, or payout; all counters/balances zero |
| Final account confirmed/pending nonces | A1 158/158; A2 305/305; A3 15/15 |
| Iteration 10B blockchain writes | Exactly 2; no requestJoin, approval, rejection, contribution, settlement, arrears repayment, withdrawal, or deployment |

## Same-SHA redeployment and persistence

A single controlled Render redeployment replaced `dep-db9qhm7avr4c73f2d3m0` with `dep-db9qp2vbtjjs73cnpjv0`. The requested and live source remained `57f9e52817425c43fd2972cff52a01a848518dcb`. Build and startup completed, deploy status=live. Git, environment variables, build/start commands, and automatic-deploy settings were unchanged.

After recovery, public `/` and `/api/health` returned HTTP 200; status=ok, Flask healthy, MongoDB reachable, Sepolia reachable, runtimeMatch=true. Atlas retained both transaction documents and all three events; the group-history endpoint and rendered history still showed the same hashes, receipt data, and ordering. Groups 1/2 and cancelled Group 3 remained unchanged. Persistence therefore survived replacement of the Render process/container; history was stored in Atlas rather than the application filesystem.

## Final hosted browser validation

Desktop (1365px) and mobile (360px) Chromium passes covered Dashboard, Create Group form rendering without submission, wallet History, completed Group 2/payout order, and cancelled Group 3 with all three persisted event cards. Addresses and transaction links stayed within the viewport; no blocking horizontal overflow was found. These final checks used a public-account-only read provider with all signing/send methods and browser HTTP writes rejected: zero additional writes.

## Public screenshots

- [Production dashboard after same-SHA redeployment.](screenshots/10-production-dashboard.png)
- [New OPEN group with indexed GroupCreated/MemberJoined events.](screenshots/11-hosted-group-open.png)
- [CANCELLED group and three indexed events after redeployment.](screenshots/12-hosted-group-cancelled-history.png)
- [360px cancelled-group view with persisted history.](screenshots/13-production-mobile.png)

## Final regression and safety

- Frontend syntax checks passed; `node --test tests/test_frontend.js`: **41/41 passed**.
- Existing-venv `python -m unittest discover -s tests -p "test_*.py"`: **60/60 passed**.
- `npx hardhat clean`, `npm run compile`, `npm test`: clean compilation, **164/164 Solidity tests passed**.
- Fresh runtime artifact: **13,133 bytes**, exact frozen hash; published ABI/artifact equality and live runtime identity verified.
- Credential literal/pattern scan, screenshot inspection, `.env` ignore/untracked check, intended diff scope, and whitespace checks passed before commit.

Production Solidity, test helper, backend/frontend implementation, ABI, deployment metadata, dependencies, compiler configuration, scripts, and CI remain unchanged. Only README, this evidence document, and four new public screenshots are included. Earlier Iteration 9 screenshots are preserved. `.env` remains ignored/untracked. No private key, connection URI, database password, Render/explorer credential, or signed raw transaction was persisted/logged or committed. Known-credential scans and screenshot inspection are recorded before the evidence commit. Main is unchanged; Iteration 11 was not started.

Render automatic deployment stays disabled. The final README/evidence commit does not trigger a deploy; production intentionally remains on the already validated implementation SHA above.
