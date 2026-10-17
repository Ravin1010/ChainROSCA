const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
require("dotenv").config();

const ROOT = path.resolve(__dirname, "..");
const EVIDENCE = path.join(ROOT, "deployment/sepolia.json");
const CONTRACT = "contracts/ChainROSCA.sol:ChainROSCA";
const SOURCE_COMMIT = "aa46959ec406e336c58bdc6c343c335a7433caa4";
const SOURCE_SHA256 = "a1018c624e774930421a75246e65b6f164c025db20fc4d7a00e88d700331d4ab";
const RUNTIME_HASH = "0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc";
const CHAIN_ID = 11155111;
const providers = new Set();
class SafeError extends Error {}
function requireSafe(condition, message) { if (!condition) throw new SafeError(message); }

// Never print raw provider/plugin errors: they can include credential-bearing URLs.
function main(action) {
  Promise.resolve().then(action).catch((error) => {
    console.error(error instanceof SafeError ? error.message
      : "Operation failed. Inspect public transaction evidence before retrying; raw provider errors are suppressed.");
    process.exitCode = 1;
  }).finally(() => {
    for (const provider of providers) provider.destroy();
  });
}

async function frozenArtifact() {
  const hre = require("hardhat");
  const artifact = await hre.artifacts.readArtifact(CONTRACT);
  const info = await hre.artifacts.getBuildInfo(CONTRACT);
  const source = fs.readFileSync(path.join(ROOT, "contracts/ChainROSCA.sol"), "utf8");
  requireSafe(crypto.createHash("sha256").update(source).digest("hex") === SOURCE_SHA256,
    "Frozen production source mismatch; stop.");
  requireSafe(info && info.input.sources["contracts/ChainROSCA.sol"].content === source,
    "Artifact source mismatch; perform a clean compile.");
  const settings = info.input.settings;
  requireSafe(info.solcVersion === "0.8.28" && settings.optimizer.enabled === true
    && settings.optimizer.runs === 200 && !settings.viaIR && settings.evmVersion === "paris",
  "Frozen compiler settings mismatch; stop.");
  const runtimeBytes = ethers.getBytes(artifact.deployedBytecode).length;
  requireSafe(runtimeBytes === 13133 && runtimeBytes < 24576
    && ethers.keccak256(artifact.deployedBytecode) === RUNTIME_HASH, "Frozen runtime mismatch; stop.");
  return artifact;
}

function credentials() {
  const names = ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY", "ETHERSCAN_API_KEY"];
  const missing = names.filter((name) => !process.env[name]?.trim());
  requireSafe(!missing.length, `Missing local environment variables: ${missing.join(", ")}. No transaction submitted.`);
  let url, signer;
  try {
    url = new URL(process.env.SEPOLIA_RPC_URL);
    requireSafe(["http:", "https:"].includes(url.protocol), "Invalid RPC protocol.");
    signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY);
  } catch { throw new SafeError("Invalid local RPC URL or deployer private key; no transaction submitted."); }
  const request = new ethers.FetchRequest(url.toString());
  request.timeout = 30000;
  const provider = new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  providers.add(provider);
  return { provider, signer: signer.connect(provider) };
}

async function feePlan(provider) {
  const data = await provider.getFeeData();
  requireSafe(data.maxFeePerGas !== null && data.maxPriorityFeePerGas !== null,
    "EIP-1559 fee data unavailable; stop before signing.");
  return { maxFeePerGas: data.maxFeePerGas * 2n,
    maxPriorityFeePerGas: data.maxPriorityFeePerGas };
}

async function preflight() {
  const { provider, signer } = credentials();
  requireSafe((await provider.getNetwork()).chainId === BigInt(CHAIN_ID), "RPC chain is not Ethereum Sepolia; stop.");
  const artifact = await frozenArtifact();
  const abiPath = path.join(ROOT, "static/abi/ChainROSCA.json");
  requireSafe(fs.existsSync(abiPath) && JSON.stringify(JSON.parse(fs.readFileSync(abiPath, "utf8")))
    === JSON.stringify(artifact.abi), "Export the canonical ABI before preflight/deployment.");
  const [balance, nonce, pendingNonce, fees] = await Promise.all([
    provider.getBalance(signer.address), provider.getTransactionCount(signer.address, "latest"),
    provider.getTransactionCount(signer.address, "pending"), feePlan(provider),
  ]);
  requireSafe(nonce === pendingNonce, "Deployer has pending transactions; resolve them before proceeding.");
  const estimate = await provider.estimateGas({ from: signer.address, data: artifact.bytecode });
  const deploymentGasLimit = (estimate * 120n + 99n) / 100n;
  // Creator: creation + 2 approvals + 2 wallet transfers. Each join wallet gets
  // a 250k-gas budget; add 50% overall funding margin. No contribution ETH needed.
  const smokeGasBudget = 500000n + 2n * 400000n + 2n * 21000n + 2n * 250000n;
  const minimumBalance = (deploymentGasLimit + smokeGasBudget) * fees.maxFeePerGas * 3n / 2n;
  requireSafe(balance >= minimumBalance, "Insufficient Sepolia test ETH for deployment plus minimal smoke test and margin.");
  console.log(JSON.stringify({ chainId: CHAIN_ID, deployerAddress: signer.address,
    balanceWei: balance.toString(), confirmedNonce: nonce, pendingNonce,
    deploymentEstimatedGas: estimate.toString(), deploymentGasLimit: deploymentGasLimit.toString(),
    maxFeePerGasWei: fees.maxFeePerGas.toString(), maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(),
    conservativeMinimumBalanceWei: minimumBalance.toString(), runtimeBytes: 13133 }, null, 2));
  return { provider, signer, artifact, fees, nonce, deploymentGasLimit };
}

