# ChainROSCA

A decentralized Rotating Savings and Credit Association financial DApp for the
SC6113 individual assignment. This is a standalone project for small trusted
savings groups.

**Current status: Iteration 0 — repository/workspace baseline only.**
No ChainROSCA business functionality has been implemented yet.

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
download is required. `contracts/TemporaryBaseline.sol` is an empty, temporary
compilation placeholder that can be removed in Iteration 1. The test command is
configured for future JavaScript Solidity tests; no contract tests exist yet.
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
nothing is deployed in Iteration 0.

## Environment and repository layout

`.env.example` contains blank anticipated configuration values. If needed later,
copy it to `.env` and supply local values. **Never commit secrets or private keys.**

- `contracts/`, `test/`, `scripts/`, `deployment/`: Solidity and future tooling
- `templates/`, `static/css/`, `static/js/`, `static/abi/`: Flask frontend assets
- `app.py`: minimal home route
- `blockchain.py`, `database.py`: inactive integration placeholders

Generated Hardhat artifacts, local dependencies, and virtual environments are
ignored. `static/abi/` remains tracked for the eventual submission ABI.
