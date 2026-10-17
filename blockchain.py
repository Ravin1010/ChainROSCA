"""Read-only Sepolia state and independent receipt/event interpretation."""
import json
from datetime import datetime, timezone
from functools import wraps

from hexbytes import HexBytes
from web3 import Web3
from web3.exceptions import ContractLogicError, TransactionNotFound
from web3._utils.events import get_event_data

from api_utils import APIError, ROOT, wallet_address

CHAIN_ID = 11155111
ADDRESS = "0xF3cd73c19b49b58dFa743fB3165Aa753e839b422"
RUNTIME_HASH = "0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc"
ENUMS = {
    "group": ("OPEN", "ACTIVE", "COMPLETED", "CANCELLED"),
    "member": ("REGISTERED", "ACTIVE", "OUTSTANDING", "COMPLETED", "CANCELLED"),
    "join": ("NONE", "PENDING", "APPROVED", "REJECTED"),
    "round": ("NOT_STARTED", "COLLECTING", "SETTLED"),
}
WEI_FIELDS = {"contributionAmount", "totalContributed", "totalArrearsRepaid",
              "outstandingArrears", "expectedAmount", "initiallyCollected",
              "recoveredArrears", "outstandingShortfall", "amount"}
PRIMARY_EVENTS = {
    "createGroup": "GroupCreated", "requestJoin": "JoinRequested",
    "approveJoinRequest": "JoinApproved", "rejectJoinRequest": "JoinRejected",
    "cancelGroup": "GroupCancelled", "contribute": "ContributionMade",
    "settleRound": "RoundSettled", "repayArrears": "ArrearsRepaid",
    "withdrawPayout": "PayoutWithdrawn",
}


