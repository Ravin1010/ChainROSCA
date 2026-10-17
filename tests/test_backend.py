"""Offline API, ABI decoding, trust-boundary, and index recovery tests."""
import ast
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from eth_abi import encode
from hexbytes import HexBytes
from pymongo.errors import DuplicateKeyError
from web3 import Web3
from web3.exceptions import ContractLogicError, TransactionNotFound

from api_utils import APIError, ROOT, runtime_config, wallet_address
from app import create_app
from blockchain import ADDRESS, CHAIN_ID, RUNTIME_HASH, BlockchainService, safe_value, status_fields
from database import HistoryStore

A = Web3.to_checksum_address('0x' + 'ab' * 20)
B = Web3.to_checksum_address('0x' + 'cd' * 20)
HASH = '0x' + '12' * 32
BLOCK_HASH = HexBytes('0x' + '34' * 32)
AMOUNT = 10**25


class Cursor:
    def __init__(self, values):
        self.values = list(values)
    def sort(self, keys):
        self.keys = keys
        for key, direction in reversed(keys):
            self.values.sort(key=lambda v: v[key], reverse=direction < 0)
        return self
    def limit(self, count):
        return self.values[:count]


class Collection:
    def __init__(self):
        self.documents, self.indexes = [], []
        self.failure_at, self.calls = None, 0
        self.duplicate_once = False
    def create_index(self, keys, **options):
        self.indexes.append((keys, options))
    def update_one(self, key, update, upsert=False):
        self.calls += 1
        if self.failure_at == self.calls:
            raise RuntimeError('private provider detail must not escape')
        if self.duplicate_once:
            self.duplicate_once = False
            raise DuplicateKeyError('race')
        doc = next((d for d in self.documents if all(d.get(k) == v for k, v in key.items())), None)
        matched = doc is not None
        if doc is None and upsert:
            doc = dict(key)
            doc.update(update.get('$setOnInsert', {}))
            self.documents.append(doc)
        if doc is not None:
            doc.update(copy.deepcopy(update['$set']))
        return SimpleNamespace(matched_count=int(matched), acknowledged=True)
    def find(self, query, projection):
        self.last_query, self.projection = query, projection
        return Cursor(self.documents)


class Database:
    def __init__(self):
        self.transactions, self.events = Collection(), Collection()
    def command(self, command):
        assert command == 'ping'


def store_fixture():
    db = Database()
    client = Mock()
    client.__getitem__ = Mock(return_value=db)
    return HistoryStore({'MONGODB_DATABASE': 'test'}, client=client), db


def log_fixture(service, name, args, index):
    event = next(a for a in service.abi if a['type'] == 'event' and a['name'] == name)
    topics = [Web3.keccak(text=f"{name}({','.join(i['type'] for i in event['inputs'])})")]
    data_types, data_values = [], []
    for item in event['inputs']:
        value = args[item['name']]
        if item['indexed']:
            topics.append(HexBytes(encode([item['type']], [value])))
        else:
            data_types.append(item['type'])
            data_values.append(value)
    return {'address': ADDRESS, 'topics': topics, 'data': HexBytes(encode(data_types, data_values)),
            'logIndex': index, 'transactionIndex': 2, 'transactionHash': HexBytes(HASH),
            'blockNumber': 10, 'blockHash': BLOCK_HASH}


