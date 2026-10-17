"""Optional MongoDB history index; never used for live financial state."""
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError

from api_utils import APIError


def unavailable():
    return APIError("MONGO_UNAVAILABLE", "Indexed history is unavailable; retry later.", 503)


class HistoryStore:
    def __init__(self, config, client=None):
        self._uri = config.get("MONGODB_URI", "")
        self._name = config.get("MONGODB_DATABASE", "")
        self._client = client
        self._indexed = False

    @property
    def configured(self):
        return bool(self._name and (self._uri or self._client is not None))

    def _database(self):
        if not self.configured:
            raise unavailable()
        if self._client is None:
            self._client = MongoClient(self._uri, connect=False, serverSelectionTimeoutMS=2000,
                                       connectTimeoutMS=2000, socketTimeoutMS=2000, timeoutMS=5000)
        db = self._client[self._name]
        db.command("ping")
        if not self._indexed:
            db.transactions.create_index([("txHash", ASCENDING)], unique=True)
            db.events.create_index([("txHash", ASCENDING), ("logIndex", ASCENDING)], unique=True)
            for subject in ("groupId", "wallet", "recipient"):
                db.events.create_index([(subject, ASCENDING), ("blockNumber", DESCENDING), ("logIndex", DESCENDING)])
            db.events.create_index([("eventName", ASCENDING)])
            self._indexed = True
        return db

    def health(self):
        try:
            self._database()
            reachable = True
        except Exception:
            reachable = False
        return {"configured": self.configured, "reachable": reachable}

    @staticmethod
    def _upsert(collection, key, document):
        fields = {k: v for k, v in document.items() if k != "createdAt"}
        update = {"$set": fields, "$setOnInsert": {"createdAt": document["createdAt"]}}
        try:
            result = collection.update_one(key, update, upsert=True)
        except DuplicateKeyError:
            # Another request may have inserted this unique identity meanwhile.
            result = collection.update_one(key, update, upsert=False)
            if result.matched_count != 1:
                raise unavailable() from None
        if not result.acknowledged:
            raise unavailable()

    def index(self, transaction, events):
        try:
            db = self._database()
            self._upsert(db.transactions, {"txHash": transaction["txHash"]}, transaction)
            # Always revisit every event: a previous request may have stopped
            # after the transaction or any subset of logs was written.
            for event in events:
                self._upsert(db.events, {"txHash": event["txHash"], "logIndex": event["logIndex"]}, event)
        except Exception:
            raise unavailable() from None

    def history(self, *, group_id=None, wallet=None, limit=50, before_block=None, event_name=None, round_number=None):
        if not 1 <= limit <= 100:
            raise APIError("INVALID_PARAMETER", "History limit must be 1–100.")
        stored_group_id = str(group_id) if group_id is not None and group_id > 2**63 - 1 else group_id
        query = {"groupId": stored_group_id} if group_id is not None else {"$or": [{"wallet": wallet}, {"recipient": wallet}]}
        if before_block is not None:
            query["blockNumber"] = {"$lt": before_block}
        if event_name is not None:
            query["eventName"] = event_name
        if round_number is not None:
            query["roundNumber"] = round_number
        try:
            db = self._database()
            items = list(db.events.find(query, {"_id": 0}).sort([("blockNumber", DESCENDING), ("logIndex", DESCENDING)]).limit(limit))
        except Exception:
            raise unavailable() from None
        return {"source": "mongodb-index", "mayBeIncomplete": True, "limit": limit, "items": items,
                "pagination": "beforeBlock is exclusive; a block can contain more results than one page"}
