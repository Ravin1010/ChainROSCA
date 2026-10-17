// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../ChainROSCA.sol";

/// @dev Test-only recipient for rejected transfers and nested withdrawal attempts.
contract WithdrawalReceiver {
    enum Behavior { ACCEPT, REJECT, REENTER }
    ChainROSCA public immutable rosCA;
    Behavior public behavior;
    uint256 public received;
    uint256 public balanceDuringCallback;
    bool public nestedSucceeded;
    bytes public nestedResult;

    constructor(ChainROSCA target) {
        rosCA = target;
    }

    function createGroup(uint256 amount, uint256 duration, uint256 grace) external {
        rosCA.createGroup("Withdrawal safety test", 3, amount, duration, grace);
    }

    function approve(uint256 groupId, address applicant) external {
        rosCA.approveJoinRequest(groupId, applicant);
    }

    function withdraw(Behavior selected) external {
        behavior = selected;
        rosCA.withdrawPayout();
    }

    receive() external payable {
        require(behavior != Behavior.REJECT, "Receiver rejects ETH");
        received += msg.value;
        balanceDuringCallback = rosCA.getWithdrawableBalance(address(this));
        if (behavior == Behavior.REENTER) {
            (nestedSucceeded, nestedResult) = address(rosCA).call(
                abi.encodeCall(ChainROSCA.withdrawPayout, ())
            );
        }
    }
}