def verifier_fixture(function='createGroup', params=None, event_specs=None):
    service = BlockchainService({})
    w3 = Mock()
    w3.codec = Web3().codec
    contract = Web3().eth.contract(address=ADDRESS, abi=service.abi)
    service.connection = Mock(return_value=(w3, contract))
    if params is None:
        params = ['Savings', 3, AMOUNT, 3600, 600]
    if event_specs is None:
        event_specs = [('GroupCreated', {'groupId': 1, 'creator': A, 'name': 'Savings', 'targetMembers': 3}),
                       ('MemberJoined', {'groupId': 1, 'member': A, 'payoutRound': 1})]
    tx = {'hash': HexBytes(HASH), 'to': ADDRESS, 'from': A, 'chainId': CHAIN_ID,
          'blockNumber': 10, 'blockHash': BLOCK_HASH,
          'input': HexBytes(contract.encode_abi(function, args=params))}
    receipt = {'transactionHash': HexBytes(HASH), 'to': ADDRESS, 'status': 1,
               'blockNumber': 10, 'blockHash': BLOCK_HASH, 'transactionIndex': 2,
               'logs': [log_fixture(service, n, a, i) for i, (n, a) in enumerate(event_specs)]}
    w3.eth.get_transaction.return_value = tx
    w3.eth.get_transaction_receipt.return_value = receipt
    w3.eth.get_block.return_value = {'hash': BLOCK_HASH, 'timestamp': 1700000000}
    return service, w3, tx, receipt


