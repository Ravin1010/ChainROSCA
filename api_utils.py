"""Bounded validation, public errors, and runtime-only local configuration."""
import io
import os
import re
from pathlib import Path

from dotenv import dotenv_values
from web3 import Web3

ROOT = Path(__file__).resolve().parent
RUNTIME_KEYS = ("SEPOLIA_RPC_URL", "CHAINROSCA_ADDRESS", "MONGODB_URI", "MONGODB_DATABASE")


class APIError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def runtime_config():
    # Filter before dotenv parsing; deployment-only secrets are never imported
    # into process.env or the backend configuration. Runtime values are single-line.
    local = ROOT / ".env"
    selected = []
    if local.exists():
        with local.open() as stream:
            for line in stream:
                match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=", line)
                if match and match[1] in RUNTIME_KEYS:
                    selected.append(line)
    values = dotenv_values(stream=io.StringIO("".join(selected)), interpolate=False)
    return {key: os.environ.get(key, values.get(key) or "") for key in RUNTIME_KEYS}


def integer(value, name, minimum=0, maximum=2**256 - 1):
    text = str(value)
    if not re.fullmatch(r"[0-9]{1,78}", text):
        raise APIError("INVALID_PARAMETER", f"Invalid {name}.")
    number = int(text)
    if not minimum <= number <= maximum:
        raise APIError("INVALID_PARAMETER", f"Invalid {name}.")
    return number


def wallet_address(value):
    if not isinstance(value, str) or not Web3.is_address(value) or int(value, 16) == 0:
        raise APIError("INVALID_ADDRESS", "Invalid Ethereum wallet address.")
    return Web3.to_checksum_address(value)


def tx_hash(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise APIError("INVALID_TX_HASH", "Invalid transaction hash.")
    return value.lower()
