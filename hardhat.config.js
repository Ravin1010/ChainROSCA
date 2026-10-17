require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the pinned npm compiler so compilation needs no separate compiler download.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion === "0.8.28") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: solcVersion,
      longVersion: require("solc").version().replace(/\.Emscripten\.clang$/, ""),
    };
  }
  return runSuper();
});

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "http://127.0.0.1:8545",
      chainId: 11155111,
      // Deployment scripts construct the signer after sanitized credential checks.
      accounts: [],
    },
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
};
