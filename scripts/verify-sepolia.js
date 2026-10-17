const { main, requireSafe, liveDeployment, saveEvidence, CONTRACT } = require("./sepolia-utils");

main(async () => {
  // Set before liveDeployment loads Hardhat so verification uses Sepolia.
  process.env.HARDHAT_NETWORK = "sepolia";
  const { evidence } = await liveDeployment();
  const hre = require("hardhat");
  requireSafe(hre.network.name === "sepolia", "Verification requires the Sepolia Hardhat network.");
  let verified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Do not allow plugin console output to disclose credential-bearing errors.
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;
      try {
        console.log = console.warn = console.error = () => {};
        await hre.run("verify:verify", { address: evidence.contractAddress,
          constructorArguments: [], contract: CONTRACT });
      } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
      }
      verified = true;
      break;
    } catch (error) {
      const message = String(error.message).toLowerCase();
      if (/already verified|already been verified/.test(message)) { verified = true; break; }
      const indexing = /bytecode.*not.*(found|index)|contract.*not.*(found|deploy)|unable to locate contractcode/.test(message);
      if (!indexing || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
  evidence.verification = { status: verified ? "verified" : "failed",
    explorerUrl: `https://sepolia.etherscan.io/address/${evidence.contractAddress}#code`,
    checkedAt: new Date().toISOString() };
  saveEvidence(evidence);
  requireSafe(verified, "Etherscan verification failed; stop and inspect configuration/indexing. Do not redeploy.");
  console.log(`Verified source: ${evidence.verification.explorerUrl}`);
});
