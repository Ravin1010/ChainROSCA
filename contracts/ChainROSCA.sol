// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ROSCA membership, contributions, settlement, arrears, and payouts.
contract ChainROSCA {
    enum GroupStatus { OPEN, ACTIVE, COMPLETED, CANCELLED }
    enum MemberStatus { REGISTERED, ACTIVE, OUTSTANDING, COMPLETED, CANCELLED }
    enum JoinRequestStatus { NONE, PENDING, APPROVED, REJECTED }
    enum RoundStatus { NOT_STARTED, COLLECTING, SETTLED }

    struct Group {
        uint256 id;
        string name;
        address creator;
        uint8 targetMembers;
        uint256 contributionAmount;
        uint256 roundDuration;
        uint256 gracePeriod;
        uint8 currentRound;
        GroupStatus status;
        address[] members;
    }

    struct Member {
        bool exists;
        uint8 payoutRound;
        MemberStatus status;
        uint256 totalContributed;
        uint256 totalArrearsRepaid;
        uint256 outstandingArrears;
        uint256 defaultCount;
    }

    struct Round {
        uint8 number;
        address recipient;
        uint256 startTime;
        uint256 contributionDeadline;
        uint256 graceDeadline;
        uint256 expectedAmount;
        uint256 initiallyCollected;
        uint256 recoveredArrears;
        uint256 outstandingShortfall;
        uint8 contributionCount;
        RoundStatus status;
    }

    struct ContributionRecord {
        bool contributed;
        bool late;
        bool defaulted;
        bool arrearsRepaid;
        uint256 contributionTimestamp;
        uint256 defaultTimestamp;
        uint256 repaymentTimestamp;
    }

    uint256 public groupCount;
    mapping(uint256 => Group) private groups;
    mapping(uint256 => mapping(address => Member)) private members;
    mapping(uint256 => mapping(address => JoinRequestStatus)) private joinRequests;
    mapping(uint256 => address[]) private applicants;
    mapping(uint256 => mapping(address => bool)) private alreadyListed;
    mapping(uint256 => mapping(uint8 => Round)) private rounds;
    mapping(uint256 => mapping(uint8 => mapping(address => ContributionRecord))) private contributionRecords;
    mapping(address => uint256) private withdrawableBalances;
    bool private withdrawing;

    event GroupCreated(uint256 indexed groupId, address indexed creator, string name, uint8 targetMembers);
    event JoinRequested(uint256 indexed groupId, address indexed applicant);
    event JoinApproved(uint256 indexed groupId, address indexed applicant);
    event JoinRejected(uint256 indexed groupId, address indexed applicant);
    event MemberJoined(uint256 indexed groupId, address indexed member, uint8 payoutRound);
    event GroupStarted(uint256 indexed groupId);
    event GroupCancelled(uint256 indexed groupId);
    event ContributionMade(uint256 indexed groupId, uint8 indexed roundNumber, address indexed member, uint256 amount);
    event LateContributionMade(uint256 indexed groupId, uint8 indexed roundNumber, address indexed member, uint256 amount);
    event MemberDefaulted(uint256 indexed groupId, uint8 indexed roundNumber, address indexed member, uint256 amount);
    event RoundSettled(uint256 indexed groupId, uint8 indexed roundNumber, address indexed recipient, uint256 initiallyCollected, uint256 outstandingShortfall);
    event PayoutAllocated(uint256 indexed groupId, uint8 indexed roundNumber, address indexed recipient, uint256 amount);
    event ArrearsRepaid(uint256 indexed groupId, uint8 indexed roundNumber, address indexed member, address recipient, uint256 amount);
    event PayoutWithdrawn(address indexed recipient, uint256 amount);
    event MemberCompleted(uint256 indexed groupId, address indexed member);
    event GroupCompleted(uint256 indexed groupId);

    modifier nonReentrant() {
        require(!withdrawing, "Withdrawal reentrancy");
        withdrawing = true;
        _;
        withdrawing = false;
    }

    modifier groupExists(uint256 groupId) {
        require(groups[groupId].id != 0, "Group does not exist");
        _;
    }

    modifier onlyCreator(uint256 groupId) {
        require(msg.sender == groups[groupId].creator, "Creator only");
        _;
    }

    function createGroup(
        string calldata name,
        uint8 targetMembers,
        uint256 contributionAmount,
        uint256 roundDuration,
        uint256 gracePeriod
    ) external returns (uint256 groupId) {
        require(bytes(name).length > 0, "Name is required");
        require(targetMembers >= 3 && targetMembers <= 5, "Target members must be 3 to 5");
        require(contributionAmount > 0, "Contribution must be positive");
        require(roundDuration > 0, "Round duration must be positive");
        require(gracePeriod > 0, "Grace period must be positive");

        groupId = ++groupCount;
        Group storage group = groups[groupId];
        group.id = groupId;
        group.name = name;
        group.creator = msg.sender;
        group.targetMembers = targetMembers;
        group.contributionAmount = contributionAmount;
        group.roundDuration = roundDuration;
        group.gracePeriod = gracePeriod;
        group.status = GroupStatus.OPEN;
        group.members.push(msg.sender);
        members[groupId][msg.sender].exists = true;
        members[groupId][msg.sender].payoutRound = 1;
        members[groupId][msg.sender].status = MemberStatus.REGISTERED;

        emit GroupCreated(groupId, msg.sender, name, targetMembers);
        emit MemberJoined(groupId, msg.sender, 1);
    }

    function requestJoin(uint256 groupId) external groupExists(groupId) {
        Group storage group = groups[groupId];
        require(group.status == GroupStatus.OPEN, "Group is not open");
        require(!members[groupId][msg.sender].exists, "Already a member");
        require(group.members.length < group.targetMembers, "Group is full");
        JoinRequestStatus status = joinRequests[groupId][msg.sender];
        require(status == JoinRequestStatus.NONE || status == JoinRequestStatus.REJECTED, "Request already exists");

        joinRequests[groupId][msg.sender] = JoinRequestStatus.PENDING;
        if (!alreadyListed[groupId][msg.sender]) {
            alreadyListed[groupId][msg.sender] = true;
            applicants[groupId].push(msg.sender);
        }
        emit JoinRequested(groupId, msg.sender);
    }

    function approveJoinRequest(uint256 groupId, address applicant)
        external groupExists(groupId) onlyCreator(groupId)
    {
        Group storage group = groups[groupId];
        require(group.status == GroupStatus.OPEN, "Group is not open");
        require(applicant != address(0), "Applicant is zero address");
        require(joinRequests[groupId][applicant] == JoinRequestStatus.PENDING, "Request is not pending");
        require(!members[groupId][applicant].exists, "Already a member");
        require(group.members.length < group.targetMembers, "Group is full");

        joinRequests[groupId][applicant] = JoinRequestStatus.APPROVED;
        group.members.push(applicant);
        uint8 payoutRound = uint8(group.members.length);
        members[groupId][applicant].exists = true;
        members[groupId][applicant].payoutRound = payoutRound;
        members[groupId][applicant].status = MemberStatus.REGISTERED;
        emit JoinApproved(groupId, applicant);
        emit MemberJoined(groupId, applicant, payoutRound);

        if (group.members.length == group.targetMembers) {
            _activateGroup(groupId);
        }
    }

    function rejectJoinRequest(uint256 groupId, address applicant)
        external groupExists(groupId) onlyCreator(groupId)
    {
        require(groups[groupId].status == GroupStatus.OPEN, "Group is not open");
        require(applicant != address(0), "Applicant is zero address");
        require(joinRequests[groupId][applicant] == JoinRequestStatus.PENDING, "Request is not pending");
        joinRequests[groupId][applicant] = JoinRequestStatus.REJECTED;
        emit JoinRejected(groupId, applicant);
    }

    function cancelGroup(uint256 groupId) external groupExists(groupId) onlyCreator(groupId) {
        Group storage group = groups[groupId];
        require(group.status == GroupStatus.OPEN, "Group is not open");
        group.status = GroupStatus.CANCELLED;
        for (uint256 i = 0; i < group.members.length; i++) {
            members[groupId][group.members[i]].status = MemberStatus.CANCELLED;
        }
        emit GroupCancelled(groupId);
    }

    function contribute(uint256 groupId) external payable groupExists(groupId) {
        Group storage group = groups[groupId];
        require(group.status == GroupStatus.ACTIVE, "Group is not active");
        Member storage member = members[groupId][msg.sender];
        require(member.exists, "Not a member");
        require(
            member.status == MemberStatus.ACTIVE || member.status == MemberStatus.OUTSTANDING,
            "Member cannot contribute"
        );
        uint8 roundNumber = group.currentRound;
        require(roundNumber > 0, "Round has not started");
        Round storage round = rounds[groupId][roundNumber];
        require(round.status == RoundStatus.COLLECTING, "Round is not collecting");
        ContributionRecord storage record = contributionRecords[groupId][roundNumber][msg.sender];
        require(!record.contributed, "Already contributed");
        require(msg.value == group.contributionAmount, "Incorrect contribution amount");
        require(block.timestamp <= round.graceDeadline, "Grace deadline has passed");

        bool late = block.timestamp > round.contributionDeadline;
        record.contributed = true;
        record.late = late;
        record.contributionTimestamp = block.timestamp;
        round.initiallyCollected += msg.value;
        round.contributionCount += 1;
        member.totalContributed += msg.value;

        if (late) {
            emit LateContributionMade(groupId, roundNumber, msg.sender, msg.value);
        } else {
            emit ContributionMade(groupId, roundNumber, msg.sender, msg.value);
        }
    }

    function settleRound(uint256 groupId) external groupExists(groupId) {
        Group storage group = groups[groupId];
        require(group.status == GroupStatus.ACTIVE, "Group is not active");
        uint8 roundNumber = group.currentRound;
        require(roundNumber > 0, "Round has not started");
        Round storage round = rounds[groupId][roundNumber];
        require(round.status == RoundStatus.COLLECTING, "Round is not collecting");
        bool fullyFunded = round.contributionCount == group.targetMembers;
        require(fullyFunded || block.timestamp > round.graceDeadline, "Settlement is not ready");

        if (!fullyFunded) {
            for (uint256 i = 0; i < group.members.length; i++) {
                address wallet = group.members[i];
                ContributionRecord storage record = contributionRecords[groupId][roundNumber][wallet];
                if (!record.contributed) {
                    record.defaulted = true;
                    record.defaultTimestamp = block.timestamp;
                    Member storage member = members[groupId][wallet];
                    member.defaultCount += 1;
                    member.outstandingArrears += group.contributionAmount;
                    member.status = MemberStatus.OUTSTANDING;
                    emit MemberDefaulted(groupId, roundNumber, wallet, group.contributionAmount);
                }
            }
        }

        round.outstandingShortfall = round.expectedAmount - round.initiallyCollected;
        round.status = RoundStatus.SETTLED;
        withdrawableBalances[round.recipient] += round.initiallyCollected;
        emit RoundSettled(groupId, roundNumber, round.recipient, round.initiallyCollected, round.outstandingShortfall);
        emit PayoutAllocated(groupId, roundNumber, round.recipient, round.initiallyCollected);

        if (roundNumber < group.targetMembers) {
            _initializeRound(groupId, roundNumber + 1);
        } else {
            _updateCompletion(groupId);
        }
    }

    function repayArrears(uint256 groupId, uint8 roundNumber) external payable groupExists(groupId) {
        Group storage group = groups[groupId];
        Member storage member = members[groupId][msg.sender];
        require(member.exists, "Not a member");
        require(
            group.status == GroupStatus.ACTIVE || group.status == GroupStatus.COMPLETED,
            "Group cannot resolve arrears"
        );
        require(roundNumber > 0 && roundNumber <= group.targetMembers, "Invalid round number");
        Round storage round = rounds[groupId][roundNumber];
        require(round.status == RoundStatus.SETTLED, "Round is not settled");
        ContributionRecord storage record = contributionRecords[groupId][roundNumber][msg.sender];
        require(record.defaulted, "No default to repay");
        require(!record.arrearsRepaid, "Arrears already repaid");
        require(msg.value == group.contributionAmount, "Incorrect repayment amount");

        record.arrearsRepaid = true;
        record.repaymentTimestamp = block.timestamp;
        member.totalArrearsRepaid += msg.value;
        member.outstandingArrears -= msg.value;
        round.recoveredArrears += msg.value;
        round.outstandingShortfall -= msg.value;
        withdrawableBalances[round.recipient] += msg.value;
        member.status = member.outstandingArrears == 0 ? MemberStatus.ACTIVE : MemberStatus.OUTSTANDING;
        emit ArrearsRepaid(groupId, roundNumber, msg.sender, round.recipient, msg.value);
        _updateCompletion(groupId);
    }

    function withdrawPayout() external nonReentrant {
        uint256 amount = withdrawableBalances[msg.sender];
        require(amount > 0, "No payout to withdraw");
        withdrawableBalances[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Payout transfer failed");
        emit PayoutWithdrawn(msg.sender, amount);
    }

    function _updateCompletion(uint256 groupId) internal {
        Group storage group = groups[groupId];
        if (group.currentRound != group.targetMembers
            || rounds[groupId][group.targetMembers].status != RoundStatus.SETTLED) {
            return;
        }
        bool allClear = true;
        for (uint256 i = 0; i < group.members.length; i++) {
            address wallet = group.members[i];
            Member storage member = members[groupId][wallet];
            if (member.outstandingArrears > 0) {
                member.status = MemberStatus.OUTSTANDING;
                allClear = false;
            } else if (member.status != MemberStatus.COMPLETED) {
                member.status = MemberStatus.COMPLETED;
                emit MemberCompleted(groupId, wallet);
            }
        }
        if (allClear && group.status != GroupStatus.COMPLETED) {
            group.status = GroupStatus.COMPLETED;
            emit GroupCompleted(groupId);
        }
    }

    function _activateGroup(uint256 groupId) internal {
        Group storage group = groups[groupId];
        group.status = GroupStatus.ACTIVE;
        for (uint256 i = 0; i < group.members.length; i++) {
            members[groupId][group.members[i]].status = MemberStatus.ACTIVE;
        }
        _initializeRound(groupId, 1);
        emit GroupStarted(groupId);
    }

    /// @dev Called only for a fresh round in the fixed payout rotation.
    function _initializeRound(uint256 groupId, uint8 roundNumber) internal {
        Group storage group = groups[groupId];
        group.currentRound = roundNumber;
        Round storage round = rounds[groupId][roundNumber];
        round.number = roundNumber;
        round.recipient = group.members[roundNumber - 1];
        round.startTime = block.timestamp;
        round.contributionDeadline = block.timestamp + group.roundDuration;
        round.graceDeadline = round.contributionDeadline + group.gracePeriod;
        round.expectedAmount = uint256(group.targetMembers) * group.contributionAmount;
        round.status = RoundStatus.COLLECTING;
    }

    function getGroupDetails(uint256 groupId) external view groupExists(groupId) returns (
        uint256 id, string memory name, address creator, uint8 targetMembers,
        uint256 contributionAmount, uint256 roundDuration, uint256 gracePeriod,
        uint8 currentRound, GroupStatus status, uint256 memberCount
    ) {
        Group storage group = groups[groupId];
        return (group.id, group.name, group.creator, group.targetMembers,
            group.contributionAmount, group.roundDuration, group.gracePeriod,
            group.currentRound, group.status, group.members.length);
    }

    function getMembers(uint256 groupId) external view groupExists(groupId) returns (address[] memory) {
        return groups[groupId].members;
    }

    function getMemberDetails(uint256 groupId, address member)
        external view groupExists(groupId) returns (Member memory)
    {
        return members[groupId][member];
    }

    function getJoinRequests(uint256 groupId) external view groupExists(groupId)
        returns (address[] memory requestApplicants, JoinRequestStatus[] memory statuses)
    {
        requestApplicants = applicants[groupId];
        statuses = new JoinRequestStatus[](requestApplicants.length);
        for (uint256 i = 0; i < requestApplicants.length; i++) {
            statuses[i] = joinRequests[groupId][requestApplicants[i]];
        }
    }

    function getJoinRequestStatus(uint256 groupId, address applicant)
        external view groupExists(groupId) returns (JoinRequestStatus)
    {
        return joinRequests[groupId][applicant];
    }

    /// @dev An uninitialized round returns zero fields and NOT_STARTED.
    function getRoundDetails(uint256 groupId, uint8 roundNumber)
        external view groupExists(groupId) returns (Round memory)
    {
        return rounds[groupId][roundNumber];
    }

    function getContributionRecord(uint256 groupId, uint8 roundNumber, address member)
        external view groupExists(groupId) returns (ContributionRecord memory)
    {
        return contributionRecords[groupId][roundNumber][member];
    }

    function getWithdrawableBalance(address wallet) external view returns (uint256) {
        return withdrawableBalances[wallet];
    }
}
