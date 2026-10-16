const assert = require("node:assert/strict");
const { ethers, artifacts } = require("hardhat");

const GROUP = { OPEN: 0n, ACTIVE: 1n, CANCELLED: 3n };
const MEMBER = { REGISTERED: 0n, ACTIVE: 1n, CANCELLED: 4n };
const REQUEST = { NONE: 0n, PENDING: 1n, APPROVED: 2n, REJECTED: 3n };
const AMOUNT = ethers.parseEther("0.01");
const DURATION = 3600n;
const GRACE = 600n;

describe("ChainROSCA — Iteration 1", function () {
  let contract, creator, alice, bob, carol, dave, outsider;

  beforeEach(async function () {
    [creator, alice, bob, carol, dave, outsider] = await ethers.getSigners();
    contract = await ethers.deployContract("ChainROSCA");
    await contract.waitForDeployment();
  });

  async function create(target = 3) {
    const tx = await contract.createGroup("Savings circle", target, AMOUNT, DURATION, GRACE);
    return tx.wait();
  }

  async function request(wallet) {
    return (await contract.connect(wallet).requestJoin(1)).wait();
  }

  async function approve(wallet) {
    return (await contract.approveJoinRequest(1, wallet.address)).wait();
  }

  async function activate() {
    await request(alice);
    await request(bob);
    await approve(alice);
    return approve(bob);
  }

  async function reverts(action, message) {
    await assert.rejects(async () => {
      const result = await action;
      if (result.wait) await result.wait();
    }, (error) => error.message.includes(message));
  }

  function event(receipt, name) {
    const matches = receipt.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
      .filter((log) => log && log.name === name);
    assert.equal(matches.length, 1, `Expected one ${name} event`);
    return matches[0].args;
  }

  function zeroFinances(member) {
    for (const field of ["totalContributed", "totalArrearsRepaid", "outstandingArrears", "defaultCount"]) {
      assert.equal(member[field], 0n, field);
    }
  }

  describe("group creation", function () {
    for (const target of [3, 5]) {
      it(`creates a valid ${target}-member group with the configured scalar fields`, async function () {
        const receipt = await create(target);
        const group = await contract.getGroupDetails(1);
        assert.equal(group.id, 1n);
        assert.equal(group.name, "Savings circle");
        assert.equal(group.creator, creator.address);
        assert.equal(group.targetMembers, BigInt(target));
        assert.equal(group.contributionAmount, AMOUNT);
        assert.equal(group.roundDuration, DURATION);
        assert.equal(group.gracePeriod, GRACE);
        assert.equal(group.currentRound, 0n);
        assert.equal(group.status, GROUP.OPEN);
        assert.equal(group.memberCount, 1n);
        assert.equal(await contract.groupCount(), 1n);
        const created = event(receipt, "GroupCreated");
        assert.equal(created.groupId, 1n);
        assert.equal(created.creator, creator.address);
        assert.equal(created.name, "Savings circle");
        assert.equal(created.targetMembers, BigInt(target));
      });
    }

    const invalid = [
      ["target below 3", ["Circle", 2, AMOUNT, DURATION, GRACE], "Target members must be 3 to 5"],
      ["target above 5", ["Circle", 6, AMOUNT, DURATION, GRACE], "Target members must be 3 to 5"],
      ["empty name", ["", 3, AMOUNT, DURATION, GRACE], "Name is required"],
      ["zero contribution", ["Circle", 3, 0, DURATION, GRACE], "Contribution must be positive"],
      ["zero duration", ["Circle", 3, AMOUNT, 0, GRACE], "Round duration must be positive"],
      ["zero grace period", ["Circle", 3, AMOUNT, DURATION, 0], "Grace period must be positive"],
    ];
    for (const [label, args, message] of invalid) {
      it(`rejects ${label} without allocating a group ID`, async function () {
        await reverts(contract.createGroup(...args), message);
        assert.equal(await contract.groupCount(), 0n);
      });
    }

    it("registers the creator as Member 1 with zero financial counters", async function () {
      const receipt = await create();
      assert.deepEqual(Array.from(await contract.getMembers(1)), [creator.address]);
      const member = await contract.getMemberDetails(1, creator.address);
      assert.equal(member.exists, true);
      assert.equal(member.payoutRound, 1n);
      assert.equal(member.status, MEMBER.REGISTERED);
      zeroFinances(member);
      const joined = event(receipt, "MemberJoined");
      assert.equal(joined.groupId, 1n);
      assert.equal(joined.member, creator.address);
      assert.equal(joined.payoutRound, 1n);
    });

    it("returns the next group ID and keeps groups independent", async function () {
      await create();
      assert.equal(await contract.connect(alice).createGroup.staticCall("Second", 5, 1, 2, 3), 2n);
      await contract.connect(alice).createGroup("Second", 5, 1, 2, 3);
      await request(bob);
      assert.equal(await contract.groupCount(), 2n);
      assert.deepEqual(Array.from(await contract.getMembers(2)), [alice.address]);
      assert.equal(await contract.getJoinRequestStatus(2, bob.address), REQUEST.NONE);
      assert.equal((await contract.getMemberDetails(2, creator.address)).exists, false);
    });

    it("rejects ETH on creation and direct transfers", async function () {
      await assert.rejects(contract.createGroup("Circle", 3, AMOUNT, DURATION, GRACE, { value: 1n }));
      await assert.rejects(creator.sendTransaction({ to: await contract.getAddress(), value: 1n }));
      assert.equal(await contract.groupCount(), 0n);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 0n);
    });
  });

  describe("join requests", function () {
    beforeEach(async function () { await create(); });

    it("records a non-member's pending request without granting membership", async function () {
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.NONE);
      const receipt = await request(alice);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.PENDING);
      assert.equal((await contract.getMemberDetails(1, alice.address)).exists, false);
      assert.equal((await contract.getGroupDetails(1)).memberCount, 1n);
      const requested = event(receipt, "JoinRequested");
      assert.equal(requested.groupId, 1n);
      assert.equal(requested.applicant, alice.address);
    });

    it("rejects requests from the creator", async function () {
      await reverts(contract.requestJoin(1), "Already a member");
    });

    it("rejects duplicate pending requests", async function () {
      await request(alice);
      await reverts(contract.connect(alice).requestJoin(1), "Request already exists");
    });

    it("allows repeated rejected-to-pending transitions without duplicate list entries", async function () {
      await request(alice);
      await request(bob);
      for (let i = 0; i < 2; i++) {
        await contract.rejectJoinRequest(1, alice.address);
        assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.REJECTED);
        event(await request(alice), "JoinRequested");
        assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.PENDING);
      }
      const [addresses, statuses] = await contract.getJoinRequests(1);
      assert.deepEqual(Array.from(addresses), [alice.address, bob.address]);
      assert.deepEqual(Array.from(statuses), [REQUEST.PENDING, REQUEST.PENDING]);
    });

    it("rejects an approved member's new request while still open", async function () {
      await request(alice);
      await approve(alice);
      await reverts(contract.connect(alice).requestJoin(1), "Already a member");
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.APPROVED);
    });

    it("returns current mixed request statuses in original applicant order", async function () {
      await request(alice);
      await request(bob);
      await request(carol);
      await approve(bob);
      await contract.rejectJoinRequest(1, alice.address);
      const [addresses, statuses] = await contract.getJoinRequests(1);
      assert.deepEqual(Array.from(addresses), [alice.address, bob.address, carol.address]);
      assert.deepEqual(Array.from(statuses), [REQUEST.REJECTED, REQUEST.APPROVED, REQUEST.PENDING]);
    });
  });

  describe("approval and rejection", function () {
    beforeEach(async function () { await create(); await request(alice); });

    it("lets the creator approve a pending applicant and emits both membership events", async function () {
      const receipt = await approve(alice);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.APPROVED);
      const member = await contract.getMemberDetails(1, alice.address);
      assert.equal(member.exists, true);
      assert.equal(member.payoutRound, 2n);
      assert.equal(member.status, MEMBER.REGISTERED);
      zeroFinances(member);
      assert.deepEqual(Array.from(await contract.getMembers(1)), [creator.address, alice.address]);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.OPEN);
      assert.equal((await contract.getGroupDetails(1)).currentRound, 0n);
      const approved = event(receipt, "JoinApproved");
      assert.equal(approved.groupId, 1n);
      assert.equal(approved.applicant, alice.address);
      const joined = event(receipt, "MemberJoined");
      assert.equal(joined.groupId, 1n);
      assert.equal(joined.member, alice.address);
      assert.equal(joined.payoutRound, 2n);
    });

    for (const method of ["approveJoinRequest", "rejectJoinRequest"]) {
      it(`rejects non-creator ${method}`, async function () {
        await reverts(contract.connect(bob)[method](1, alice.address), "Creator only");
        assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.PENDING);
      });
      it(`rejects zero address in ${method}`, async function () {
        await reverts(contract[method](1, ethers.ZeroAddress), "Applicant is zero address");
      });
      it(`rejects absent requests in ${method}`, async function () {
        await reverts(contract[method](1, bob.address), "Request is not pending");
      });
      for (const state of ["approved", "rejected"]) {
        it(`rejects ${state} requests in ${method}`, async function () {
          if (state === "approved") await approve(alice);
          else await contract.rejectJoinRequest(1, alice.address);
          await reverts(contract[method](1, alice.address), "Request is not pending");
        });
      }
    }

    it("lets the creator reject a request without adding a member", async function () {
      const receipt = await (await contract.rejectJoinRequest(1, alice.address)).wait();
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.REJECTED);
      assert.equal((await contract.getMemberDetails(1, alice.address)).exists, false);
      assert.equal((await contract.getGroupDetails(1)).memberCount, 1n);
      const rejected = event(receipt, "JoinRejected");
      assert.equal(rejected.groupId, 1n);
      assert.equal(rejected.applicant, alice.address);
    });
  });

  describe("automatic activation", function () {
    beforeEach(async function () { await create(); });

    it("uses approval order for payout rounds and activates in the final approval transaction", async function () {
      await request(alice);
      await request(bob);
      const firstReceipt = await approve(bob);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.OPEN);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.REGISTERED);
      assert.equal(firstReceipt.logs.some((log) => contract.interface.parseLog(log)?.name === "GroupStarted"), false);
      const finalReceipt = await approve(alice);
      const group = await contract.getGroupDetails(1);
      assert.equal(group.status, GROUP.ACTIVE);
      assert.equal(group.currentRound, 1n);
      assert.equal(group.memberCount, 3n);
      const ordered = [creator.address, bob.address, alice.address];
      assert.deepEqual(Array.from(await contract.getMembers(1)), ordered);
      for (const [index, address] of ordered.entries()) {
        assert.notEqual(address, ethers.ZeroAddress);
        const member = await contract.getMemberDetails(1, address);
        assert.equal(member.exists, true);
        assert.equal(member.payoutRound, BigInt(index + 1));
        assert.equal(member.status, MEMBER.ACTIVE);
        zeroFinances(member);
      }
      assert.equal(event(finalReceipt, "GroupStarted").groupId, 1n);
      event(finalReceipt, "JoinApproved");
      event(finalReceipt, "MemberJoined");
    });

    it("initializes every Round 1 field using the activation block timestamp", async function () {
      const receipt = await activate();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const round = await contract.getRoundDetails(1, 1);
      assert.equal(round.number, 1n);
      assert.equal(round.recipient, creator.address);
      assert.equal(round.status, 1n); // COLLECTING
      assert.equal(round.startTime, BigInt(block.timestamp));
      assert.equal(round.contributionDeadline, round.startTime + DURATION);
      assert.equal(round.graceDeadline, round.startTime + DURATION + GRACE);
      assert.equal(round.expectedAmount, 3n * AMOUNT);
      assert.equal(round.initiallyCollected, 0n);
      assert.equal(round.recoveredArrears, 0n);
      assert.equal(round.contributionCount, 0n);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 0n);
    });

    it("leaves rounds uninitialized before activation and initializes only Round 1", async function () {
      const before = await contract.getRoundDetails(1, 1);
      assert.equal(before.number, 0n);
      assert.equal(before.status, 0n);
      assert.equal(before.startTime, 0n);
      await activate();
      const later = await contract.getRoundDetails(1, 2);
      assert.equal(later.number, 0n);
      assert.equal(later.startTime, 0n);
      assert.equal(later.status, 0n);
    });

    for (const target of [4, 5]) {
      it(`activates a ${target}-member group only at capacity`, async function () {
        await contract.createGroup("Larger", target, AMOUNT, DURATION, GRACE);
        const ordered = [creator, alice, bob, carol, dave].slice(0, target);
        for (const [index, wallet] of ordered.slice(1).entries()) {
          await contract.connect(wallet).requestJoin(2);
          const receipt = await (await contract.approveJoinRequest(2, wallet.address)).wait();
          const full = index === target - 2;
          assert.equal((await contract.getGroupDetails(2)).status, full ? GROUP.ACTIVE : GROUP.OPEN);
          if (full) assert.equal(event(receipt, "GroupStarted").groupId, 2n);
        }
        for (const [index, wallet] of ordered.entries()) {
          const member = await contract.getMemberDetails(2, wallet.address);
          assert.equal(member.status, MEMBER.ACTIVE);
          assert.equal(member.payoutRound, BigInt(index + 1));
        }
        assert.equal((await contract.getRoundDetails(2, 1)).expectedAmount, BigInt(target) * AMOUNT);
        assert.equal((await contract.getGroupDetails(1)).status, GROUP.OPEN);
      });
    }
  });

  describe("post-activation restrictions", function () {
    beforeEach(async function () {
      await create();
      await request(carol); // A surplus pending applicant cannot be approved after activation.
      await activate();
    });

    it("rejects new requests", async function () {
      await reverts(contract.connect(outsider).requestJoin(1), "Group is not open");
    });
    it("rejects further approvals without exceeding capacity", async function () {
      await reverts(contract.approveJoinRequest(1, carol.address), "Group is not open");
      assert.equal((await contract.getGroupDetails(1)).memberCount, 3n);
      assert.equal(await contract.getJoinRequestStatus(1, carol.address), REQUEST.PENDING);
    });
    it("rejects rejections", async function () {
      await reverts(contract.rejectJoinRequest(1, carol.address), "Group is not open");
    });
    it("rejects cancellation", async function () {
      await reverts(contract.cancelGroup(1), "Group is not open");
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.ACTIVE);
    });
  });

  describe("cancellation", function () {
    beforeEach(async function () {
      await create();
      await request(alice);
      await approve(alice);
      await request(bob);
    });

    it("rejects non-creator cancellation", async function () {
      await reverts(contract.connect(alice).cancelGroup(1), "Creator only");
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.OPEN);
    });

    it("cancels an open group and all registered members without starting a round", async function () {
      const receipt = await (await contract.cancelGroup(1)).wait();
      assert.equal(event(receipt, "GroupCancelled").groupId, 1n);
      const group = await contract.getGroupDetails(1);
      assert.equal(group.status, GROUP.CANCELLED);
      assert.equal(group.currentRound, 0n);
      assert.equal(group.memberCount, 2n);
      for (const wallet of [creator, alice]) {
        const member = await contract.getMemberDetails(1, wallet.address);
        assert.equal(member.status, MEMBER.CANCELLED);
        zeroFinances(member);
      }
      assert.equal((await contract.getRoundDetails(1, 1)).status, 0n);
      assert.equal((await contract.getMemberDetails(1, bob.address)).exists, false);
      assert.equal(await contract.getJoinRequestStatus(1, bob.address), REQUEST.PENDING);
    });

    for (const method of ["requestJoin", "approveJoinRequest", "rejectJoinRequest", "cancelGroup"]) {
      it(`rejects ${method} after cancellation`, async function () {
        await contract.cancelGroup(1);
        const action = method === "requestJoin" ? contract.connect(carol).requestJoin(1)
          : method === "cancelGroup" ? contract.cancelGroup(1) : contract[method](1, bob.address);
        await reverts(action, "Group is not open");
      });
    }

    it("can cancel with only the creator registered", async function () {
      await contract.createGroup("Empty circle", 3, 1, 1, 1);
      await contract.cancelGroup(2);
      assert.equal((await contract.getMemberDetails(2, creator.address)).status, MEMBER.CANCELLED);
    });
  });

  describe("existence checks and ABI scope", function () {
    const calls = [
      ["requestJoin", []], ["approveJoinRequest", [ethers.ZeroAddress]],
      ["rejectJoinRequest", [ethers.ZeroAddress]], ["cancelGroup", []],
      ["getGroupDetails", []], ["getMembers", []],
      ["getMemberDetails", [ethers.ZeroAddress]], ["getJoinRequests", []],
      ["getJoinRequestStatus", [ethers.ZeroAddress]], ["getRoundDetails", [1]],
    ];
    for (const [method, args] of calls) {
      it(`rejects nonexistent group IDs in ${method}`, async function () {
        await create();
        for (const id of [0, 2]) {
          await reverts(contract[method](id, ...args), "Group does not exist");
        }
      });
    }

    it("exposes exactly the Iteration 1 functions and events, with no payable entry points", async function () {
      const { abi } = await artifacts.readArtifact("ChainROSCA");
      const functions = abi.filter((item) => item.type === "function");
      assert.deepEqual(functions.map((item) => item.name).sort(), [
        "groupCount", "createGroup", "requestJoin", "approveJoinRequest", "rejectJoinRequest", "cancelGroup",
        "getGroupDetails", "getMembers", "getMemberDetails", "getJoinRequests", "getJoinRequestStatus", "getRoundDetails",
      ].sort());
      for (const name of ["startGroup", "contribute", "settleRound", "repayArrears", "withdrawPayout"]) {
        assert.equal(functions.some((item) => item.name === name), false, `${name} must be absent`);
      }
      assert.equal(abi.some((item) => item.stateMutability === "payable" || item.type === "receive" || item.type === "fallback"), false);
      assert.deepEqual(abi.filter((item) => item.type === "event").map((item) => item.name).sort(), [
        "GroupCreated", "JoinRequested", "JoinApproved", "JoinRejected", "MemberJoined", "GroupStarted", "GroupCancelled",
      ].sort());
    });
  });
});