class ReadAPITests(unittest.TestCase):
    def setUp(self):
        self.chain = BlockchainService({})
        values = {
            'groupCount': 1,
            'getGroupDetails': (1, 'Savings', A, 3, AMOUNT, 3600, 600, 1, 1, 3),
            'getMembers': [B, A],
            'getMemberDetails': (True, 2, 2, AMOUNT, 0, AMOUNT, 1),
            'getWithdrawableBalance': AMOUNT,
            'getJoinRequestCount': 24,
            'getJoinRequestsPage': ([B], [3]),
            'getJoinRequestStatus': 3,
            'getRoundDetails': (1, A, 100, 3700, 4300, AMOUNT * 3, AMOUNT, 0, AMOUNT * 2, 1, 2),
            'getContributionRecord': (False, False, True, False, 0, 4301, 0),
        }
        self.chain._call = Mock(side_effect=lambda name, *args: values[name])
        self.chain.health = Mock(return_value={'configured': True, 'reachable': True, 'chainId': CHAIN_ID,
                                              'contractCode': True, 'runtimeMatch': True})
        self.store = Mock()
        self.store.health.return_value = {'configured': True, 'reachable': True}
        self.store.history.return_value = {'source': 'mongodb-index', 'mayBeIncomplete': True, 'items': []}
        self.client = create_app({}, blockchain=self.chain, database=self.store).test_client()

    def test_baseline_page_retained(self):
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_public_config_allowlist(self):
        result = self.client.get('/api/config').json
        self.assertEqual(set(result), {'network', 'chainId', 'contractAddress', 'explorerBaseUrl', 'abiUrl', 'historySource'})
        self.assertEqual(result['contractAddress'], ADDRESS)

    def test_health_ok_and_degraded(self):
        self.assertEqual(self.client.get('/api/health').json['status'], 'ok')
        self.store.health.return_value = {'configured': False, 'reachable': False}
        response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['status'], 'degraded')

    def test_group_enum_and_large_wei_string(self):
        result = self.client.get('/api/groups/1').json
        self.assertEqual(result['groupId'], 1)
        self.assertEqual((result['status'], result['statusCode']), ('ACTIVE', 1))
        self.assertEqual(result['contributionAmountWei'], str(AMOUNT))
        self.assertEqual(result['memberCount'], 3)

    def test_member_order_and_financial_fields(self):
        result = self.client.get('/api/groups/1/members').json['items']
        self.assertEqual([m['address'] for m in result], [B, A])
        self.assertEqual(result[0]['outstandingArrearsWei'], str(AMOUNT))
        self.assertEqual(result[0]['withdrawableBalanceWei'], str(AMOUNT))
        self.assertEqual(result[0]['status'], 'OUTSTANDING')

    def test_join_page_bounded_current_status(self):
        response = self.client.get('/api/groups/1/join-requests?offset=20&limit=4')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {'total': 24, 'offset': 20, 'limit': 4,
                                        'items': [{'applicant': B, 'status': 'REJECTED', 'statusCode': 3}]})
        self.chain._call.assert_any_call('getJoinRequestsPage', 1, 20, 4)

    def test_join_pagination_invalid(self):
        for query in ('limit=0', 'limit=21', 'offset=-1', 'limit=abc', 'offset=1.5'):
            with self.subTest(query=query):
                self.assertEqual(self.client.get('/api/groups/1/join-requests?' + query).status_code, 400)

    def test_default_join_page_limit(self):
        self.client.get('/api/groups/1/join-requests')
        self.chain._call.assert_any_call('getJoinRequestsPage', 1, 0, 20)

    def test_wallet_normalized_from_any_casing(self):
        for wallet in (A.lower(), A, '0x' + A[2:].upper()):
            result = self.client.get('/api/groups/1/members/' + wallet).json
            self.assertEqual(result['address'], A)

    def test_invalid_wallets_rejected(self):
        for wallet in ('garbage', '0x' + '00' * 20, '0x1234'):
            self.assertEqual(self.client.get('/api/groups/1/members/' + wallet).status_code, 400)

    def test_round_serializer_and_uint8_validation(self):
        result = self.client.get('/api/groups/1/rounds/1').json
        self.assertEqual(result['status'], 'SETTLED')
        self.assertEqual(result['outstandingShortfallWei'], str(AMOUNT * 2))
        self.assertEqual(result['roundNumber'], 1)
        for number in ('0', '256', '-1', 'x'):
            self.assertEqual(self.client.get('/api/groups/1/rounds/' + number).status_code, 400)

    def test_invalid_group_ids(self):
        for identifier in ('0', '-1', 'word', str(2**256)):
            self.assertEqual(self.client.get('/api/groups/' + identifier).status_code, 400)

    def test_missing_group_and_revert_safe_errors(self):
        self.chain._call.side_effect = APIError('GROUP_NOT_FOUND', 'Group does not exist.', 404)
        self.assertEqual(self.client.get('/api/groups/2').status_code, 404)
        self.chain._call.side_effect = APIError('CONTRACT_REVERT', 'Contract read reverted.', 409)
        self.assertEqual(self.client.get('/api/groups/1').status_code, 409)

    def test_rpc_outage_returns_503(self):
        self.chain._call.side_effect = APIError('RPC_UNAVAILABLE', 'Blockchain service unavailable.', 503)
        self.assertEqual(self.client.get('/api/groups/1').status_code, 503)

    def test_mongo_outage_does_not_affect_live_reads(self):
        self.store.history.side_effect = APIError('MONGO_UNAVAILABLE', 'History unavailable.', 503)
        self.assertEqual(self.client.get('/api/groups/1').status_code, 200)
        self.assertEqual(self.client.get('/api/groups/1/history').status_code, 503)

    def test_history_group_filter_pagination(self):
        result = self.client.get('/api/groups/1/history?limit=25&beforeBlock=200&round=2&eventName=ArrearsRepaid')
        self.assertEqual(result.status_code, 200)
        self.store.history.assert_called_once_with(group_id=1, limit=25, before_block=200,
                                                  round_number=2, event_name='ArrearsRepaid')
        self.assertEqual(result.json['source'], 'mongodb-index')

    def test_history_wallet_filter_normalized(self):
        self.client.get('/api/wallet/' + A.lower() + '/history')
        self.store.history.assert_called_once_with(wallet=A, limit=50)

    def test_history_invalid_filters(self):
        for query in ('limit=101', 'limit=0', 'round=0', 'beforeBlock=-1', 'eventName=Invented'):
            self.assertEqual(self.client.get('/api/groups/1/history?' + query).status_code, 400)

    def test_contribution_and_direct_join_helpers(self):
        self.assertEqual(self.chain.contribution_record(1, 1, A)['defaulted'], True)
        self.assertEqual(self.chain.join_request_status(1, A)['status'], 'REJECTED')
        self.assertEqual(self.chain.group_count(), 1)

    def test_every_enum_name_and_bson_large_integer(self):
        from blockchain import ENUMS
        for kind, names in ENUMS.items():
            for code, name in enumerate(names):
                self.assertEqual(status_fields(kind, code), {'status': name, 'statusCode': code})
        self.assertEqual(safe_value({'amount': 1, 'groupId': 2**100}), {'amount': '1', 'groupId': str(2**100)})
        with self.assertRaises(APIError):
            status_fields('group', 99)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.chain, self.w3, self.tx, self.receipt = verifier_fixture()
        self.store, self.db = store_fixture()
        self.client = create_app({}, blockchain=self.chain, database=self.store).test_client()

    def post(self, body=None):
        return self.client.post('/api/transactions', json={'txHash': HASH} if body is None else body)

    def test_malformed_hashes(self):
        for value in ('0x12', '', 123, None, '0x' + 'z' * 64):
            self.assertEqual(self.post({'txHash': value}).status_code, 400)
        self.w3.eth.get_transaction.assert_not_called()

    def test_reject_all_untrusted_extra_fields(self):
        for key in ('status', 'type', 'function', 'groupId', 'roundNumber', 'amount', 'wallet', 'recipient', 'events', 'blockNumber'):
            self.assertEqual(self.post({'txHash': HASH, key: 'untrusted'}).status_code, 400)
        self.w3.eth.get_transaction.assert_not_called()

    def test_malformed_json_and_body_shapes(self):
        self.assertEqual(self.client.post('/api/transactions', data='{broken', content_type='application/json').status_code, 400)
        for data in ([], {}, {'other': HASH}):
            self.assertEqual(self.post(data).status_code, 400)

    def test_pending_receipt_no_index(self):
        self.w3.eth.get_transaction_receipt.side_effect = TransactionNotFound('pending')
        response = self.post()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json, {'onChainStatus': 'pending', 'indexed': False})
        self.assertEqual(self.db.transactions.documents, [])

    def test_missing_transaction_is_404(self):
        self.w3.eth.get_transaction.side_effect = TransactionNotFound('missing')
        self.assertEqual(self.post().status_code, 404)

    def test_reverted_transaction_not_indexed(self):
        self.receipt['status'] = 0
        response = self.post()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json['onChainStatus'], 'reverted')
        self.assertEqual(self.db.transactions.documents, [])

    def test_wrong_target_tx_or_receipt(self):
        for subject in (self.tx, self.receipt):
            previous = subject['to']
            subject['to'] = B
            self.assertIn(self.post().status_code, (400, 409))
            subject['to'] = previous
        self.assertEqual(self.db.transactions.documents, [])

    def test_success_metadata_and_all_logs_derived_from_chain(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['indexed'])
        doc = self.db.transactions.documents[0]
        self.assertEqual((doc['wallet'], doc['functionName'], doc['groupId']), (A, 'createGroup', 1))
        self.assertEqual(doc['blockTimestamp'], 1700000000)
        self.assertEqual(len(self.db.events.documents), 2)
        self.assertEqual(doc['eventNames'], ['GroupCreated', 'MemberJoined'])

    def test_foreign_logs_ignored(self):
        self.receipt['logs'].append({**self.receipt['logs'][0], 'address': B})
        self.assertEqual(len(self.post().json['events']), 2)

    def test_unknown_contract_event_rejected(self):
        self.receipt['logs'][0]['topics'][0] = HexBytes('0x' + 'ff' * 32)
        response = self.post()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.db.transactions.documents, [])

    def test_missing_expected_event_or_unknown_input_rejected(self):
        self.receipt['logs'] = []
        self.assertEqual(self.post().status_code, 422)
        self.tx['input'] = HexBytes('0xdeadbeef')
        self.assertEqual(self.post().status_code, 422)

    def test_bounded_body_and_json_404(self):
        self.assertEqual(self.client.post('/api/transactions', data='x' * 5000, content_type='application/json').status_code, 413)
        self.assertIn('error', self.client.get('/api/not-a-route').json)

    def test_none_receipt_is_pending(self):
        self.w3.eth.get_transaction_receipt.return_value = None
        self.assertEqual(self.post().status_code, 202)
        self.assertEqual(self.db.events.documents, [])

    def test_transaction_wrong_chain_and_invalid_receipt_status(self):
        self.tx['chainId'] = 1
        self.assertEqual(self.post().status_code, 400)
        self.tx['chainId'] = CHAIN_ID
        self.receipt['status'] = 2
        self.assertEqual(self.post().status_code, 409)

    def test_read_only_call_cannot_be_indexed_as_write(self):
        contract = self.chain.connection.return_value[1]
        self.tx['input'] = HexBytes(contract.encode_abi('getMembers', args=[1]))
        self.assertEqual(self.post().status_code, 422)
        self.assertEqual(self.db.transactions.documents, [])

    def test_removed_authoritative_log_is_rejected(self):
        self.receipt['logs'][0]['removed'] = True
        self.assertEqual(self.post().status_code, 422)

    def test_financial_function_and_historical_round_derived_from_abi(self):
        service, _, _, _ = verifier_fixture('repayArrears', [1, 2], [
            ('ArrearsRepaid', {'groupId': 1, 'roundNumber': 2, 'member': A, 'recipient': B, 'amount': AMOUNT})])
        result = service.verify_transaction(HASH)
        self.assertEqual((result['transaction']['functionName'], result['transaction']['roundNumber']), ('repayArrears', 2))
        self.assertEqual(result['events'][0]['recipient'], B)
        self.assertEqual(result['events'][0]['amountWei'], str(AMOUNT))

    def test_receipt_or_canonical_block_mismatch(self):
        self.w3.eth.get_block.return_value['hash'] = HexBytes('0x' + '99' * 32)
        self.assertEqual(self.post().status_code, 409)
        self.w3.eth.get_block.return_value['hash'] = BLOCK_HASH
        self.receipt['transactionHash'] = HexBytes('0x' + '55' * 32)
        self.assertEqual(self.post().status_code, 409)

    def test_idempotent_resubmission(self):
        self.assertTrue(self.post().json['indexed'])
        self.assertTrue(self.post().json['indexed'])
        self.assertEqual(len(self.db.transactions.documents), 1)
        self.assertEqual(len(self.db.events.documents), 2)
        self.assertEqual(self.db.events.calls, 4)

    def test_partial_event_write_repaired_by_retry(self):
        self.db.events.failure_at = 2
        first = self.post()
        self.assertEqual(first.json['onChainStatus'], 'confirmed')
        self.assertFalse(first.json['indexed'])
        self.assertEqual(len(self.db.transactions.documents), 1)
        self.assertEqual(len(self.db.events.documents), 1)
        self.db.events.failure_at = None
        self.assertTrue(self.post().json['indexed'])
        self.assertEqual(len(self.db.transactions.documents), 1)
        self.assertEqual(len(self.db.events.documents), 2)

    def test_transaction_write_only_repaired_by_retry(self):
        self.db.events.failure_at = 1
        self.assertFalse(self.post().json['indexed'])
        self.db.events.failure_at = None
        self.assertTrue(self.post().json['indexed'])
        self.assertEqual(len(self.db.events.documents), 2)

    def test_chain_success_mongo_failure_stays_confirmed(self):
        self.store._database = Mock(side_effect=RuntimeError('secret-uri'))
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['onChainStatus'], 'confirmed')
        self.assertFalse(response.json['indexed'])
        self.assertNotIn('secret-uri', response.get_data(as_text=True))

    def test_all_production_event_normalization(self):
        for event in (a for a in self.chain.abi if a['type'] == 'event'):
            with self.subTest(event=event['name']):
                args = {i['name']: A if i['type'] == 'address' else 'Group' if i['type'] == 'string' else AMOUNT if i['name'] in ('amount', 'initiallyCollected', 'outstandingShortfall') else 1
                        for i in event['inputs']}
                service, w3, tx, receipt = verifier_fixture('createGroup', event_specs=[('GroupCreated', {'groupId': 1, 'creator': A, 'name': 'Group', 'targetMembers': 3}), (event['name'], args)])
                result = service.verify_transaction(HASH)['events'][-1]
                self.assertEqual(result['eventName'], event['name'])
                if 'amount' in args:
                    self.assertEqual(result['amountWei'], str(AMOUNT))
                    self.assertEqual(result['args']['amount'], str(AMOUNT))
                if event['name'] == 'PayoutWithdrawn':
                    self.assertEqual((result['wallet'], result['recipient']), (A, A))
                if event['name'] == 'ArrearsRepaid':
                    self.assertEqual((result['wallet'], result['recipient']), (A, A))
                json.dumps(result)


