const assert = require("node:assert/strict");
const { ethers, artifacts, network } = require("hardhat");

const GROUP = { OPEN: 0n, ACTIVE: 1n, COMPLETED: 2n, CANCELLED: 3n };
const MEMBER = { REGISTERED: 0n, ACTIVE: 1n, OUTSTANDING: 2n, COMPLETED: 3n, CANCELLED: 4n };
const REQUEST = { NONE: 0n, PENDING: 1n, APPROVED: 2n, REJECTED: 3n };
const AMOUNT = ethers.parseEther("0.01");
const DURATION = 3600n;
const GRACE = 600n;

describe("ChainROSCA — Iterations 1 to 4", function () {
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
      const [addresses, statuses] = await contract.getJoinRequestsPage(1, 0, 20);
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
      const [addresses, statuses] = await contract.getJoinRequestsPage(1, 0, 20);
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

  describe("Iteration 2 contributions and round timing", function () {
    beforeEach(async function () { await create(); });

    async function pay(wallet = alice, value = AMOUNT, groupId = 1) {
      return (await contract.connect(wallet).contribute(groupId, { value })).wait();
    }

    async function at(timestamp) {
      await network.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
    }

    function untouched(record) {
      assert.deepEqual(Array.from(record), [false, false, false, false, 0n, 0n, 0n]);
    }

    async function assertPayment(receipt, wallet, late, groupId = 1, amount = AMOUNT) {
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const record = await contract.getContributionRecord(groupId, 1, wallet.address);
      assert.deepEqual(Array.from(record), [true, late, false, false, BigInt(block.timestamp), 0n, 0n]);
      const name = late ? "LateContributionMade" : "ContributionMade";
      // Exactly one log also excludes the opposite timing event and any later-iteration event.
      assert.equal(receipt.logs.length, 1);
      const args = event(receipt, name);
      assert.equal(args.groupId, BigInt(groupId));
      assert.equal(args.roundNumber, 1n);
      assert.equal(args.member, wallet.address);
      assert.equal(args.amount, amount);
      const definition = contract.interface.getEvent(name);
      assert.deepEqual(definition.inputs.map((input) => input.indexed), [true, true, true, false]);
    }

    async function snapshot(wallet = alice, groupId = 1) {
      return {
        record: Array.from(await contract.getContributionRecord(groupId, 1, wallet.address)),
        round: Array.from(await contract.getRoundDetails(groupId, 1)),
        member: Array.from(await contract.getMemberDetails(groupId, wallet.address)),
        group: Array.from(await contract.getGroupDetails(groupId)),
        balance: await ethers.provider.getBalance(await contract.getAddress()),
      };
    }

    async function unchangedFailure(action, message, wallet = alice) {
      const before = await snapshot(wallet);
      await reverts(action(), message);
      assert.deepEqual(await snapshot(wallet), before);
    }

    it("returns a zero/default record for untouched members and future rounds", async function () {
      untouched(await contract.getContributionRecord(1, 1, creator.address));
      await activate();
      for (const wallet of [creator, alice, outsider]) {
        untouched(await contract.getContributionRecord(1, 1, wallet.address));
        untouched(await contract.getContributionRecord(1, 2, wallet.address));
      }
    });

    it("accepts an active member's exact payment and records every field and accounting value", async function () {
      await activate();
      const recipientBefore = await ethers.provider.getBalance(creator.address);
      const receipt = await pay();
      await assertPayment(receipt, alice, false);
      const round = await contract.getRoundDetails(1, 1);
      assert.equal(round.initiallyCollected, AMOUNT);
      assert.equal(round.contributionCount, 1n);
      assert.equal(round.recoveredArrears, 0n);
      assert.equal(round.expectedAmount, 3n * AMOUNT);
      const member = await contract.getMemberDetails(1, alice.address);
      assert.equal(member.totalContributed, AMOUNT);
      assert.equal(member.status, MEMBER.ACTIVE);
      assert.equal(member.defaultCount, 0n);
      assert.equal(member.totalArrearsRepaid, 0n);
      assert.equal(member.outstandingArrears, 0n);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), AMOUNT);
      assert.equal(await ethers.provider.getBalance(creator.address), recipientBefore);
    });

    it("rejects a non-member even when they have a pending join request", async function () {
      await request(carol);
      await activate();
      for (const wallet of [outsider, carol]) {
        await unchangedFailure(() => contract.connect(wallet).contribute(1, { value: AMOUNT }), "Not a member", wallet);
      }
    });

    it("rejects a registered creator's payment while OPEN with no initialized current round", async function () {
      assert.equal((await contract.getGroupDetails(1)).currentRound, 0n);
      assert.equal((await contract.getRoundDetails(1, 1)).status, 0n);
      await unchangedFailure(() => contract.contribute(1, { value: AMOUNT }), "Group is not active", creator);
    });

    it("rejects a cancelled member's payment", async function () {
      await contract.cancelGroup(1);
      await unchangedFailure(() => contract.contribute(1, { value: AMOUNT }), "Group is not active", creator);
    });

    it("rejects contributions and record reads for nonexistent groups", async function () {
      for (const id of [0, 2]) {
        await reverts(contract.connect(alice).contribute(id, { value: AMOUNT }), "Group does not exist");
        await reverts(contract.getContributionRecord(id, 1, alice.address), "Group does not exist");
      }
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 0n);
    });

    for (const [label, value] of [["underpayment", AMOUNT - 1n], ["overpayment", AMOUNT + 1n], ["zero ETH", 0n]]) {
      it(`rejects ${label} without changing records, accounting, or balance`, async function () {
        await activate();
        await unchangedFailure(() => contract.connect(alice).contribute(1, { value }), "Incorrect contribution amount");
        await assertPayment(await pay(), alice, false);
      });
    }

    for (const recipient of [false, true]) {
      it(`rejects duplicate contributions from ${recipient ? "the scheduled recipient" : "another member"} without state changes`, async function () {
        await activate();
        const wallet = recipient ? creator : alice;
        await assertPayment(await pay(wallet), wallet, false);
        await unchangedFailure(() => contract.connect(wallet).contribute(1, { value: AMOUNT }), "Already contributed", wallet);
      });
    }

    it("requires the recipient to follow the exact payment rule and accounts for their payment normally", async function () {
      await activate();
      assert.equal((await contract.getRoundDetails(1, 1)).recipient, creator.address);
      untouched(await contract.getContributionRecord(1, 1, creator.address));
      await unchangedFailure(() => contract.contribute(1, { value: 0n }), "Incorrect contribution amount", creator);
      await assertPayment(await pay(creator), creator, false);
      assert.equal((await contract.getMemberDetails(1, creator.address)).totalContributed, AMOUNT);
      assert.equal((await contract.getRoundDetails(1, 1)).contributionCount, 1n);
      assert.equal((await contract.getRoundDetails(1, 1)).initiallyCollected, AMOUNT);
    });

    for (const target of [3, 5]) {
      it(`accumulates all ${target} members' payments without settlement, defaults, payouts, or progression`, async function () {
        // Use a separate group to exercise both membership capacities with the same contribution flow.
        await contract.createGroup("Full contributions", target, AMOUNT, DURATION, GRACE);
        const wallets = [creator, alice, bob, carol, dave].slice(0, target);
        for (const wallet of wallets.slice(1)) {
          await contract.connect(wallet).requestJoin(2);
          await contract.approveJoinRequest(2, wallet.address);
        }
        const before = await contract.getRoundDetails(2, 1);
        let recipientBalance;
        for (const [index, wallet] of wallets.entries()) {
          if (index === target - 1) await at(before.contributionDeadline + 1n);
          await assertPayment(await pay(wallet, AMOUNT, 2), wallet, index === target - 1, 2);
          const round = await contract.getRoundDetails(2, 1);
          assert.equal(round.contributionCount, BigInt(index + 1));
          assert.equal(round.initiallyCollected, BigInt(index + 1) * AMOUNT);
          assert.equal(await ethers.provider.getBalance(await contract.getAddress()), BigInt(index + 1) * AMOUNT);
          if (index === 0) recipientBalance = await ethers.provider.getBalance(creator.address);
          else assert.equal(await ethers.provider.getBalance(creator.address), recipientBalance);
        }
        const round = await contract.getRoundDetails(2, 1);
        assert.equal(round.status, 1n); // Still COLLECTING, even with all payments.
        assert.equal(round.recoveredArrears, 0n);
        for (const field of ["number", "recipient", "startTime", "contributionDeadline", "graceDeadline", "expectedAmount"]) {
          assert.equal(round[field], before[field]);
        }
        const group = await contract.getGroupDetails(2);
        assert.equal(group.currentRound, 1n);
        assert.equal(group.status, GROUP.ACTIVE);
        assert.equal((await contract.getRoundDetails(2, 2)).number, 0n);
        assert.equal((await contract.getRoundDetails(2, 2)).status, 0n);
        for (const wallet of wallets) {
          const member = await contract.getMemberDetails(2, wallet.address);
          assert.equal(member.status, MEMBER.ACTIVE);
          assert.equal(member.totalContributed, AMOUNT);
          assert.equal(member.totalArrearsRepaid, 0n);
          assert.equal(member.outstandingArrears, 0n);
          assert.equal(member.defaultCount, 0n);
          untouched(await contract.getContributionRecord(2, 2, wallet.address));
        }
      });
    }

    const boundaries = [
      ["one second before normal deadline", "contributionDeadline", -1n, false],
      ["exactly at normal deadline", "contributionDeadline", 0n, false],
      ["one second after normal deadline", "contributionDeadline", 1n, true],
      ["exactly at grace deadline", "graceDeadline", 0n, true],
    ];
    for (const [label, field, offset, late] of boundaries) {
      it(`accepts payment ${label} as ${late ? "late" : "on-time"} with exactly the correct event`, async function () {
        await activate();
        const before = await contract.getRoundDetails(1, 1);
        const timestamp = before[field] + offset;
        await at(timestamp);
        await assertPayment(await pay(), alice, late);
        assert.equal((await contract.getContributionRecord(1, 1, alice.address)).contributionTimestamp, timestamp);
        const after = await contract.getRoundDetails(1, 1);
        assert.equal(after.initiallyCollected, AMOUNT);
        assert.equal(after.contributionCount, 1n);
        assert.equal(after.recoveredArrears, 0n);
        assert.equal(after.status, 1n);
        assert.equal((await contract.getMemberDetails(1, alice.address)).totalContributed, AMOUNT);
        assert.equal(await ethers.provider.getBalance(await contract.getAddress()), AMOUNT);
      });
    }

    it("rejects payment one second after grace without altering records, accounting, or recording defaults", async function () {
      await activate();
      await pay(bob); // Preserve an existing valid payment while another member misses the deadline.
      const round = await contract.getRoundDetails(1, 1);
      await at(round.graceDeadline + 1n);
      await unchangedFailure(
        () => contract.connect(alice).contribute(1, { value: AMOUNT, gasLimit: 500000 }),
        "Grace deadline has passed"
      );
      untouched(await contract.getContributionRecord(1, 1, alice.address));
      const member = await contract.getMemberDetails(1, alice.address);
      assert.equal(member.status, MEMBER.ACTIVE);
      zeroFinances(member);
      assert.equal((await contract.getRoundDetails(1, 1)).status, 1n);
      assert.equal((await contract.getGroupDetails(1)).currentRound, 1n);
      assert.equal((await contract.getRoundDetails(1, 2)).number, 0n);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), AMOUNT);
    });

    it("rejects direct ETH transfers and unknown calls while retaining valid contributions", async function () {
      await activate();
      await pay();
      const before = await snapshot();
      await assert.rejects(bob.sendTransaction({ to: await contract.getAddress(), value: AMOUNT }));
      await assert.rejects(bob.sendTransaction({ to: await contract.getAddress(), value: AMOUNT, data: "0x12345678" }));
      assert.deepEqual(await snapshot(), before);
    });

    it("isolates contribution records and accounting between groups", async function () {
      await activate();
      await contract.createGroup("Second circle", 3, 2n * AMOUNT, DURATION, GRACE);
      for (const wallet of [alice, bob]) {
        await contract.connect(wallet).requestJoin(2);
        await contract.approveJoinRequest(2, wallet.address);
      }
      await pay();
      untouched(await contract.getContributionRecord(2, 1, alice.address));
      assert.equal((await contract.getMemberDetails(2, alice.address)).totalContributed, 0n);
      assert.equal((await contract.getRoundDetails(2, 1)).initiallyCollected, 0n);
      const first = await snapshot();
      await assertPayment(await pay(alice, 2n * AMOUNT, 2), alice, false, 2, 2n * AMOUNT);
      assert.equal((await contract.getMemberDetails(2, alice.address)).totalContributed, 2n * AMOUNT);
      assert.equal((await contract.getRoundDetails(2, 1)).initiallyCollected, 2n * AMOUNT);
      const after = await snapshot();
      assert.deepEqual({ ...after, balance: first.balance }, first);
      assert.equal(after.balance, 3n * AMOUNT);
    });
  });

  describe("Iteration 3 settlement, defaults, and rotation", function () {
    let wallets;
    beforeEach(async function () {
      await create();
      await activate();
      wallets = [creator, alice, bob];
    });

    async function pay(wallet, groupId = 1) {
      return (await contract.connect(wallet).contribute(groupId, { value: AMOUNT })).wait();
    }

    async function fundAll() {
      for (const wallet of wallets) await pay(wallet);
    }

    async function at(timestamp) {
      await network.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
    }

    async function expire(groupId = 1) {
      const group = await contract.getGroupDetails(groupId);
      const round = await contract.getRoundDetails(groupId, group.currentRound);
      await at(round.graceDeadline + 1n);
    }

    async function snapshot() {
      const group = await contract.getGroupDetails(1);
      const rounds = [], records = [], members = [], balances = [];
      for (let number = 1; number <= 4; number++) {
        rounds.push(Array.from(await contract.getRoundDetails(1, number)));
        for (const wallet of wallets) records.push(Array.from(await contract.getContributionRecord(1, number, wallet.address)));
      }
      for (const wallet of wallets) {
        members.push(Array.from(await contract.getMemberDetails(1, wallet.address)));
        balances.push(await contract.getWithdrawableBalance(wallet.address));
      }
      return { group: Array.from(group), rounds, records, members, balances,
        custody: await ethers.provider.getBalance(await contract.getAddress()) };
    }

    async function failSettlement(message, caller = outsider) {
      const before = await snapshot();
      await reverts(contract.connect(caller).settleRound(1, { gasLimit: 1000000 }), message);
      assert.deepEqual(await snapshot(), before);
    }

    // Verify the complete effect of one settlement, including event order and custody.
    async function settleAndCheck(missing = [], caller = outsider, groupId = 1, ordered = wallets) {
      const group = await contract.getGroupDetails(groupId);
      const number = group.currentRound;
      const before = await contract.getRoundDetails(groupId, number);
      const balance = await ethers.provider.getBalance(await contract.getAddress());
      const records = [], members = [], allocations = [], nativeBalances = [];
      for (const wallet of ordered) {
        records.push(await contract.getContributionRecord(groupId, number, wallet.address));
        members.push(await contract.getMemberDetails(groupId, wallet.address));
        allocations.push(await contract.getWithdrawableBalance(wallet.address));
        nativeBalances.push(await ethers.provider.getBalance(wallet.address));
      }
      const receipt = await (await contract.connect(caller).settleRound(groupId)).wait();
      const timestamp = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      const round = await contract.getRoundDetails(groupId, number);
      assert.equal(round.status, 2n); // SETTLED
      assert.equal(round.outstandingShortfall, BigInt(missing.length) * AMOUNT);
      assert.equal(round.outstandingShortfall, round.expectedAmount - round.initiallyCollected);
      assert.equal(round.recoveredArrears, 0n);
      for (const field of ["number", "recipient", "startTime", "contributionDeadline", "graceDeadline", "expectedAmount", "initiallyCollected", "contributionCount"]) {
        assert.equal(round[field], before[field], field);
      }
      const logs = receipt.logs.map((log) => contract.interface.parseLog(log));
      const final = number === group.targetMembers;
      const completed = final ? ordered.filter((wallet, index) =>
        !missing.includes(wallet.address) && members[index].outstandingArrears === 0n) : [];
      const groupComplete = final && completed.length === ordered.length;
      assert.deepEqual(logs.map((log) => log.name), [
        ...missing.map(() => "MemberDefaulted"), "RoundSettled", "PayoutAllocated",
        ...completed.map(() => "MemberCompleted"), ...(groupComplete ? ["GroupCompleted"] : []),
      ]);
      const missingInOrder = ordered.filter((wallet) => missing.includes(wallet.address));
      for (const [index, wallet] of missingInOrder.entries()) {
        const args = logs[index].args;
        assert.equal(args.groupId, BigInt(groupId));
        assert.equal(args.roundNumber, number);
        assert.equal(args.member, wallet.address);
        assert.equal(args.amount, AMOUNT);
      }
      const settled = event(receipt, "RoundSettled");
      assert.equal(settled.groupId, BigInt(groupId));
      assert.equal(settled.roundNumber, number);
      assert.equal(settled.recipient, round.recipient);
      assert.equal(settled.initiallyCollected, round.initiallyCollected);
      assert.equal(settled.outstandingShortfall, round.outstandingShortfall);
      const payout = event(receipt, "PayoutAllocated");
      assert.equal(payout.groupId, BigInt(groupId));
      assert.equal(payout.roundNumber, number);
      assert.equal(payout.recipient, round.recipient);
      assert.equal(payout.amount, round.initiallyCollected);
      for (const [index, wallet] of ordered.entries()) {
        const record = await contract.getContributionRecord(groupId, number, wallet.address);
        const member = await contract.getMemberDetails(groupId, wallet.address);
        if (missing.includes(wallet.address)) {
          assert.deepEqual(Array.from(record), [false, false, true, false, 0n, timestamp, 0n]);
          assert.equal(member.defaultCount, members[index].defaultCount + 1n);
          assert.equal(member.outstandingArrears, members[index].outstandingArrears + AMOUNT);
          assert.equal(member.status, MEMBER.OUTSTANDING);
        } else {
          assert.deepEqual(Array.from(record), Array.from(records[index]));
          assert.equal(member.defaultCount, members[index].defaultCount);
          assert.equal(member.outstandingArrears, members[index].outstandingArrears);
          assert.equal(member.status, completed.includes(wallet) ? MEMBER.COMPLETED : members[index].status);
        }
        assert.equal(member.totalContributed, members[index].totalContributed);
        assert.equal(member.totalArrearsRepaid, 0n);
        assert.equal(member.exists, true);
        assert.equal(member.payoutRound, members[index].payoutRound);
        assert.equal(await contract.getWithdrawableBalance(wallet.address), allocations[index]
          + (wallet.address === round.recipient ? round.initiallyCollected : 0n));
        if (wallet.address !== caller.address) {
          assert.equal(await ethers.provider.getBalance(wallet.address), nativeBalances[index]);
        }
      }
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), balance);
      const afterGroup = await contract.getGroupDetails(groupId);
      assert.equal(afterGroup.status, groupComplete ? GROUP.COMPLETED : GROUP.ACTIVE);
      if (number < group.targetMembers) {
        assert.equal(afterGroup.currentRound, number + 1n);
        const next = await contract.getRoundDetails(groupId, number + 1n);
        assert.equal(next.number, number + 1n);
        assert.equal(next.recipient, ordered[Number(number)].address);
        assert.equal(next.startTime, timestamp);
        assert.equal(next.contributionDeadline, timestamp + DURATION);
        assert.equal(next.graceDeadline, timestamp + DURATION + GRACE);
        assert.equal(next.expectedAmount, BigInt(ordered.length) * AMOUNT);
        assert.equal(next.initiallyCollected, 0n);
        assert.equal(next.recoveredArrears, 0n);
        assert.equal(next.outstandingShortfall, 0n);
        assert.equal(next.contributionCount, 0n);
        assert.equal(next.status, 1n);
      } else {
        assert.equal(afterGroup.currentRound, number);
        assert.equal((await contract.getRoundDetails(groupId, number + 1n)).number, 0n);
        assert.equal((await contract.getRoundDetails(groupId, number + 1n)).status, 0n);
      }
      return round;
    }

    it("starts Round 1 with zero outstanding shortfall and zero global allocations", async function () {
      assert.equal((await contract.getRoundDetails(1, 1)).outstandingShortfall, 0n);
      for (const wallet of [...wallets, outsider]) assert.equal(await contract.getWithdrawableBalance(wallet.address), 0n);
      assert.equal(await contract.getWithdrawableBalance(ethers.ZeroAddress), 0n);
    });

    for (const role of ["creator", "member", "outsider"]) {
      it(`allows the ${role} to settle a fully funded round`, async function () {
        await fundAll();
        await settleAndCheck([], role === "creator" ? creator : role === "member" ? alice : outsider);
      });
    }

    it("rejects nonexistent groups", async function () {
      for (const id of [0, 2]) await reverts(contract.settleRound(id), "Group does not exist");
    });

    for (const cancelled of [false, true]) {
      it(`rejects settlement of an ${cancelled ? "CANCELLED" : "OPEN"} group`, async function () {
        await contract.createGroup("Not active", 3, AMOUNT, DURATION, GRACE);
        if (cancelled) await contract.cancelGroup(2);
        await reverts(contract.connect(outsider).settleRound(2), "Group is not active");
        assert.equal((await contract.getGroupDetails(2)).currentRound, 0n);
      });
    }

    for (const timing of ["before deadline", "at deadline", "during grace", "after grace"]) {
      it(`allows fully funded settlement ${timing} with no defaults and full allocation`, async function () {
        await fundAll();
        const round = await contract.getRoundDetails(1, 1);
        if (timing === "at deadline") await at(round.contributionDeadline);
        if (timing === "during grace") await at(round.contributionDeadline + 1n);
        if (timing === "after grace") await at(round.graceDeadline + 1n);
        const settled = await settleAndCheck();
        assert.equal(settled.initiallyCollected, 3n * AMOUNT);
        assert.equal(await contract.getWithdrawableBalance(creator.address), 3n * AMOUNT);
      });
    }

    for (const boundary of ["before normal deadline", "during grace", "exactly at grace deadline"]) {
      it(`rejects underfunded settlement ${boundary} without any accounting changes`, async function () {
        await pay(alice);
        const round = await contract.getRoundDetails(1, 1);
        if (boundary === "during grace") await at(round.contributionDeadline + 1n);
        if (boundary === "exactly at grace deadline") await at(round.graceDeadline);
        await failSettlement("Settlement is not ready");
      });
    }

    it("records one missing contributor exactly one second after grace and initializes Round 2 atomically", async function () {
      await pay(creator);
      await pay(alice);
      await expire();
      const round = await settleAndCheck([bob.address]);
      const record = await contract.getContributionRecord(1, 1, bob.address);
      assert.equal(record.defaultTimestamp, round.graceDeadline + 1n);
      assert.equal(round.outstandingShortfall, AMOUNT);
    });

    it("records multiple defaults while preserving a late contributor's record", async function () {
      const round = await contract.getRoundDetails(1, 1);
      await at(round.contributionDeadline + 1n);
      await pay(creator);
      await expire();
      const settled = await settleAndCheck([alice.address, bob.address]);
      assert.equal(settled.outstandingShortfall, 2n * AMOUNT);
      assert.equal((await contract.getContributionRecord(1, 1, creator.address)).late, true);
    });

    it("settles a zero-contribution round, defaults everyone, emits zero allocation, and progresses", async function () {
      await expire();
      const round = await settleAndCheck(wallets.map((wallet) => wallet.address));
      assert.equal(round.initiallyCollected, 0n);
      assert.equal(round.outstandingShortfall, round.expectedAmount);
    });

    it("allocates other members' collected ETH even when the recipient defaults", async function () {
      await pay(alice);
      await pay(bob);
      await expire();
      const round = await settleAndCheck([creator.address]);
      assert.equal(round.initiallyCollected, 2n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(creator.address), 2n * AMOUNT);
      assert.notEqual(round.initiallyCollected, round.expectedAmount);
    });

    it("does not reprocess the previous round when a second immediate settlement is attempted", async function () {
      await pay(creator);
      await expire();
      await settleAndCheck([alice.address, bob.address]);
      await failSettlement("Settlement is not ready");
    });

    it("lets an OUTSTANDING member contribute to and settle a fully funded later round without erasing older debt", async function () {
      await pay(creator);
      await pay(alice);
      await expire();
      const historicalRound = await settleAndCheck([bob.address]);
      const historicalRecord = await contract.getContributionRecord(1, 1, bob.address);
      await fundAll();
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      await settleAndCheck();
      assert.deepEqual(Array.from(await contract.getRoundDetails(1, 1)), Array.from(historicalRound));
      assert.deepEqual(Array.from(await contract.getContributionRecord(1, 1, bob.address)), Array.from(historicalRecord));
      const member = await contract.getMemberDetails(1, bob.address);
      assert.equal(member.defaultCount, 1n);
      assert.equal(member.outstandingArrears, AMOUNT);
      assert.equal(member.status, MEMBER.OUTSTANDING);
      assert.equal(member.totalContributed, AMOUNT);
    });

    it("accumulates independent defaults for the same member across rounds", async function () {
      await pay(creator);
      await pay(bob);
      await expire();
      const firstRound = await settleAndCheck([alice.address]);
      const firstRecord = await contract.getContributionRecord(1, 1, alice.address);
      await pay(creator);
      await pay(bob);
      await expire();
      await settleAndCheck([alice.address]);
      const member = await contract.getMemberDetails(1, alice.address);
      assert.equal(member.defaultCount, 2n);
      assert.equal(member.outstandingArrears, 2n * AMOUNT);
      assert.equal(member.status, MEMBER.OUTSTANDING);
      assert.deepEqual(Array.from(await contract.getRoundDetails(1, 1)), Array.from(firstRound));
      assert.deepEqual(Array.from(await contract.getContributionRecord(1, 1, alice.address)), Array.from(firstRecord));
      assert.equal((await contract.getContributionRecord(1, 2, alice.address)).defaulted, true);
      assert.equal(await contract.getWithdrawableBalance(alice.address), 2n * AMOUNT);
    });

    it("accumulates global allocations across groups without changing unrelated balances", async function () {
      await fundAll();
      await settleAndCheck();
      await contract.createGroup("Another circle", 3, AMOUNT, DURATION, GRACE);
      for (const wallet of [alice, bob]) {
        await contract.connect(wallet).requestJoin(2);
        await contract.approveJoinRequest(2, wallet.address);
      }
      await pay(alice, 2);
      await expire(2);
      await settleAndCheck([creator.address, bob.address], outsider, 2);
      assert.equal(await contract.getWithdrawableBalance(creator.address), 4n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(alice.address), 0n);
      assert.equal(await contract.getWithdrawableBalance(bob.address), 0n);
      assert.equal((await contract.getRoundDetails(1, 1)).status, 2n);
      assert.equal((await contract.getMemberDetails(1, creator.address)).outstandingArrears, 0n);
    });

    it("rotates through three distinct historical rounds, with a default and later OUTSTANDING participation", async function () {
      const historical = [];
      await fundAll();
      historical.push(await settleAndCheck());
      await pay(creator);
      await pay(alice);
      await expire();
      historical.push(await settleAndCheck([bob.address]));
      await fundAll();
      historical.push(await settleAndCheck());
      for (const [index, round] of historical.entries()) {
        assert.equal(round.recipient, wallets[index].address);
        assert.deepEqual(Array.from(await contract.getRoundDetails(1, index + 1)), Array.from(round));
      }
      assert.equal(await contract.getWithdrawableBalance(creator.address), 3n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(alice.address), 2n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(bob.address), 3n * AMOUNT);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 8n * AMOUNT);
      assert.equal((await contract.getGroupDetails(1)).currentRound, 3n);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.ACTIVE);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      await failSettlement("Round is not collecting");
      await reverts(contract.connect(bob).contribute(1, { value: AMOUNT }), "Round is not collecting");
    });

    for (const funded of [true, false]) {
      it(`leaves the final ${funded ? "fully funded" : "zero-funded"} round settled with ${funded ? "completion" : "unresolved obligations"} and no extra round`, async function () {
        for (let number = 1; number <= 3; number++) {
          if (funded) await fundAll();
          else await expire();
          await settleAndCheck(funded ? [] : wallets.map((wallet) => wallet.address));
        }
        const group = await contract.getGroupDetails(1);
        assert.equal(group.status, funded ? GROUP.COMPLETED : GROUP.ACTIVE);
        assert.equal(group.currentRound, 3n);
        for (const wallet of wallets) {
          const member = await contract.getMemberDetails(1, wallet.address);
          assert.equal(member.status, funded ? MEMBER.COMPLETED : MEMBER.OUTSTANDING);
          assert.equal(member.defaultCount, funded ? 0n : 3n);
          assert.equal(member.outstandingArrears, funded ? 0n : 3n * AMOUNT);
        }
        await failSettlement(funded ? "Group is not active" : "Round is not collecting");
      });
    }

    it("rotates a five-member group through all five recipients with bounded default recording", async function () {
      const ordered = [creator, alice, bob, carol, dave];
      await contract.createGroup("Five-member rotation", 5, AMOUNT, DURATION, GRACE);
      for (const wallet of ordered.slice(1)) {
        await contract.connect(wallet).requestJoin(2);
        await contract.approveJoinRequest(2, wallet.address);
      }
      for (let number = 1; number <= 5; number++) {
        await pay(creator, 2);
        await expire(2);
        const round = await settleAndCheck(ordered.slice(1).map((wallet) => wallet.address), outsider, 2, ordered);
        assert.equal(round.recipient, ordered[number - 1].address);
      }
      assert.equal((await contract.getGroupDetails(2)).currentRound, 5n);
      assert.equal((await contract.getRoundDetails(2, 6)).number, 0n);
      for (const wallet of ordered.slice(1)) {
        const member = await contract.getMemberDetails(2, wallet.address);
        assert.equal(member.defaultCount, 5n);
        assert.equal(member.outstandingArrears, 5n * AMOUNT);
      }
    });

    it("indexes the settlement and default events by group, round, and wallet", async function () {
      for (const name of ["MemberDefaulted", "RoundSettled", "PayoutAllocated"]) {
        assert.deepEqual(contract.interface.getEvent(name).inputs.slice(0, 3).map((input) => input.indexed), [true, true, true]);
      }
    });
  });

  describe("Iteration 4 arrears, withdrawals, and completion", function () {
    let wallets;
    beforeEach(async function () {
      await create();
      await activate();
      wallets = [creator, alice, bob];
    });

    async function pay(wallet, groupId = 1) {
      await (await contract.connect(wallet).contribute(groupId, { value: AMOUNT })).wait();
    }

    async function settle(missing = [], groupId = 1) {
      for (const wallet of wallets) if (!missing.includes(wallet)) await pay(wallet, groupId);
      if (missing.length) {
        const group = await contract.getGroupDetails(groupId);
        const round = await contract.getRoundDetails(groupId, group.currentRound);
        await network.provider.send("evm_setNextBlockTimestamp", [Number(round.graceDeadline + 1n)]);
      }
      const receipt = await (await contract.connect(outsider).settleRound(groupId)).wait();
      await invariant(groupId);
      return receipt;
    }

    function names(receipt) {
      return receipt.logs.map((log) => contract.interface.parseLog(log).name);
    }

    async function invariant(groupId = 1) {
      const group = await contract.getGroupDetails(groupId);
      for (let number = 1; number <= Number(group.targetMembers); number++) {
        const round = await contract.getRoundDetails(groupId, number);
        if (round.status === 2n) {
          assert.equal(round.initiallyCollected + round.recoveredArrears + round.outstandingShortfall, round.expectedAmount);
        }
      }
    }

    async function snapshot() {
      const result = { group: Array.from(await contract.getGroupDetails(1)), rounds: [], records: [], members: [], allocations: [] };
      for (let number = 1; number <= 4; number++) {
        result.rounds.push(Array.from(await contract.getRoundDetails(1, number)));
        for (const wallet of wallets) result.records.push(Array.from(await contract.getContributionRecord(1, number, wallet.address)));
      }
      for (const wallet of wallets) {
        result.members.push(Array.from(await contract.getMemberDetails(1, wallet.address)));
        result.allocations.push(await contract.getWithdrawableBalance(wallet.address));
      }
      result.custody = await ethers.provider.getBalance(await contract.getAddress());
      return result;
    }

    async function failRepayment(wallet, roundNumber, value, message, groupId = 1) {
      const before = await snapshot();
      await reverts(contract.connect(wallet).repayArrears(groupId, roundNumber, { value }), message);
      assert.deepEqual(await snapshot(), before);
    }

    async function repayAndCheck(wallet, number, groupId = 1) {
      const before = await contract.getContributionRecord(groupId, number, wallet.address);
      const memberBefore = await contract.getMemberDetails(groupId, wallet.address);
      const roundBefore = await contract.getRoundDetails(groupId, number);
      const custody = await ethers.provider.getBalance(await contract.getAddress());
      const allocations = await Promise.all(wallets.map((w) => contract.getWithdrawableBalance(w.address)));
      const recipientNative = await ethers.provider.getBalance(roundBefore.recipient);
      const receipt = await (await contract.connect(wallet).repayArrears(groupId, number, { value: AMOUNT })).wait();
      const timestamp = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      const record = await contract.getContributionRecord(groupId, number, wallet.address);
      assert.deepEqual(Array.from(record), [before.contributed, before.late, true, true,
        before.contributionTimestamp, before.defaultTimestamp, timestamp]);
      const member = await contract.getMemberDetails(groupId, wallet.address);
      assert.equal(member.totalArrearsRepaid, memberBefore.totalArrearsRepaid + AMOUNT);
      assert.equal(member.outstandingArrears, memberBefore.outstandingArrears - AMOUNT);
      assert.equal(member.defaultCount, memberBefore.defaultCount);
      assert.equal(member.totalContributed, memberBefore.totalContributed);
      const group = await contract.getGroupDetails(groupId);
      const finished = group.currentRound === group.targetMembers
        && (await contract.getRoundDetails(groupId, group.targetMembers)).status === 2n;
      assert.equal(member.status, member.outstandingArrears > 0n ? MEMBER.OUTSTANDING : finished ? MEMBER.COMPLETED : MEMBER.ACTIVE);
      const round = await contract.getRoundDetails(groupId, number);
      for (const field of ["number", "recipient", "startTime", "contributionDeadline", "graceDeadline", "expectedAmount", "initiallyCollected", "contributionCount", "status"]) {
        assert.equal(round[field], roundBefore[field]);
      }
      assert.equal(round.recoveredArrears, roundBefore.recoveredArrears + AMOUNT);
      assert.equal(round.outstandingShortfall, roundBefore.outstandingShortfall - AMOUNT);
      for (const [index, w] of wallets.entries()) {
        assert.equal(await contract.getWithdrawableBalance(w.address), allocations[index]
          + (w.address === round.recipient ? AMOUNT : 0n));
      }
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), custody + AMOUNT);
      if (round.recipient !== wallet.address) {
        assert.equal(await ethers.provider.getBalance(round.recipient), recipientNative);
      }
      const args = event(receipt, "ArrearsRepaid");
      assert.equal(args.groupId, BigInt(groupId));
      assert.equal(args.roundNumber, BigInt(number));
      assert.equal(args.member, wallet.address);
      assert.equal(args.recipient, round.recipient);
      assert.equal(args.amount, AMOUNT);
      assert.equal(names(receipt).includes("PayoutAllocated"), false);
      await invariant(groupId);
      return receipt;
    }

    async function withdrawAndCheck(wallet) {
      const amount = await contract.getWithdrawableBalance(wallet.address);
      const native = await ethers.provider.getBalance(wallet.address);
      const custody = await ethers.provider.getBalance(await contract.getAddress());
      const receipt = await (await contract.connect(wallet).withdrawPayout()).wait();
      assert.equal(await contract.getWithdrawableBalance(wallet.address), 0n);
      assert.equal(await ethers.provider.getBalance(wallet.address), native + amount - receipt.gasUsed * receipt.gasPrice);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), custody - amount);
      assert.deepEqual(names(receipt), ["PayoutWithdrawn"]);
      const args = event(receipt, "PayoutWithdrawn");
      assert.equal(args.recipient, wallet.address);
      assert.equal(args.amount, amount);
      return amount;
    }

    function completions(receipt, expectedMembers, groupComplete) {
      const logs = receipt.logs.map((log) => contract.interface.parseLog(log));
      const members = logs.filter((log) => log.name === "MemberCompleted");
      assert.deepEqual(members.map((log) => log.args.member), expectedMembers.map((w) => w.address));
      for (const log of members) assert.equal(log.args.groupId, 1n);
      const groups = logs.filter((log) => log.name === "GroupCompleted");
      assert.equal(groups.length, groupComplete ? 1 : 0);
      if (groupComplete) assert.equal(groups[0].args.groupId, 1n);
    }

    it("repays an exact historical default, preserves evidence, and restores ACTIVE before rotation ends", async function () {
      await settle([bob]);
      const receipt = await repayAndCheck(bob, 1);
      assert.deepEqual(names(receipt), ["ArrearsRepaid"]);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.ACTIVE);
      await pay(bob);
      assert.equal((await contract.getContributionRecord(1, 2, bob.address)).contributed, true);
      await invariant();
    });

    it("rejects repayment of nonexistent groups", async function () {
      for (const id of [0, 2]) await failRepayment(bob, 1, AMOUNT, "Group does not exist", id);
    });

    it("rejects a non-member and a member without that historical default", async function () {
      await settle([bob]);
      await failRepayment(outsider, 1, AMOUNT, "Not a member");
      await failRepayment(alice, 1, AMOUNT, "No default to repay");
      assert.equal((await contract.getContributionRecord(1, 1, bob.address)).arrearsRepaid, false);
    });

    for (const cancelled of [false, true]) {
      it(`rejects repayment in an ${cancelled ? "CANCELLED" : "OPEN"} group`, async function () {
        await contract.createGroup("No arrears", 3, AMOUNT, DURATION, GRACE);
        if (cancelled) await contract.cancelGroup(2);
        await failRepayment(creator, 1, AMOUNT, "Group cannot resolve arrears", 2);
      });
    }

    for (const number of [0, 4, 255]) {
      it(`rejects invalid repayment round ${number}`, async function () {
        await settle([bob]);
        await failRepayment(bob, number, AMOUNT, "Invalid round number");
      });
    }

    for (const number of [1, 2]) {
      it(`rejects repayment of ${number === 1 ? "collecting" : "uninitialized"} round`, async function () {
        await failRepayment(bob, number, AMOUNT, "Round is not settled");
      });
    }

    for (const [label, value] of [["zero", 0n], ["underpayment", AMOUNT - 1n], ["overpayment", AMOUNT + 1n]]) {
      it(`rejects ${label} repayment with every record, total, and balance unchanged`, async function () {
        await settle([bob]);
        await failRepayment(bob, 1, value, "Incorrect repayment amount");
      });
    }

    it("rejects a duplicate repayment without changing timestamps or accounting", async function () {
      await settle([bob]);
      await repayAndCheck(bob, 1);
      await failRepayment(bob, 1, AMOUNT, "Arrears already repaid");
    });

    it("independently repays multiple historical arrears and remains OUTSTANDING until the last is cleared", async function () {
      await settle([bob]);
      await settle([bob]);
      const second = await contract.getContributionRecord(1, 2, bob.address);
      const secondRound = await contract.getRoundDetails(1, 2);
      await repayAndCheck(bob, 1);
      assert.deepEqual(Array.from(await contract.getContributionRecord(1, 2, bob.address)), Array.from(second));
      assert.deepEqual(Array.from(await contract.getRoundDetails(1, 2)), Array.from(secondRound));
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      const receipt = await repayAndCheck(bob, 2);
      assert.deepEqual(names(receipt), ["ArrearsRepaid"]);
      const member = await contract.getMemberDetails(1, bob.address);
      assert.equal(member.totalArrearsRepaid, 2n * AMOUNT);
      assert.equal(member.outstandingArrears, 0n);
      assert.equal(member.defaultCount, 2n);
      assert.equal(member.status, MEMBER.ACTIVE); // Final round is collecting, not settled.
    });

    it("credits the original non-creator recipient rather than the current recipient or creator", async function () {
      await settle();
      await settle([bob]);
      assert.equal((await contract.getRoundDetails(1, 2)).recipient, alice.address);
      assert.equal((await contract.getRoundDetails(1, 3)).recipient, bob.address);
      await repayAndCheck(bob, 2);
      assert.equal(await contract.getWithdrawableBalance(alice.address), 3n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(creator.address), 3n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(bob.address), 0n);
    });

    it("credits self-arrears back to the original recipient without suppressing historical recovery", async function () {
      await settle([creator]);
      await repayAndCheck(creator, 1);
      assert.equal(await contract.getWithdrawableBalance(creator.address), 3n * AMOUNT);
      assert.equal((await contract.getRoundDetails(1, 1)).outstandingShortfall, 0n);
      assert.equal((await contract.getContributionRecord(1, 1, creator.address)).defaulted, true);
    });

    it("keeps the per-round invariant during partial recovery of several distinct whole arrears", async function () {
      await settle([alice, bob]);
      await repayAndCheck(alice, 1);
      const partial = await contract.getRoundDetails(1, 1);
      assert.equal(partial.initiallyCollected, AMOUNT);
      assert.equal(partial.recoveredArrears, AMOUNT);
      assert.equal(partial.outstandingShortfall, AMOUNT);
      await repayAndCheck(bob, 1);
      const full = await contract.getRoundDetails(1, 1);
      assert.equal(full.initiallyCollected + full.recoveredArrears, full.expectedAmount);
      assert.equal(full.outstandingShortfall, 0n);
    });

    it("completes all members and the group once on fully funded final settlement despite unwithdrawn payouts", async function () {
      completions(await settle(), [], false);
      completions(await settle(), [], false);
      const receipt = await settle();
      completions(receipt, wallets, true);
      assert.deepEqual(names(receipt), ["RoundSettled", "PayoutAllocated", "MemberCompleted", "MemberCompleted", "MemberCompleted", "GroupCompleted"]);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
      assert.equal((await contract.getGroupDetails(1)).currentRound, 3n);
      assert.equal((await contract.getRoundDetails(1, 4)).number, 0n);
      for (const wallet of wallets) {
        assert.equal((await contract.getMemberDetails(1, wallet.address)).status, MEMBER.COMPLETED);
        assert.equal(await contract.getWithdrawableBalance(wallet.address), 3n * AMOUNT);
      }
      await reverts(contract.settleRound(1), "Group is not active");
      await reverts(contract.contribute(1, { value: AMOUNT }), "Group is not active");
      await failRepayment(alice, 1, AMOUNT, "No default to repay");
    });

    it("completes clear members at final settlement and automatically completes the last debtor after repayment", async function () {
      await settle();
      await settle();
      completions(await settle([bob]), [creator, alice], false);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.ACTIVE);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      const receipt = await repayAndCheck(bob, 3);
      completions(receipt, [bob], true);
      assert.deepEqual(names(receipt), ["ArrearsRepaid", "MemberCompleted", "GroupCompleted"]);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
      await failRepayment(bob, 3, AMOUNT, "Arrears already repaid");
      for (const wallet of wallets) await withdrawAndCheck(wallet); // No completion re-emission.
    });

    it("does not complete a debtor after only one of two post-rotation repayments", async function () {
      await settle([bob]);
      await settle([bob]);
      completions(await settle(), [creator, alice], false);
      completions(await repayAndCheck(bob, 1), [], false);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.ACTIVE);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      completions(await repayAndCheck(bob, 2), [bob], true);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
      assert.equal((await contract.getMemberDetails(1, bob.address)).defaultCount, 2n);
    });

    it("waits for every debtor while completing each member only once", async function () {
      await settle([alice, bob]);
      await settle();
      completions(await settle(), [creator], false);
      completions(await repayAndCheck(alice, 1), [alice], false);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.ACTIVE);
      assert.equal((await contract.getMemberDetails(1, alice.address)).status, MEMBER.COMPLETED);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.OUTSTANDING);
      completions(await repayAndCheck(bob, 1), [bob], true);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
    });

    it("rejects zero-balance withdrawal and remains usable afterward", async function () {
      const before = await snapshot();
      await reverts(contract.connect(outsider).withdrawPayout(), "No payout to withdraw");
      assert.deepEqual(await snapshot(), before);
      await settle();
      await withdrawAndCheck(creator);
      await reverts(contract.withdrawPayout(), "No payout to withdraw");
    });

    it("withdraws the entire allocation with gas-adjusted native balance and unchanged historical accounting", async function () {
      await settle();
      const round = await contract.getRoundDetails(1, 1);
      const member = await contract.getMemberDetails(1, creator.address);
      assert.equal(await withdrawAndCheck(creator), 3n * AMOUNT);
      assert.deepEqual(Array.from(await contract.getRoundDetails(1, 1)), Array.from(round));
      assert.deepEqual(Array.from(await contract.getMemberDetails(1, creator.address)), Array.from(member));
      await invariant();
    });

    it("allows an OUTSTANDING recipient to withdraw without debt netting", async function () {
      await settle([creator]);
      assert.equal(await withdrawAndCheck(creator), 2n * AMOUNT);
      const member = await contract.getMemberDetails(1, creator.address);
      assert.equal(member.outstandingArrears, AMOUNT);
      assert.equal(member.status, MEMBER.OUTSTANDING);
    });

    it("allows withdrawal after member and group completion", async function () {
      await settle();
      await settle();
      await settle();
      for (const wallet of wallets) await withdrawAndCheck(wallet);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 0n);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
    });

    it("withdraws accumulated allocations across groups and recovery in one call, then accepts future allocations", async function () {
      await settle([bob]);
      await contract.createGroup("More allocations", 3, AMOUNT, DURATION, GRACE);
      for (const wallet of [alice, bob]) {
        await contract.connect(wallet).requestJoin(2);
        await contract.approveJoinRequest(2, wallet.address);
      }
      await settle([], 2);
      await repayAndCheck(bob, 1);
      assert.equal(await withdrawAndCheck(creator), 6n * AMOUNT);
      // A new historical recovery can fund the same wallet after its previous withdrawal.
      // A third group keeps this allocation independent of the first two groups.
      await contract.createGroup("Future recovery", 3, AMOUNT, DURATION, GRACE);
      for (const wallet of [alice, bob]) {
        await contract.connect(wallet).requestJoin(3);
        await contract.approveJoinRequest(3, wallet.address);
      }
      await settle([bob], 3);
      assert.equal(await withdrawAndCheck(creator), 2n * AMOUNT);
      await repayAndCheck(bob, 1, 3);
      assert.equal(await withdrawAndCheck(creator), AMOUNT);
      await invariant(2);
      await invariant(3);
    });

    async function receiverAllocation() {
      const receiver = await ethers.deployContract("WithdrawalReceiver", [await contract.getAddress()]);
      await receiver.waitForDeployment();
      await receiver.createGroup(AMOUNT, DURATION, GRACE);
      for (const wallet of [alice, bob]) {
        await contract.connect(wallet).requestJoin(2);
        await receiver.approve(2, wallet.address);
      }
      for (const wallet of [alice, bob]) await pay(wallet, 2);
      const round = await contract.getRoundDetails(2, 1);
      await network.provider.send("evm_setNextBlockTimestamp", [Number(round.graceDeadline + 1n)]);
      await contract.settleRound(2);
      assert.equal(await contract.getWithdrawableBalance(await receiver.getAddress()), 2n * AMOUNT);
      return receiver;
    }

    it("restores allocation and custody on rejected transfer and releases the guard for a later successful withdrawal", async function () {
      const receiver = await receiverAllocation();
      const address = await receiver.getAddress();
      const balance = await ethers.provider.getBalance(await contract.getAddress());
      await reverts(receiver.withdraw(1), "Payout transfer failed");
      assert.equal(await contract.getWithdrawableBalance(address), 2n * AMOUNT);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), balance);
      assert.equal(await receiver.received(), 0n);
      const receipt = await (await receiver.withdraw(0)).wait();
      assert.equal(event(receipt, "PayoutWithdrawn").recipient, address);
      assert.equal(await contract.getWithdrawableBalance(address), 0n);
      assert.equal(await receiver.received(), 2n * AMOUNT);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), balance - 2n * AMOUNT);
    });

    it("zeros allocation before callback and blocks malicious nested withdrawal without draining another recipient", async function () {
      await settle(); // An unrelated victim's allocation remains in custody during the attack.
      const receiver = await receiverAllocation();
      const receipt = await (await receiver.withdraw(2)).wait();
      assert.equal(await receiver.balanceDuringCallback(), 0n);
      assert.equal(await receiver.nestedSucceeded(), false);
      const result = await receiver.nestedResult();
      assert.equal(result.slice(0, 10), "0x08c379a0");
      assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${result.slice(10)}`)[0], "Withdrawal reentrancy");
      assert.equal(await receiver.received(), 2n * AMOUNT);
      assert.equal(event(receipt, "PayoutWithdrawn").amount, 2n * AMOUNT);
      assert.equal(await contract.getWithdrawableBalance(await receiver.getAddress()), 0n);
      assert.equal(await contract.getWithdrawableBalance(creator.address), 3n * AMOUNT);
      assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 3n * AMOUNT);
      await reverts(receiver.withdraw(2), "No payout to withdraw");
      await withdrawAndCheck(creator);
    });

    it("runs a complete three-member lifecycle, recovers a historical default, completes, and withdraws every payout", async function () {
      await settle([bob]);
      const defaultBefore = await contract.getContributionRecord(1, 1, bob.address);
      await settle(); // OUTSTANDING Bob can still participate in Round 2.
      await repayAndCheck(bob, 1);
      assert.equal((await contract.getMemberDetails(1, bob.address)).status, MEMBER.ACTIVE);
      completions(await settle(), wallets, true);
      const before = await snapshot();
      for (const wallet of wallets) assert.equal(await withdrawAndCheck(wallet), 3n * AMOUNT);
      const after = await snapshot();
      assert.deepEqual(after.rounds, before.rounds);
      assert.deepEqual(after.records, before.records);
      assert.deepEqual(after.members, before.members);
      assert.deepEqual(after.group, before.group);
      assert.equal(after.custody, 0n);
      const evidence = await contract.getContributionRecord(1, 1, bob.address);
      assert.equal(evidence.defaulted, true);
      assert.equal(evidence.defaultTimestamp, defaultBefore.defaultTimestamp);
      assert.equal(evidence.arrearsRepaid, true);
      assert.equal((await contract.getMemberDetails(1, bob.address)).defaultCount, 1n);
      assert.equal((await contract.getGroupDetails(1)).status, GROUP.COMPLETED);
      await invariant();
    });

    it("uses the required indexed fields for recovery, withdrawal, and completion events", async function () {
      const fields = {
        ArrearsRepaid: [true, true, true, false, false], PayoutWithdrawn: [true, false],
        MemberCompleted: [true, true], GroupCompleted: [true],
      };
      for (const [name, expected] of Object.entries(fields)) {
        assert.deepEqual(contract.interface.getEvent(name).inputs.map((input) => input.indexed), expected);
      }
    });
  });

  describe("bounded join-request pagination correction", function () {
    let requesters;

    before(async function () {
      requesters = Array.from({ length: 25 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
    });

    beforeEach(async function () { await create(); });

    async function populate() {
      for (const wallet of requesters) {
        await network.provider.send("hardhat_setBalance", [wallet.address, "0xde0b6b3a7640000"]);
        await (await contract.connect(wallet).requestJoin(1)).wait();
      }
    }

    function assertPage(page, expected, statuses = expected.map(() => REQUEST.PENDING)) {
      assert.deepEqual(Array.from(page.requestApplicants), expected.map((wallet) => wallet.address));
      assert.deepEqual(Array.from(page.statuses), statuses);
    }

    it("returns zero count and empty pages before any request", async function () {
      assert.equal(await contract.getJoinRequestCount(1), 0n);
      assertPage(await contract.getJoinRequestsPage(1, 0, 20), []);
      assertPage(await contract.getJoinRequestsPage(1, ethers.MaxUint256, 1), []);
    });

    it("counts only distinct applicants and preserves re-request deduplication and direct status reads", async function () {
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.NONE);
      await request(alice);
      assert.equal(await contract.getJoinRequestCount(1), 1n);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.PENDING);
      await reverts(contract.connect(alice).requestJoin(1), "Request already exists");
      assert.equal(await contract.getJoinRequestCount(1), 1n);
      await request(bob);
      assert.equal(await contract.getJoinRequestCount(1), 2n);
      await contract.rejectJoinRequest(1, alice.address);
      assertPage(await contract.getJoinRequestsPage(1, 0, 20), [alice, bob], [REQUEST.REJECTED, REQUEST.PENDING]);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.REJECTED);
      await request(alice);
      assert.equal(await contract.getJoinRequestCount(1), 2n);
      assertPage(await contract.getJoinRequestsPage(1, 0, 20), [alice, bob]);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.PENDING);
      await approve(alice);
      assert.equal(await contract.getJoinRequestCount(1), 2n);
      assertPage(await contract.getJoinRequestsPage(1, 0, 20), [alice, bob], [REQUEST.APPROVED, REQUEST.PENDING]);
      assert.equal(await contract.getJoinRequestStatus(1, alice.address), REQUEST.APPROVED);
      assert.equal(await contract.getJoinRequestStatus(1, carol.address), REQUEST.NONE);
    });

    for (const [label, offset, limit, end] of [
      ["first", 0, 10, 10], ["middle", 10, 10, 20], ["partial final", 20, 20, 25],
    ]) {
      it(`returns the correct ${label} page in insertion order`, async function () {
        await populate();
        assertPage(await contract.getJoinRequestsPage(1, offset, limit), requesters.slice(offset, end));
      });
    }

    for (const offset of [25n, 26n, ethers.MaxUint256]) {
      it(`returns empty arrays at ${offset === 25n ? "equal-to-total" : offset === 26n ? "beyond-total" : "maximum uint256"} offset without overflow`, async function () {
        await populate();
        assertPage(await contract.getJoinRequestsPage(1, offset, 20), []);
      });
    }

    for (const limit of [0n, 21n, ethers.MaxUint256]) {
      it(`rejects ${limit === ethers.MaxUint256 ? "maximum uint256" : limit} limit even for an empty or out-of-range page`, async function () {
        await reverts(contract.getJoinRequestsPage(1, 0, limit), "Page limit must be 1 to 20");
        await request(alice);
        await reverts(contract.getJoinRequestsPage(1, ethers.MaxUint256, limit), "Page limit must be 1 to 20");
      });
    }

    it("accepts limit 20 and histories beyond membership capacity without granting membership or capping applicants", async function () {
      await populate();
      assert.equal(await contract.getJoinRequestCount(1), 25n);
      const group = await contract.getGroupDetails(1);
      assert.equal(group.status, GROUP.OPEN);
      assert.equal(group.targetMembers, 3n);
      assert.equal(group.memberCount, 1n);
      assertPage(await contract.getJoinRequestsPage(1, 0, 20), requesters.slice(0, 20));
      assertPage(await contract.getJoinRequestsPage(1, 20, 20), requesters.slice(20));
    });

    it("accepts limit 1 and returns statuses from the current mapping across page boundaries", async function () {
      await populate();
      await contract.rejectJoinRequest(1, requesters[19].address);
      assertPage(await contract.getJoinRequestsPage(1, 19, 1), [requesters[19]], [REQUEST.REJECTED]);
      await (await contract.connect(requesters[19]).requestJoin(1)).wait();
      await contract.approveJoinRequest(1, requesters[20].address);
      assert.equal(await contract.getJoinRequestCount(1), 25n);
      assertPage(await contract.getJoinRequestsPage(1, 19, 2), requesters.slice(19, 21), [REQUEST.PENDING, REQUEST.APPROVED]);
      for (const index of [19, 20]) {
        const page = await contract.getJoinRequestsPage(1, index, 1);
        assert.equal(page.statuses[0], await contract.getJoinRequestStatus(1, requesters[index].address));
      }
    });

    it("retains group existence checks for both new getters", async function () {
      for (const id of [0, 2]) {
        await reverts(contract.getJoinRequestCount(id), "Group does not exist");
        await reverts(contract.getJoinRequestsPage(id, 0, 20), "Group does not exist");
      }
    });
  });

  describe("existence checks and ABI scope", function () {
    const calls = [
      ["requestJoin", []], ["approveJoinRequest", [ethers.ZeroAddress]],
      ["rejectJoinRequest", [ethers.ZeroAddress]], ["cancelGroup", []],
      ["getGroupDetails", []], ["getMembers", []],
      ["getMemberDetails", [ethers.ZeroAddress]], ["getJoinRequestCount", []],
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

    it("exposes exactly the Iteration 4 interface and only the two intended payable entry points", async function () {
      const { abi } = await artifacts.readArtifact("ChainROSCA");
      const functions = abi.filter((item) => item.type === "function");
      assert.deepEqual(functions.map((item) => item.name).sort(), [
        "groupCount", "createGroup", "requestJoin", "approveJoinRequest", "rejectJoinRequest", "cancelGroup",
        "getGroupDetails", "getMembers", "getMemberDetails", "getJoinRequestCount", "getJoinRequestsPage", "getJoinRequestStatus", "getRoundDetails",
        "contribute", "getContributionRecord",
        "settleRound", "getWithdrawableBalance",
        "repayArrears", "withdrawPayout",
      ].sort());
      for (const name of ["startGroup", "completeGroup", "getJoinRequests"]) {
        assert.equal(functions.some((item) => item.name === name), false, `${name} must be absent`);
      }
      assert.deepEqual(functions.filter((item) => item.stateMutability === "payable").map((item) => item.name).sort(), ["contribute", "repayArrears"]);
      assert.equal(abi.some((item) => item.type === "receive" || item.type === "fallback"), false);
      assert.deepEqual(functions.find((item) => item.name === "contribute").inputs.map((item) => item.type), ["uint256"]);
      assert.equal(functions.find((item) => item.name === "settleRound").stateMutability, "nonpayable");
      assert.equal(functions.find((item) => item.name === "withdrawPayout").stateMutability, "nonpayable");
      assert.deepEqual(functions.find((item) => item.name === "withdrawPayout").inputs, []);
      assert.deepEqual(functions.find((item) => item.name === "repayArrears").inputs.map((item) => item.type), ["uint256", "uint8"]);
      assert.deepEqual(functions.find((item) => item.name === "settleRound").inputs.map((item) => item.type), ["uint256"]);
      assert.deepEqual(functions.find((item) => item.name === "getContributionRecord").inputs.map((item) => item.type), ["uint256", "uint8", "address"]);
      assert.deepEqual(functions.find((item) => item.name === "getJoinRequestCount").inputs.map((item) => item.type), ["uint256"]);
      assert.deepEqual(functions.find((item) => item.name === "getJoinRequestsPage").inputs.map((item) => item.type), ["uint256", "uint256", "uint256"]);
      assert.deepEqual(functions.find((item) => item.name === "getJoinRequestStatus").inputs.map((item) => item.type), ["uint256", "address"]);
      assert.deepEqual(abi.filter((item) => item.type === "event").map((item) => item.name).sort(), [
        "GroupCreated", "JoinRequested", "JoinApproved", "JoinRejected", "MemberJoined", "GroupStarted", "GroupCancelled",
        "ContributionMade", "LateContributionMade",
        "MemberDefaulted", "RoundSettled", "PayoutAllocated",
        "ArrearsRepaid", "PayoutWithdrawn", "MemberCompleted", "GroupCompleted",
      ].sort());
    });
  });
});