def guarded(method):
    @wraps(method)
    def wrapper(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except APIError:
            raise
        except ContractLogicError:
            raise APIError("CONTRACT_REVERT", "Contract read reverted.", 409) from None
        except Exception:
            # Provider exception text may contain authenticated URLs.
            raise APIError("RPC_UNAVAILABLE", "Blockchain service unavailable.", 503) from None
    return wrapper


def status_fields(kind, number):
    number = int(number)
    if not 0 <= number < len(ENUMS[kind]):
        raise APIError("INVALID_CHAIN_DATA", "Unexpected contract status.", 503)
    return {"status": ENUMS[kind][number], "statusCode": number}


def safe_value(value, name=""):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value) if name in WEI_FIELDS or abs(value) > 2**63 - 1 else value
    if isinstance(value, bytes):
        return Web3.to_hex(value)
    if isinstance(value, dict):
        return {k: safe_value(v, k) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [safe_value(v) for v in value]
    return value


class BlockchainService:
    def __init__(self, config, web3=None):
        self._rpc = config.get("SEPOLIA_RPC_URL", "")
        self._web3 = web3
        self._configured_address = config.get("CHAINROSCA_ADDRESS") or ADDRESS
        self._metadata = json.loads((ROOT / "deployment/sepolia.json").read_text())
        self.abi = json.loads((ROOT / "static/abi/ChainROSCA.json").read_text())
        self._functions = {a["name"]: a for a in self.abi if a["type"] == "function"}
        self._events = {Web3.keccak(text=f"{a['name']}({','.join(i['type'] for i in a['inputs'])})"): a
                        for a in self.abi if a["type"] == "event"}

    @property
    def configured(self):
        return bool(self._rpc or self._web3 is not None)

    @guarded
    def connection(self):
        if (not Web3.is_address(self._configured_address)
                or self._configured_address.lower() != ADDRESS.lower()
                or self._metadata["contractAddress"] != ADDRESS
                or self._metadata["chainId"] != CHAIN_ID
                or self._metadata["runtimeBytecode"]["localKeccak256"] != RUNTIME_HASH):
            raise APIError("CONTRACT_MISMATCH", "Authoritative contract configuration mismatch.", 503)
        if not self.configured:
            raise APIError("RPC_UNAVAILABLE", "Blockchain service is not configured.", 503)
        if self._web3 is None:
            self._web3 = Web3(Web3.HTTPProvider(self._rpc, request_kwargs={"timeout": 5},
                                              exception_retry_configuration=None))
        w3 = self._web3
        if w3.eth.chain_id != CHAIN_ID:
            raise APIError("WRONG_CHAIN", "Blockchain provider must use Ethereum Sepolia.", 503)
        code = w3.eth.get_code(ADDRESS)
        if len(code) != 13133 or Web3.to_hex(Web3.keccak(code)) != RUNTIME_HASH:
            raise APIError("RUNTIME_MISMATCH", "Deployed contract runtime mismatch.", 503)
        return w3, w3.eth.contract(address=ADDRESS, abi=self.abi)

    def health(self):
        result = {"configured": self.configured, "reachable": False, "chainId": None,
                  "contractCode": False, "runtimeMatch": None}
        try:
            self.connection()
            result.update(reachable=True, chainId=CHAIN_ID, contractCode=True, runtimeMatch=True)
        except APIError as error:
            result["errorCode"] = error.code
            if error.code == "RUNTIME_MISMATCH":
                result["runtimeMatch"] = False
        return result

    @guarded
    def _call(self, name, *args):
        _, contract = self.connection()
        if args and name != "getWithdrawableBalance":
            if args[0] < 1 or args[0] > contract.functions.groupCount().call():
                raise APIError("GROUP_NOT_FOUND", "Group does not exist.", 404)
        return getattr(contract.functions, name)(*args).call()

    def _fields(self, name, values):
        outputs = self._functions[name]["outputs"]
        fields = outputs[0]["components"] if outputs[0]["type"] == "tuple" else outputs
        return {field["name"]: value for field, value in zip(fields, values)}

    def group_count(self):
        return int(self._call("groupCount"))

    def group(self, group_id):
        data = self._fields("getGroupDetails", self._call("getGroupDetails", group_id))
        data["groupId"] = data.pop("id")
        data.update(status_fields("group", data["status"]))
        return {k + "Wei" if k in WEI_FIELDS else k: safe_value(v, k) for k, v in data.items()}

    def member(self, group_id, wallet):
        wallet = wallet_address(wallet)
        data = self._fields("getMemberDetails", self._call("getMemberDetails", group_id, wallet))
        data.update(status_fields("member", data["status"]), address=wallet,
                    withdrawableBalanceWei=str(self.withdrawable_balance(wallet)))
        return {k + "Wei" if k in WEI_FIELDS else k: safe_value(v, k) for k, v in data.items()}

    def members(self, group_id):
        return [self.member(group_id, address) for address in self._call("getMembers", group_id)]

    def join_request_count(self, group_id):
        return int(self._call("getJoinRequestCount", group_id))

    def join_request_status(self, group_id, applicant):
        return status_fields("join", self._call("getJoinRequestStatus", group_id, wallet_address(applicant)))

    def join_requests(self, group_id, offset=0, limit=20):
        if offset < 0 or not 1 <= limit <= 20:
            raise APIError("INVALID_PARAMETER", "Join-request page limit must be 1–20; offset must be nonnegative.")
        total = self.join_request_count(group_id)
        applicants, statuses = self._call("getJoinRequestsPage", group_id, offset, limit)
        return {"total": total, "offset": offset, "limit": limit,
                "items": [{"applicant": Web3.to_checksum_address(a), **status_fields("join", s)}
                          for a, s in zip(applicants, statuses)]}

    def round(self, group_id, number):
        data = self._fields("getRoundDetails", self._call("getRoundDetails", group_id, number))
        data.update(status_fields("round", data["status"]), groupId=group_id)
        data["roundNumber"] = data.pop("number")
        return {k + "Wei" if k in WEI_FIELDS else k: safe_value(v, k) for k, v in data.items()}

    def contribution_record(self, group_id, number, member):
        return self._fields("getContributionRecord", self._call("getContributionRecord", group_id, number, wallet_address(member)))

    def withdrawable_balance(self, wallet):
        return int(self._call("getWithdrawableBalance", wallet_address(wallet)))

    @guarded
    def verify_transaction(self, tx_hash):
        w3, contract = self.connection()
        try:
            tx = w3.eth.get_transaction(tx_hash)
        except TransactionNotFound:
            raise APIError("TX_NOT_FOUND", "Transaction not found on Sepolia.", 404) from None
        if not tx.get("to") or tx["to"].lower() != ADDRESS.lower():
            raise APIError("WRONG_TARGET", "Transaction does not target ChainROSCA.", 400)
        if tx.get("chainId", CHAIN_ID) != CHAIN_ID:
            raise APIError("WRONG_CHAIN", "Transaction is not on Sepolia.", 400)
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            return {"onChainStatus": "pending", "indexed": False}
        if receipt is None or receipt.get("blockNumber") is None:
            return {"onChainStatus": "pending", "indexed": False}
        if (not receipt.get("to") or receipt["to"].lower() != ADDRESS.lower()
                or Web3.to_hex(receipt["transactionHash"]).lower() != tx_hash
                or Web3.to_hex(tx["hash"]).lower() != tx_hash
                or tx["blockNumber"] != receipt["blockNumber"]
                or tx["blockHash"] != receipt["blockHash"]):
            raise APIError("RECEIPT_MISMATCH", "Transaction and receipt do not match.", 409)
        if receipt["status"] == 0:
            return {"onChainStatus": "reverted", "indexed": False}
        if receipt["status"] != 1:
            raise APIError("INVALID_RECEIPT", "Unsupported receipt status.", 409)
        block = w3.eth.get_block(receipt["blockNumber"])
        if block["hash"] != receipt["blockHash"]:
            raise APIError("CHAIN_CHANGED", "Receipt block is no longer canonical; retry later.", 409)
        try:
            function, params = contract.decode_function_input(tx["input"])
            if function.fn_name not in PRIMARY_EVENTS:
                raise ValueError("Unexpected function")
            events = []
            created_at = datetime.now(timezone.utc).isoformat()
            for log in receipt["logs"]:
                if log["address"].lower() != ADDRESS.lower():
                    continue
                if (log.get("removed", False) or log["transactionHash"] != receipt["transactionHash"]
                        or log["blockHash"] != receipt["blockHash"]):
                    raise ValueError("Log mismatch")
                event_abi = self._events[HexBytes(log["topics"][0])]
                decoded = get_event_data(w3.codec, event_abi, log)
                args = dict(decoded["args"])
                wallet = args.get("member") or args.get("applicant") or args.get("creator")
                recipient = args.get("recipient")
                if decoded["event"] == "PayoutWithdrawn":
                    wallet = recipient
                events.append({"eventName": decoded["event"], "groupId": safe_value(args.get("groupId")),
                               "roundNumber": args.get("roundNumber"), "wallet": wallet,
                               "recipient": recipient, "amountWei": str(args["amount"]) if "amount" in args else None,
                               "txHash": tx_hash, "blockNumber": receipt["blockNumber"],
                               "transactionIndex": receipt["transactionIndex"], "logIndex": log["logIndex"],
                               "blockTimestamp": block["timestamp"], "args": safe_value(args), "createdAt": created_at})
            if PRIMARY_EVENTS[function.fn_name] not in [e["eventName"] for e in events]:
                raise ValueError("Expected event missing")
        except Exception:
            raise APIError("UNINTERPRETABLE_TX", "Transaction call/events do not match the authoritative ABI.", 422) from None
        group_id = params.get("groupId", next((e["groupId"] for e in events if e["groupId"] is not None), None))
        round_number = params.get("roundNumber", next((e["roundNumber"] for e in events if e["roundNumber"] is not None), None))
        document = {"txHash": tx_hash, "wallet": Web3.to_checksum_address(tx["from"]),
                    "contractAddress": ADDRESS, "chainId": CHAIN_ID, "blockNumber": receipt["blockNumber"],
                    "blockTimestamp": block["timestamp"], "status": "confirmed", "type": function.fn_name,
                    "functionName": function.fn_name, "eventNames": [e["eventName"] for e in events],
                    "groupId": safe_value(group_id), "roundNumber": round_number,
                    "transactionIndex": receipt["transactionIndex"], "createdAt": created_at}
        return {"onChainStatus": "confirmed", "transaction": document, "events": events}
