const fs = require("node:fs");
const path = require("node:path");
const { ROOT, frozenArtifact, main } = require("./sepolia-utils");

main(async () => {
  const artifact = await frozenArtifact();
  const file = path.join(ROOT, "static/abi/ChainROSCA.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log("Exported canonical ABI array to static/abi/ChainROSCA.json");
});
