const fs = require("node:fs");
const { ethers } = require("ethers");
const { EVIDENCE, SOURCE_COMMIT, CHAIN_ID, requireSafe, main, preflight, saveEvidence, submit } = require("./sepolia-utils");

main(async () => {
  requireSafe(!fs.existsSync(EVIDENCE), "Existing deployment journal found. Inspect its transaction/receipt/nonce/code; never deploy again automatically.");
  const context = await preflight();
  const { provider, signer, artifact, fees, nonce, deploymentGasLimit } = context;
  const evidence = { network: "sepolia", chainId: CHAIN_ID, contractName: "ChainROSCA",
    status: "prepared", contractAddress: ethers.getCreateAddress({ from: signer.address, nonce }),
    deployerAddress: signer.address, contractSourceCommit: SOURCE_COMMIT,
    compiler: { version: "0.8.28", optimizerEnabled: true, optimizerRuns: 200, viaIR: false },
    abiPath: "static/abi/ChainROSCA.json", verification: { status: "pending" }, smokeTest: { status: "pending" },
    deploymentTransaction: {} };
  saveEvidence(evidence, true);
  const persist = () => {
    const tx = evidence.deploymentTransaction;
    if (tx.transactionHash) evidence.deploymentTransactionHash = tx.transactionHash;
    if (tx.nonce !== undefined) evidence.deploymentNonce = tx.nonce;
    saveEvidence(evidence);
  };
  const receipt = await submit(context, signer,
    { data: artifact.bytecode, gasLimit: deploymentGasLimit, ...fees }, evidence.deploymentTransaction, persist);
  requireSafe(receipt.contractAddress?.toLowerCase() === evidence.contractAddress.toLowerCase(), "Deployment address mismatch; stop.");
  Object.assign(evidence, { status: "confirmed", deploymentBlockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(), gasPriceWei: receipt.gasPrice.toString() });
  saveEvidence(evidence); // Preserve confirmed facts before runtime/explorer/smoke checks.
  const block = await provider.getBlock(receipt.blockNumber);
  evidence.deploymentTimestamp = new Date(block.timestamp * 1000).toISOString();
  saveEvidence(evidence);
  const code = await provider.getCode(evidence.contractAddress);
  evidence.runtimeBytecode = { localBytes: ethers.getBytes(artifact.deployedBytecode).length,
    onchainBytes: ethers.getBytes(code).length, localKeccak256: ethers.keccak256(artifact.deployedBytecode),
    onchainKeccak256: ethers.keccak256(code), exactMatch: code.toLowerCase() === artifact.deployedBytecode.toLowerCase() };
  saveEvidence(evidence);
  requireSafe(code !== "0x" && evidence.runtimeBytecode.exactMatch, "Live runtime mismatch; stop. Do not redeploy.");
  console.log(`Confirmed ChainROSCA deployment: ${evidence.contractAddress}`);
});
