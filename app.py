"""Flask JSON read API and independently verified transaction-history ingestion."""
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from api_utils import APIError, integer, runtime_config, tx_hash, wallet_address
from blockchain import ADDRESS, CHAIN_ID, BlockchainService
from database import HistoryStore


def create_app(config=None, *, blockchain=None, database=None):
    app = Flask(__name__)
    app.config.update(runtime_config() if config is None else config)
    app.config["MAX_CONTENT_LENGTH"] = 4096
    chain = blockchain if blockchain is not None else BlockchainService(app.config)
    history = database if database is not None else HistoryStore(app.config)
    app.extensions.update(blockchain=chain, history=history)

    @app.errorhandler(APIError)
    def api_error(error):
        return jsonify(error={"code": error.code, "message": error.message}), error.status

    @app.errorhandler(Exception)
    def safe_error(error):
        if isinstance(error, HTTPException):
            code = "MALFORMED_JSON" if error.code == 400 else "HTTP_ERROR"
            return jsonify(error={"code": code, "message": error.name}), error.code
        return jsonify(error={"code": "INTERNAL_ERROR", "message": "Request could not be completed."}), 500

    def group_id(value):
        return integer(value, "group id", 1)

    def round_id(value):
        return integer(value, "round number", 1, 255)

    def history_options():
        options = {"limit": integer(request.args.get("limit", "50"), "limit", 1, 100)}
        for param, key, max_value in (("beforeBlock", "before_block", 2**63 - 1), ("round", "round_number", 255)):
            if param in request.args:
                options[key] = integer(request.args[param], param, 1, max_value)
        if "eventName" in request.args:
            name = request.args["eventName"]
            names = {item["name"] for item in chain.abi if item["type"] == "event"}
            if name not in names:
                raise APIError("INVALID_PARAMETER", "Unknown event name.")
            options["event_name"] = name
        return options

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/config")
    def public_config():
        return jsonify(network="sepolia", chainId=CHAIN_ID, contractAddress=ADDRESS,
                       explorerBaseUrl="https://sepolia.etherscan.io", abiUrl="/static/abi/ChainROSCA.json",
                       historySource="mongodb-index")

    @app.get("/api/health")
    def health():
        blockchain_health, mongo_health = chain.health(), history.health()
        ok = blockchain_health["reachable"] and mongo_health["reachable"]
        return jsonify(status="ok" if ok else "degraded", flask={"status": "ok"},
                       blockchain=blockchain_health, mongodb=mongo_health)

    @app.get("/api/groups/<identifier>")
    def group(identifier):
        return jsonify(chain.group(group_id(identifier)))

    @app.get("/api/groups/<identifier>/members")
    def members(identifier):
        return jsonify(groupId=group_id(identifier), items=chain.members(group_id(identifier)))

    @app.get("/api/groups/<identifier>/join-requests")
    def join_requests(identifier):
        offset = integer(request.args.get("offset", "0"), "offset")
        limit = integer(request.args.get("limit", "20"), "limit", 1, 20)
        return jsonify(chain.join_requests(group_id(identifier), offset, limit))

    @app.get("/api/groups/<identifier>/members/<wallet>")
    def member(identifier, wallet):
        return jsonify(chain.member(group_id(identifier), wallet_address(wallet)))

    @app.get("/api/groups/<identifier>/rounds/<number>")
    def round_details(identifier, number):
        return jsonify(chain.round(group_id(identifier), round_id(number)))

    @app.get("/api/groups/<identifier>/history")
    def group_history(identifier):
        return jsonify(history.history(group_id=group_id(identifier), **history_options()))

    @app.get("/api/wallet/<wallet>/history")
    def wallet_history(wallet):
        return jsonify(history.history(wallet=wallet_address(wallet), **history_options()))

    @app.post("/api/transactions")
    def transactions():
        body = request.get_json()
        if not isinstance(body, dict) or set(body) != {"txHash"}:
            raise APIError("INVALID_BODY", "Body must contain only txHash.")
        verified = chain.verify_transaction(tx_hash(body["txHash"]))
        state = verified["onChainStatus"]
        if state != "confirmed":
            return jsonify(verified), 202 if state == "pending" else 422
        try:
            history.index(verified["transaction"], verified["events"])
        except Exception:
            return jsonify(onChainStatus="confirmed", indexed=False,
                           transaction=verified["transaction"],
                           warning={"code": "INDEX_UNAVAILABLE", "message": "Ethereum transaction succeeded; history indexing can be retried."}), 200
        return jsonify(onChainStatus="confirmed", indexed=True,
                       transaction=verified["transaction"], events=verified["events"])

    return app


app = create_app()

if __name__ == "__main__":
    app.run()