class ServiceSafetyTests(unittest.TestCase):
    def test_lazy_startup_no_rpc_or_mongo(self):
        with patch('blockchain.Web3.HTTPProvider') as provider, patch('database.MongoClient') as client:
            app = create_app({})
            provider.assert_not_called()
            client.assert_not_called()
            response = app.test_client().get('/api/health')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['status'], 'degraded')

    def test_runtime_configuration_allowlist(self):
        content = 'SEPOLIA_RPC_URL="https://example.invalid"\nDEPLOYER_PRIVATE_KEY=not-loaded\nETHERSCAN_API_KEY=not-loaded\nMONGODB_DATABASE=test\n'
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, '.env').write_text(content)
            with patch('api_utils.ROOT', Path(folder)), patch.dict('os.environ', {}, clear=True):
                self.assertEqual(set(runtime_config()), {'SEPOLIA_RPC_URL', 'CHAINROSCA_ADDRESS', 'MONGODB_URI', 'MONGODB_DATABASE'})
                self.assertEqual(runtime_config()['SEPOLIA_RPC_URL'], 'https://example.invalid')

    def test_connection_checks_wrong_address_chain_and_code(self):
        w3 = Mock()
        service = BlockchainService({'CHAINROSCA_ADDRESS': B}, web3=w3)
        with self.assertRaises(APIError) as error:
            service.connection()
        self.assertEqual(error.exception.code, 'CONTRACT_MISMATCH')
        service = BlockchainService({}, web3=w3)
        w3.eth.chain_id = 1
        with self.assertRaises(APIError) as error:
            service.connection()
        self.assertEqual(error.exception.code, 'WRONG_CHAIN')
        w3.eth.chain_id = CHAIN_ID
        w3.eth.get_code.return_value = b''
        with self.assertRaises(APIError) as error:
            service.connection()
        self.assertEqual(error.exception.code, 'RUNTIME_MISMATCH')
        w3.eth.get_code.return_value = b'x' * 13133
        with patch('blockchain.Web3.keccak', return_value=HexBytes(RUNTIME_HASH)):
            service.connection()
        self.assertTrue(service.health()['configured'])

    def test_provider_errors_and_reverts_are_sanitized(self):
        service = BlockchainService({}, web3=Mock())
        service._web3.eth.get_code.side_effect = RuntimeError('https://credential.invalid/private')
        service._web3.eth.chain_id = CHAIN_ID
        with self.assertRaises(APIError) as error:
            service.connection()
        self.assertEqual(error.exception.code, 'RPC_UNAVAILABLE')
        self.assertNotIn('credential', error.exception.message)
        service.connection = Mock(side_effect=ContractLogicError('private'))
        with self.assertRaises(APIError) as error:
            service._call('groupCount')
        self.assertEqual(error.exception.code, 'CONTRACT_REVERT')

    def test_missing_group_checked_against_chain(self):
        service = BlockchainService({})
        contract = Mock()
        contract.functions.groupCount.return_value.call.return_value = 1
        service.connection = Mock(return_value=(Mock(), contract))
        with self.assertRaises(APIError) as error:
            service._call('getMembers', 2)
        self.assertEqual(error.exception.code, 'GROUP_NOT_FOUND')
        contract.functions.getMembers.assert_not_called()

    def test_valid_uninitialized_round_and_missing_member(self):
        service = BlockchainService({})
        service._call = Mock(side_effect=lambda name, *args: {
            'getRoundDetails': (0, '0x' + '00' * 20, 0, 0, 0, 0, 0, 0, 0, 0, 0),
            'getMemberDetails': (False, 0, 0, 0, 0, 0, 0), 'getWithdrawableBalance': 0,
        }[name])
        self.assertEqual(service.round(1, 3)['status'], 'NOT_STARTED')
        self.assertFalse(service.member(1, A)['exists'])

    def test_metadata_tampering_fails_closed(self):
        service = BlockchainService({}, web3=Mock())
        service._metadata['runtimeBytecode']['localKeccak256'] = '0xwrong'
        with self.assertRaises(APIError) as error:
            service.connection()
        self.assertEqual(error.exception.code, 'CONTRACT_MISMATCH')

    def test_uint256_group_history_query_is_bson_safe(self):
        store, db = store_fixture()
        store.history(group_id=2**100)
        self.assertEqual(db.events.last_query['groupId'], str(2**100))

    def test_no_backend_signing_sending_or_secret_configuration(self):
        forbidden = {'transact', 'send_transaction', 'send_raw_transaction', 'sign_transaction', 'from_key'}
        for filename in ('app.py', 'blockchain.py', 'database.py', 'api_utils.py'):
            source = (ROOT / filename).read_text()
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    self.assertNotIn(node.func.attr, forbidden)
            self.assertNotIn('DEPLOYER_PRIVATE_KEY', source)
            self.assertNotIn('ETHERSCAN_API_KEY', source)

    def test_indexes_unique_and_only_two_collections(self):
        store, db = store_fixture()
        self.assertTrue(store.health()['reachable'])
        self.assertIn(([('txHash', 1)], {'unique': True}), db.transactions.indexes)
        self.assertIn(([('txHash', 1), ('logIndex', 1)], {'unique': True}), db.events.indexes)
        count = len(db.events.indexes)
        store.health()
        self.assertEqual(len(db.events.indexes), count)

    def test_duplicate_key_race_retried_as_update(self):
        service, _, _, _ = verifier_fixture()
        result = service.verify_transaction(HASH)
        store, db = store_fixture()
        store.index(result['transaction'], result['events'])
        db.events.duplicate_once = True
        store.index(result['transaction'], result['events'])
        self.assertEqual(len(db.events.documents), 2)

    def test_history_query_and_sort_bound(self):
        store, db = store_fixture()
        db.events.documents = [{'blockNumber': 3, 'logIndex': 1}, {'blockNumber': 4, 'logIndex': 0}, {'blockNumber': 4, 'logIndex': 2}]
        result = store.history(wallet=A, limit=2, before_block=9, event_name='ArrearsRepaid', round_number=1)
        self.assertEqual(result['items'], [{'blockNumber': 4, 'logIndex': 2}, {'blockNumber': 4, 'logIndex': 0}])
        self.assertEqual(db.events.last_query, {'$or': [{'wallet': A}, {'recipient': A}], 'blockNumber': {'$lt': 9}, 'eventName': 'ArrearsRepaid', 'roundNumber': 1})
        store.history(group_id=1)
        self.assertEqual(db.events.last_query, {'groupId': 1})
        self.assertEqual(db.events.projection, {'_id': 0})


if __name__ == '__main__':
    unittest.main()