function readEvidence() {
  requireSafe(fs.existsSync(EVIDENCE), "No deployment evidence exists; do not invent a deployment address.");
  return JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
}

function saveEvidence(data, exclusive = false) {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  if (exclusive) fs.writeFileSync(EVIDENCE, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  else {
    fs.writeFileSync(EVIDENCE + ".tmp", JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(EVIDENCE + ".tmp", EVIDENCE);
  }
}

async function liveDeployment() {
  const context = credentials();
  requireSafe((await context.provider.getNetwork()).chainId === BigInt(CHAIN_ID), "RPC chain is not Sepolia.");
  const artifact = await frozenArtifact();
  const evidence = readEvidence();
  requireSafe(evidence.chainId === CHAIN_ID && evidence.status === "confirmed"
    && ethers.isAddress(evidence.contractAddress), "Deployment is not confirmed; reconcile its public transaction journal first.");
  const receipt = await context.provider.getTransactionReceipt(evidence.deploymentTransactionHash);
  requireSafe(receipt?.status === 1 && receipt.contractAddress?.toLowerCase() === evidence.contractAddress.toLowerCase(),
    "Deployment receipt mismatch or unavailable; stop without redeployment.");
  const code = await context.provider.getCode(evidence.contractAddress);
  requireSafe(code !== "0x" && code.toLowerCase() === artifact.deployedBytecode.toLowerCase(),
    "Live runtime mismatch; stop without verification, smoke testing, or redeployment.");
  requireSafe(evidence.deployerAddress === context.signer.address, "Configured signer differs from recorded deployer.");
  return { ...context, artifact, evidence };
}

// Persist hash and nonce BEFORE broadcasting. An uncertain send must never be
// retried automatically. The journal contains no signed payload or private key.
async function submit(context, wallet, tx, journal, persist) {
  const { provider } = context;
  requireSafe((await provider.getNetwork()).chainId === BigInt(CHAIN_ID), "RPC chain changed; stop before signing.");
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  requireSafe(nonce === await provider.getTransactionCount(wallet.address, "pending"), "Pending sender nonce; stop.");
  if (!tx.to) requireSafe(nonce === context.nonce, "Deployment nonce changed since preflight; stop before signing.");
  const feeCap = tx.maxFeePerGas ?? tx.gasPrice;
  requireSafe(feeCap !== undefined && await provider.getBalance(wallet.address) >= (tx.value || 0n) + tx.gasLimit * feeCap,
    "Sender has insufficient test ETH for this transaction; stop before signing.");
  const raw = await wallet.signTransaction({ ...tx, from: undefined, chainId: CHAIN_ID, nonce, type: tx.gasPrice !== undefined ? 0 : 2 });
  const hash = ethers.keccak256(raw);
  Object.assign(journal, { transactionHash: hash, sender: wallet.address, nonce, status: "signed" });
  persist();
  console.log(JSON.stringify({ transactionHash: hash, nonce, sender: wallet.address }));
  await provider.broadcastTransaction(raw);
  journal.status = "submitted";
  persist();
  const receipt = await provider.waitForTransaction(hash, 1, 60000);
  requireSafe(receipt !== null, `Transaction pending or uncertain: ${hash}; do not resubmit.`);
  Object.assign(journal, { status: receipt.status === 1 ? "confirmed" : "reverted",
    blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), gasPriceWei: receipt.gasPrice.toString() });
  persist();
  requireSafe(receipt.status === 1, `Transaction reverted: ${hash}; stop and inspect evidence.`);
  return receipt;
}

module.exports = { ROOT, EVIDENCE, CONTRACT, SOURCE_COMMIT, CHAIN_ID, SafeError, requireSafe,
  main, frozenArtifact, credentials, feePlan, preflight, readEvidence, saveEvidence, liveDeployment, submit };
