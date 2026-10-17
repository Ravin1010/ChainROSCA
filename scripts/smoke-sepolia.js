const { ethers } = require("ethers");
const { main, requireSafe, liveDeployment, saveEvidence, SafeError, submit } = require("./sepolia-utils");

main(async () => {
  const context = await liveDeployment();
  const { provider, signer, artifact, evidence } = context;
  requireSafe(evidence.contractAddress === "0xF3cd73c19b49b58dFa743fB3165Aa753e839b422", "Unexpected authoritative contract address.");
  requireSafe(evidence.verification.status === "verified", "Verify source before smoke testing.");
  const contract = new ethers.Contract(evidence.contractAddress, artifact.abi, provider);
  const amount = ethers.parseEther("0.0001");
  const margin = (value, percent) => (value * BigInt(percent) + 99n) / 100n;
  const persist = () => saveEvidence(evidence);
  function call(name, args) {
    return { to: evidence.contractAddress, data: contract.interface.encodeFunctionData(name, args), value: 0n };
  }
  function safeReason(error) {
    let text = String(error.info?.error?.message || error.shortMessage || error.message);
    for (const name of ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY", "ETHERSCAN_API_KEY"]) {
      const value = process.env[name];
      if (value) for (const literal of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) text = text.split(literal).join("[REDACTED]");
    }
    return text.replace(/([?&]api[_-]?key=)[^&\s"']*/gi, "$1[REDACTED]")
      .replace(/(["']?api[_-]?key["']?\s*:\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
      .replace(/(authorization\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]").slice(0, 1000);
  }
  async function feesNow() {
    const data = await provider.getFeeData();
    if (data.maxFeePerGas !== null && data.maxPriorityFeePerGas !== null) {
      return { fields: { maxFeePerGas: data.maxFeePerGas, maxPriorityFeePerGas: data.maxPriorityFeePerGas }, cap: data.maxFeePerGas };
    }
    requireSafe(data.gasPrice !== null, "No provider fee data; stop before signing.");
    return { fields: { gasPrice: data.gasPrice }, cap: data.gasPrice };
  }
  function publicPlan(plan) {
    return { purpose: plan.label, rawGasEstimate: plan.raw.toString(), gasLimit: plan.gasLimit.toString(),
      feeCapWei: plan.fees.cap.toString(), maximumGasCostWei: plan.maximumGasCost.toString() };
  }
  async function estimate(label, wallet, tx, balanceOverride = false) {
    const fees = await feesNow();
    let raw;
    try {
      const exact = { ...tx, from: wallet.address, ...fees.fields };
      if (balanceOverride) {
        // Only sender balance is overridden. Contract state/code and nonce are untouched.
        const rpcTx = provider.getRpcTransaction(exact);
        raw = BigInt(await provider.send("eth_estimateGas", [rpcTx, "latest", {
          [wallet.address]: { balance: ethers.toQuantity(ethers.parseEther("1")) },
        }]));
      } else raw = await provider.estimateGas(exact);
    } catch (error) {
      const reason = safeReason(error);
      if (evidence.smokeTest.status !== "pending") {
        evidence.smokeTest.lastFailure = { stage: label, balanceOverride, reason, at: new Date().toISOString() };
        persist();
      }
      throw new SafeError(`${label} estimation failed${balanceOverride ? " (balance-only state override rejected or call reverted)" : ""}: ${reason}. Stop; no automatic retry.`);
    }
    const gasLimit = margin(raw, 120);
    return { label, raw, gasLimit, fees, maximumGasCost: gasLimit * fees.cap };
  }
  async function nonceCheck(wallet) {
    const latest = await provider.getTransactionCount(wallet.address, "latest");
    requireSafe(latest === await provider.getTransactionCount(wallet.address, "pending"), "Pending sender transaction; stop before signing.");
    return latest;
  }
  async function receiptFromJournal(label) {
    const journal = evidence.smokeTest.transactions?.[label];
    if (!journal?.transactionHash) return null;
    const receipt = await provider.getTransactionReceipt(journal.transactionHash);
    requireSafe(receipt?.status === 1, `${label} journal transaction is pending, unavailable or reverted; inspect it without resubmitting.`);
    requireSafe(receipt.from.toLowerCase() === journal.sender.toLowerCase() && receipt.to?.toLowerCase() === journal.recipient.toLowerCase(), `${label} receipt/journal mismatch.`);
    Object.assign(journal, { status: "confirmed", blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), gasPriceWei: receipt.gasPrice.toString() });
    persist();
    return receipt;
  }
  async function send(label, wallet, tx, remainingCreatorOperations, remainingTransfers = 0n) {
    const prior = await receiptFromJournal(label);
    if (prior) return prior;
    await nonceCheck(wallet);
    requireSafe((await provider.getNetwork()).chainId === 11155111n, "RPC chain changed.");
    requireSafe(await provider.getCode(evidence.contractAddress) === artifact.deployedBytecode, "Runtime changed.");
    const plan = await estimate(label, wallet, tx);
    const smoke = evidence.smokeTest;
    // Rolling reserve: twice the largest observed gas limit per remaining
    // creator operation, priced at fresh fees. This is a reserve, not a gas cap.
    const observed = BigInt(smoke.largestObservedGasLimit || "0");
    const basis = observed > plan.gasLimit ? observed : plan.gasLimit;
    const reserve = wallet.address === signer.address
      ? basis * BigInt(remainingCreatorOperations) * plan.fees.cap * 2n + remainingTransfers : 0n;
    const cost = plan.maximumGasCost + (tx.value || 0n);
    const balance = await provider.getBalance(wallet.address);
    requireSafe(balance >= cost + reserve, `Insufficient smoke funding; shortfall ${(cost + reserve - balance).toString()} wei. Stop before signing.`);
    smoke.largestObservedGasLimit = basis.toString();
    const journal = { ...publicPlan(plan), recipient: tx.to, valueWei: (tx.value || 0n).toString(),
      balanceBeforeWei: balance.toString(), remainingReserveWei: reserve.toString() };
    smoke.transactions[label] = journal;
    persist();
    console.log(JSON.stringify({ transactionPlan: journal }));
    return submit(context, wallet, { ...tx, gasLimit: plan.gasLimit, ...plan.fees.fields }, journal, persist);
  }

  const preSmokeNonce = await nonceCheck(signer);
  const count = await contract.groupCount();
  if (evidence.smokeTest.status === "pending") {
    requireSafe(count === 0n, "Group already exists without a started smoke journal; do not create another.");
    const createPlan = await estimate("createGroup", signer, call("createGroup", ["ChainROSCA Sepolia Smoke", 3, amount, 3600, 600]));
    const balance = await provider.getBalance(signer.address);
    const reserve = createPlan.maximumGasCost * 8n;
    requireSafe(balance >= createPlan.maximumGasCost + reserve, "Insufficient creator funding plus rolling reserve; stop.");
    evidence.smokeTest = { status: "started", groupId: 1, creator: signer.address,
      contributionAmountWei: amount.toString(), roundDuration: 3600, gracePeriod: 600,
      preSmokeNonce, preSmokeBalanceWei: balance.toString(), transactions: {},
      largestObservedGasLimit: createPlan.gasLimit.toString(), estimationMode: "staged-live-state" };
    persist();
  }
  const smoke = evidence.smokeTest;
  requireSafe(smoke.status === "started", "Smoke already passed or has unsupported journal state; inspect without repeating transactions.");
  if (!smoke.transactions.createGroup?.transactionHash) requireSafe(count === 0n, "Group exists but creation journal is missing; stop.");
  await send("createGroup", signer, call("createGroup", ["ChainROSCA Sepolia Smoke", 3, amount, 3600, 600]), 4);
  const created = await contract.getGroupDetails(1);
  requireSafe(await contract.groupCount() === 1n && created.id === 1n && created.creator === signer.address,
    "Smoke group identity mismatch; do not create another group.");
  if (!smoke.transactions.approveMember2?.transactionHash) {
    requireSafe(created.status === 0n && created.memberCount === 1n, "Initial smoke group is not OPEN with one member.");
  }
  let members;
  if (smoke.temporaryMembers?.length) {
    const requestsConfirmed = await Promise.all(["requestJoinMember2", "requestJoinMember3"].map(receiptFromJournal));
    if (requestsConfirmed.every(Boolean)) members = smoke.temporaryMembers.map((address) => ({ address }));
    else {
      requireSafe(!smoke.transactions.fundMember2?.transactionHash && !smoke.transactions.fundMember3?.transactionHash,
        "Partial funded smoke has lost in-memory member keys. Stop; never create/fund replacement wallets automatically.");
      for (const address of smoke.temporaryMembers) {
        requireSafe(await provider.getBalance(address) === 0n && await contract.getJoinRequestStatus(1, address) === 0n,
          "Previously planned wallet has funds or request state; inspect before replacing it.");
      }
    }
  }
  if (!members) {
    members = [ethers.Wallet.createRandom().connect(provider), ethers.Wallet.createRandom().connect(provider)];
    smoke.temporaryMembers = members.map((wallet) => wallet.address);
    persist();
    const plans = [];
    // Both override estimates must succeed before either wallet is funded.
    for (const [index, wallet] of members.entries()) {
      const plan = await estimate(`requestJoinMember${index + 2}BalanceOverride`, wallet, call("requestJoin", [1]), true);
      plans.push(plan);
    }
    smoke.requestFundingPlans = plans.map((plan) => ({ ...publicPlan(plan), fundingAmountWei: margin(plan.maximumGasCost, 150).toString(), balanceOnlyOverride: true }));
    persist();
    for (const [index, wallet] of members.entries()) {
      const funding = BigInt(smoke.requestFundingPlans[index].fundingAmountWei);
      const remainingFunding = index === 0 ? BigInt(smoke.requestFundingPlans[1].fundingAmountWei) : 0n;
      await send(`fundMember${index + 2}`, signer, { to: wallet.address, value: funding }, 3 - index, remainingFunding);
      requireSafe(await provider.getBalance(wallet.address) >= funding, "Temporary wallet funding balance check failed.");
    }
    for (const [index, wallet] of members.entries()) {
      await send(`requestJoinMember${index + 2}`, wallet, call("requestJoin", [1]), 0);
      requireSafe(await contract.getJoinRequestStatus(1, wallet.address) === 1n, "Smoke request did not become PENDING.");
    }
  }
  await send("approveMember2", signer, call("approveJoinRequest", [1, members[0].address]), 1);
  if (!smoke.transactions.approveMember3?.transactionHash) {
    const intermediate = await contract.getGroupDetails(1);
    requireSafe(intermediate.status === 0n && intermediate.memberCount === 2n
      && await contract.getJoinRequestStatus(1, members[0].address) === 2n, "First approval did not preserve OPEN state.");
  }
  const activation = await send("approveMember3", signer, call("approveJoinRequest", [1, members[1].address]), 0);
  const block = await provider.getBlock(activation.blockNumber);
  const group = await contract.getGroupDetails(1);
  const ordered = [signer.address, ...members.map((wallet) => wallet.address)];
  requireSafe(group.id === 1n && group.name === "ChainROSCA Sepolia Smoke" && group.creator === signer.address
    && group.targetMembers === 3n && group.memberCount === 3n && group.contributionAmount === amount
    && group.roundDuration === 3600n && group.gracePeriod === 600n && group.currentRound === 1n
    && group.status === 1n, "Smoke group postcondition failed; stop without additional transactions.");
  requireSafe(JSON.stringify(Array.from(await contract.getMembers(1))) === JSON.stringify(ordered), "Smoke member order mismatch.");
  for (const [index, address] of ordered.entries()) {
    const member = await contract.getMemberDetails(1, address);
    requireSafe(member.exists && member.payoutRound === BigInt(index + 1) && member.status === 1n
      && member.totalContributed === 0n && member.totalArrearsRepaid === 0n
      && member.outstandingArrears === 0n && member.defaultCount === 0n, "Smoke member postcondition failed.");
    requireSafe(await contract.getWithdrawableBalance(address) === 0n, "Smoke payout balance is not zero.");
    if (index > 0) requireSafe(await contract.getJoinRequestStatus(1, address) === 2n, "Smoke request not APPROVED.");
  }
  const round = await contract.getRoundDetails(1, 1);
  requireSafe(round.number === 1n && round.recipient === signer.address && round.status === 1n
    && round.expectedAmount === 3n * amount && round.initiallyCollected === 0n && round.recoveredArrears === 0n
    && round.outstandingShortfall === 0n && round.contributionCount === 0n
    && round.startTime === BigInt(block.timestamp) && round.contributionDeadline === round.startTime + 3600n
    && round.graceDeadline === round.contributionDeadline + 600n, "Smoke Round 1 postcondition failed.");
  requireSafe(await provider.getBalance(evidence.contractAddress) === 0n, "Smoke contract unexpectedly holds ETH.");
  Object.assign(evidence.smokeTest, { status: "passed", completedAt: new Date().toISOString(),
    resultingGroupStatus: "ACTIVE", currentRound: 1, memberOrder: ordered, round1Recipient: round.recipient,
    round1StartTime: round.startTime.toString(), contributionDeadline: round.contributionDeadline.toString(),
    graceDeadline: round.graceDeadline.toString(), noFinancialTransactions: true });
  saveEvidence(evidence);
  console.log("Minimal membership-only smoke test passed; no contribution, settlement, default, arrears, or withdrawal transaction sent.");
});
