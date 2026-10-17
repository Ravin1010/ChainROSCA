'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ethers = require('ethers');
const H = require('../static/js/helpers.js');
const A = '0x4A779fA7d5eA106f1aDFB8369e65fCAA465ca7Fd';
const B = '0x89620988E487A85872FFE74fCb1aBeFE6EC3a163';
const HASH = '0x' + '12'.repeat(32);
const base = () => ({ wallet: A, chainId: '0xaa36a7', group: { creator: A, status: 0n, targetMembers: 3n, memberCount: 1n, currentRound: 0n }, member: { exists: false }, joinStatus: 0n, applicantStatus: 1n });
const collecting = () => ({ ...base(), group: { ...base().group, status: 1n, currentRound: 1n }, member: { exists: true, status: 1n }, round: { status: 1n, contributionCount: 1n, graceDeadline: 200n }, record: { contributed: false }, chainTime: 150n });

test('recognizes Sepolia chain IDs in hex, decimal and bigint form', () => {
  for (const id of ['0xaa36a7', '0xAA36A7', 11155111, 11155111n, '11155111']) assert.equal(H.isSepolia(id), true);
});
test('rejects wrong or malformed chains', () => {
  for (const id of [1, '0x1', null, undefined, 'not-a-chain', -1, 1.2]) assert.equal(H.isSepolia(id), false);
});
test('shortens addresses without losing copy source', () => { assert.equal(H.shortAddress(A), '0x4A77…a7Fd'); assert.equal(H.shortAddress(null), 'Not connected'); });
test('converts positive integer minutes without floating point', () => { assert.equal(H.minutesToSeconds('60'), 3600n); assert.equal(H.minutesToSeconds(' 1 '), 60n); });
test('rejects zero, negative, fractional, exponent and overflowing durations', () => {
  for (const value of ['0', '-1', '1.5', '1e3', '', String(1n << 256n)]) assert.throws(() => H.minutesToSeconds(value), H.InputError);
});
test('create target must be an integer in 3–5', () => {
  const values = { name: 'Group', amount: '0.1', roundMinutes: '60', graceMinutes: '10' };
  for (const target of [3, 4, 5]) assert.equal(H.createForm({ ...values, target }).target, target);
  for (const target of [2, 6, '3.5', 'bad']) assert.throws(() => H.createForm({ ...values, target }));
});
test('parses exact ETH amounts down to one wei', () => { assert.equal(H.parseAmount('0.000000000000000001'), 1n); assert.equal(H.parseAmount('1.25'), 1250000000000000000n); });
test('rejects empty, zero, malformed, negative, excessive precision or overflow ETH', () => {
  for (const value of ['', '0', '0.0', '-1', '1e2', 'hello', '1.0000000000000000001', '9'.repeat(100)]) assert.throws(() => H.parseAmount(value));
});
test('validates create form and trims the name', () => {
  assert.deepEqual(H.createForm({ name: ' Circle ', target: '3', amount: '0.0001', roundMinutes: '60', graceMinutes: '10' }), { name: 'Circle', target: 3, amount: 100000000000000n, roundDuration: 3600n, gracePeriod: 600n });
  assert.throws(() => H.createForm({ name: '  ' }));
});
test('formats wei exactly without JS precision loss', () => { assert.equal(H.eth(1000000000000000000000001n), '1000000.000000000000000001'); assert.equal(H.eth(0n), '0'); assert.equal(H.eth('bad'), 'Unavailable'); });
test('requestJoin permits NONE/REJECTED nonmembers only with capacity', () => {
  for (const joinStatus of [0, 3]) assert.equal(H.eligibility({ ...base(), joinStatus }).request, true);
  for (const joinStatus of [1, 2]) assert.equal(H.eligibility({ ...base(), joinStatus }).request, false);
  assert.equal(H.eligibility({ ...base(), member: { exists: true } }).request, false);
  assert.equal(H.eligibility({ ...base(), group: { ...base().group, memberCount: 3 } }).request, false);
});
test('approve/reject require creator, OPEN group and pending applicant', () => {
  assert.equal(H.eligibility(base()).approve, true); assert.equal(H.eligibility(base()).reject, true);
  for (const s of [{ ...base(), wallet: B }, { ...base(), applicantStatus: 3 }, { ...base(), group: { ...base().group, status: 1 } }]) {
    assert.equal(H.eligibility(s).approve, false); assert.equal(H.eligibility(s).reject, false);
  }
});
test('detects only the final required approval', () => { assert.equal(H.eligibility(base()).finalApproval, false); assert.equal(H.eligibility({ ...base(), group: { ...base().group, memberCount: 2 } }).finalApproval, true); });
test('cancellation is creator-only before activation', () => { assert.equal(H.eligibility(base()).cancel, true); assert.equal(H.eligibility({ ...base(), wallet: B }).cancel, false); assert.equal(H.eligibility(collecting()).cancel, false); });
test('eligible ACTIVE/OUTSTANDING members can contribute at grace exactly', () => {
  const s = { ...collecting(), chainTime: 200n };
  assert.equal(H.eligibility(s).contribute, true);
  assert.equal(H.eligibility({ ...s, member: { exists: true, status: 2 } }).contribute, true);
});
test('contribution is blocked after grace, without chain time, after payment or for outsider', () => {
  for (const patch of [{ chainTime: 201n }, { chainTime: null }, { record: { contributed: true } }, { member: { exists: false } }, { member: { exists: true, status: 3 } }]) assert.equal(H.eligibility({ ...collecting(), ...patch }).contribute, false);
});
test('fully funded settlement is permissionless and need not await deadline', () => { assert.equal(H.eligibility({ ...collecting(), wallet: B, member: { exists: false }, round: { ...collecting().round, contributionCount: 3n } }).settle, true); });
test('underfunded settlement requires strictly after grace', () => { assert.equal(H.eligibility({ ...collecting(), chainTime: 200n }).settle, false); assert.equal(H.eligibility({ ...collecting(), chainTime: 201n }).settle, true); });
test('SETTLED and COMPLETED rounds reject further financial collection/settlement', () => {
  for (const patch of [{ round: { ...collecting().round, status: 2 } }, { group: { ...collecting().group, status: 2 } }, { group: { ...collecting().group, status: 3 } }]) {
    const result = H.eligibility({ ...collecting(), ...patch }); assert.equal(result.contribute, false); assert.equal(result.settle, false);
  }
});
test('arrears repayment requires own unrepaid historical default in SETTLED round', () => {
  const s = { ...collecting(), round: { status: 2 }, record: { defaulted: true, arrearsRepaid: false } };
  assert.equal(H.eligibility(s).repay, true);
  for (const patch of [{ member: { exists: false } }, { record: { defaulted: false } }, { record: { defaulted: true, arrearsRepaid: true } }, { round: { status: 1 } }]) assert.equal(H.eligibility({ ...s, ...patch }).repay, false);
});
test('withdraw remains available with arrears or after group completion', () => { assert.equal(H.eligibility({ ...collecting(), withdrawable: 1n, group: { status: 2 } }).withdraw, true); assert.equal(H.eligibility({ ...base(), withdrawable: 0 }).withdraw, false); });
test('all writes are disabled without wallet or on a wrong chain', () => {
  for (const patch of [{ wallet: null }, { chainId: 1 }]) for (const key of ['request', 'approve', 'reject', 'cancel', 'contribute', 'settle', 'repay', 'withdraw']) assert.equal(H.eligibility({ ...collecting(), withdrawable: 2n, ...patch })[key], false);
});
test('safe error normalization covers rejection, funds and allowlisted contract reasons', () => {
  assert.match(H.errorMessage({ code: 4001 }), /cancelled/);
  assert.match(H.errorMessage({ code: 'ACTION_REJECTED' }), /cancelled/);
  assert.match(H.errorMessage({ code: 'INSUFFICIENT_FUNDS' }), /Insufficient/);
  assert.match(H.errorMessage({ code: 'CALL_EXCEPTION', reason: 'Already contributed' }), /Already contributed/);
  assert.doesNotMatch(H.errorMessage({ code: 'CALL_EXCEPTION', reason: 'https://private.invalid/token' }), /private/);
  assert.doesNotMatch(H.errorMessage(new Error('https://private.invalid/token')), /private/);
});
test('indexing messages never turn chain success into failure', () => {
  assert.equal(H.indexingMessage({ onChainStatus: 'confirmed', indexed: true }), 'Confirmed and added to history.');
  for (const result of [null, { onChainStatus: 'confirmed', indexed: false }, { onChainStatus: 'pending', indexed: false }]) assert.match(H.indexingMessage(result), /Transaction confirmed on Sepolia/);
});
test('group discovery replaces bounded 20-ID pages, including huge IDs', () => {
  assert.deepEqual(H.groupPage(3n), { ids: [3n, 2n, 1n], next: 0n });
  const page = H.groupPage((1n << 128n) + 3n); assert.equal(page.ids.length, 20); assert.equal(page.ids[0] - page.ids[19], 19n);
  assert.equal(H.groupPage(100n, 80n).ids[0], 80n);
});
test('no persistent financial cache or backend credential/provider path exists', () => {
  const source = fs.readFileSync(require.resolve('../static/js/app.js'), 'utf8') + fs.readFileSync(require.resolve('../static/js/helpers.js'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|SEPOLIA_RPC_URL|MONGODB_URI|DEPLOYER_PRIVATE_KEY|new\s+.*(?:Wallet|JsonRpcProvider)\s*\(/);
  assert.equal(Object.keys(H).some(key => /cache|storage/i.test(key)), false);
});
test('GroupCreated receipt parsing ignores unrelated logs and never infers latest count', () => {
  const iface = new ethers.Interface(require('../static/abi/ChainROSCA.json'));
  const event = iface.encodeEventLog(iface.getEvent('GroupCreated'), [7n, A, 'Circle', 3]);
  assert.equal(H.createdGroup({ logs: [{ address: B, ...event }, { address: H.ADDRESS, ...event }] }, iface), 7n);
  assert.equal(H.createdGroup({ logs: [{ address: B, ...event }] }, iface), null);
});
test('transaction runner emits stages once, then indexes only the hash', async () => {
  const stages = [], hashes = []; let sends = 0;
  const result = await H.runTransaction({ send: async () => { sends++; return { hash: HASH, wait: async () => ({ hash: HASH, status: 1 }) }; }, onStage: stage => stages.push(stage), index: async hash => { hashes.push(hash); return { onChainStatus: 'confirmed', indexed: true }; } });
  assert.deepEqual(stages, ['Awaiting MetaMask', 'Submitted', 'Confirming', 'Confirmed']); assert.deepEqual(hashes, [HASH]); assert.equal(sends, 1); assert.equal(result.confirmed, true);
});
test('index fetch failure preserves Confirmed stage', async () => {
  const stages = [];
  const result = await H.runTransaction({ send: async () => ({ hash: HASH, wait: async () => ({ status: 1 }) }), onStage: stage => stages.push(stage), index: async () => { throw new Error('offline'); } });
  assert.equal(result.confirmed, true); assert.equal(stages.at(-1), 'Confirmed'); assert.match(result.message, /History indexing is currently unavailable/);
});
test('reverted receipt fails without indexing or resubmission', async () => {
  let indexed = false;
  const result = await H.runTransaction({ send: async () => ({ hash: HASH, wait: async () => ({ status: 0 }) }), index: async () => { indexed = true; } });
  assert.equal(result.confirmed, false); assert.equal(indexed, false);
});
test('rejected wallet request does not retry', async () => {
  let sends = 0;
  const result = await H.runTransaction({ send: async () => { sends++; throw { code: 'ACTION_REJECTED' }; } });
  assert.equal(sends, 1); assert.equal(result.uncertain, false); assert.match(result.message, /cancelled/);
});
test('uncertain submitted transaction preserves hash and cannot masquerade as a revert', async () => {
  let sends = 0;
  const result = await H.runTransaction({ send: async () => { sends++; return { hash: HASH, wait: async () => { throw new Error('offline'); } }; } });
  assert.equal(sends, 1); assert.equal(result.hash, HASH); assert.equal(result.uncertain, true);
});
test('repriced successful transaction indexes its actual receipt hash', async () => {
  const replacement = '0x' + '34'.repeat(32); let indexed;
  const result = await H.runTransaction({ send: async () => ({ hash: HASH, wait: async () => { throw { code: 'TRANSACTION_REPLACED', reason: 'repriced', cancelled: false, receipt: { hash: replacement, status: 1 } }; } }), index: async hash => { indexed = hash; } });
  assert.equal(result.confirmed, true); assert.equal(indexed, replacement);
});

// Minimal offline DOM harness: exercises app wiring without a browser package,
// CDN, injected wallet, live provider, or transaction submission.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this._text = ''; }
  append(...children) { this.children.push(...children); for (const c of children) c.parent = this; }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, callback) { (this.listeners[k] ||= []).push(callback); }
  async fire(k) { for (const callback of this.listeners[k] || []) await callback({ preventDefault() {}, currentTarget: this }); }
}
function harness({ chain = '0xaa36a7', missingLibrary = false, groupRoute = false, groupOpen = false, confirmResult = false, contractOverrides = {} } = {}) {
  const ids = Object.fromEntries(['skip-to-content', 'main', 'app-status', 'connect-wallet', 'copy-address', 'switch-network', 'network-label', 'transaction-panel', 'transaction-stage', 'transaction-message', 'transaction-title', 'transaction-link', 'check-confirmation', 'refresh'].map(id => [id, new Element()]));
  const requests = [], walletEvents = {}, windowEvents = {}, confirms = [], writes = [], fetches = [];
  let accounts = [A];
  const walk = () => { const all = []; const visit = n => { all.push(n); n.children.forEach(visit); }; Object.values(ids).forEach(visit); return all; };
  const document = { getElementById: id => ids[id], createElement: tag => new Element(tag), createTextNode: text => { const n = new Element('text'); n.textContent = text; return n; }, querySelectorAll: selector => walk().filter(n => selector === '[data-write]' ? n.attrs['data-write'] : n.attrs['data-view']) };
  const contract = {
    interface: new ethers.Interface(require('../static/abi/ChainROSCA.json')),
    groupCount: async () => 1n,
    getGroupDetails: async () => [1n, '<script>untrusted name</script>', A, 3n, 100000000000000n, 3600n, 600n, groupOpen ? 0n : 1n, groupOpen ? 0n : 1n, groupOpen ? 2n : 3n],
    getMemberDetails: async () => [true, 1n, groupOpen ? 0n : 1n, 0n, 0n, 0n, 0n],
    getJoinRequestStatus: async (_id, address) => address === B ? 1n : 0n,
    getWithdrawableBalance: async () => 0n,
    getMembers: async () => groupOpen ? [A] : [A, B, A],
    getRoundDetails: async () => [1n, A, 100n, 3700n, 4300n, 300000000000000n, 0n, 0n, 0n, 0n, 1n],
    getContributionRecord: async () => [false, false, false, false, 0n, 0n, 0n],
    getJoinRequestCount: async () => 1n,
    getJoinRequestsPage: async () => [[B], [1n]],
    approveJoinRequest: async () => { writes.push('approve'); return { hash: HASH, wait: async () => ({ status: 1 }) }; },
  };
  Object.assign(contract, contractOverrides);
  class Provider { async getCode() { return '0x'; } async getBlock() { return { number: 99, timestamp: 200 }; } async getBalance() { return 1n; } destroy() {} }
  const ethereum = { request: async request => { requests.push(request); if (request.method === 'eth_chainId') return chain; if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return accounts; if (request.method === 'wallet_switchEthereumChain') chain = '0xaa36a7'; }, on: (event, fn) => { walletEvents[event] = fn; } };
  const window = { ChainROSCAHelpers: H, ethereum, ethers: missingLibrary ? undefined : { ...ethers, BrowserProvider: Provider, JsonRpcSigner: class {}, Contract: class { constructor() { return contract; } }, keccak256: () => '0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc' }, location: { hash: groupRoute ? '#/group/1' : '#/dashboard', reload() {} }, addEventListener: (event, fn) => { windowEvents[event] = fn; }, confirm: message => { confirms.push(message); return confirmResult; } };
  const fetch = async (url, options = {}) => { fetches.push({ url, options }); return { ok: !url.includes('history'), json: async () => url === '/api/config' ? { network: 'sepolia', chainId: 11155111, contractAddress: H.ADDRESS, abiUrl: '/static/abi/ChainROSCA.json' } : url === '/api/transactions' ? { onChainStatus: 'confirmed', indexed: true } : require('../static/abi/ChainROSCA.json') }; };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/js/app.js'), 'utf8'), { window, document, Node: Element, navigator: { clipboard: { writeText: async () => {} } }, fetch, AbortController, setTimeout, clearTimeout, FormData, console });
  return { ids, requests, confirms, writes, fetches, walletEvents, windowEvents, window, walk, changeChain: next => { chain = next; walletEvents.chainChanged(next); }, disconnect: () => { accounts = []; walletEvents.accountsChanged([]); } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
test('app startup does not request wallet access and library failure is visible', async () => {
  const app = harness(); await flush(); assert.equal(app.requests.length, 0); assert.match(app.ids['main'].textContent, /Connect/);
  const broken = harness({ missingLibrary: true }); await flush(); assert.match(broken.ids['app-status'].textContent, /Ethers.js 6.17.0 could not load/); assert.equal(broken.requests.length, 0);
});
test('user connect loads direct reads and disconnect clears stale group controls', async () => {
  const app = harness(); await flush(); await app.ids['connect-wallet'].fire('click');
  assert.equal(app.requests.filter(r => r.method === 'eth_requestAccounts').length, 1);
  assert.match(app.ids.main.textContent, /My Groups/);
  app.disconnect(); assert.doesNotMatch(app.ids.main.textContent, /My Groups/); await flush();
  assert.match(app.ids.main.textContent, /Connect MetaMask/);
});
test('wrong chain disables live group actions and offers only chain switching', async () => {
  const app = harness({ chain: '0x1' }); await flush(); await app.ids['connect-wallet'].fire('click');
  assert.equal(app.ids['network-label'].textContent, 'Wrong Network'); assert.equal(app.ids['switch-network'].hidden, false);
  assert.doesNotMatch(app.ids.main.textContent, /My Groups/);
  await app.ids['switch-network'].fire('click');
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests.find(r => r.method === 'wallet_switchEthereumChain').params)), [{ chainId: '0xaa36a7' }]);
  assert.equal(app.requests.some(r => r.method === 'wallet_addEthereumChain'), false);
});
test('history outage does not fail live group view and group names remain text', async () => {
  const app = harness({ groupRoute: true }); await flush(); await app.ids['connect-wallet'].fire('click');
  assert.match(app.ids.main.textContent, /Current round/); assert.match(app.ids.main.textContent, /Indexed history is currently unavailable/);
  assert.match(app.ids.main.textContent, /<script>untrusted name<\/script>/);
  assert.equal(app.walk().filter(n => n.tag === 'script').length, 0);
});
test('final approval requires explicit confirmation before any wallet write', async () => {
  const app = harness({ groupRoute: true, groupOpen: true }); await flush(); await app.ids['connect-wallet'].fire('click');
  const button = app.walk().find(n => n.tag === 'button' && n.textContent === 'Approve & activate group');
  assert.ok(button); await button.fire('click');
  assert.match(app.confirms[0], /activate it immediately, and start Round 1/);
  assert.equal(app.writes.length, 0);
});

test('duplicate write clicks are locked while confirmation is pending', async () => {
  let resolveReceipt, sends = 0;
  const app = harness({ groupRoute: true, confirmResult: true, contractOverrides: {
    contribute: async () => { sends++; return { hash: HASH, wait: () => new Promise(resolve => { resolveReceipt = resolve; }) }; },
  } });
  await flush(); await app.ids['connect-wallet'].fire('click');
  const button = app.walk().find(n => n.tag === 'button' && n.textContent.startsWith('Contribute ·'));
  assert.ok(button); const first = button.fire('click'); await flush();
  await button.fire('click'); assert.equal(sends, 1); assert.equal(button.disabled, true);
  resolveReceipt({ hash: HASH, status: 1 }); await first;
  assert.equal(app.ids['transaction-stage'].textContent, 'Confirmed');
  assert.match(app.ids['transaction-message'].textContent, /Confirmed and added to history/);
  const handoff = app.fetches.find(item => item.url === '/api/transactions');
  assert.deepEqual(JSON.parse(handoff.options.body), { txHash: HASH });
});
test('network-change event clears prior account/group action state without requesting accounts again', async () => {
  const app = harness({ groupRoute: true }); await flush(); await app.ids['connect-wallet'].fire('click');
  app.changeChain('0x1');
  assert.match(app.ids.main.textContent, /Stale actions have been cleared/);
  await flush(); assert.equal(app.requests.filter(r => r.method === 'eth_requestAccounts').length, 1);
  assert.equal(app.ids['network-label'].textContent, 'Wrong Network');
  assert.doesNotMatch(app.ids.main.textContent, /Current round/);
});

test('real Ethers BrowserProvider/JsonRpcSigner reads use injected provider without requesting accounts', async () => {
  const requests = [];
  const provider = new ethers.BrowserProvider({ request: async request => {
    requests.push(request.method);
    if (request.method === 'eth_chainId') return '0xaa36a7';
    if (request.method === 'eth_call') return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]);
    throw new Error('Unexpected RPC method');
  } });
  try {
    const signer = new ethers.JsonRpcSigner(provider, A);
    const contract = new ethers.Contract(H.ADDRESS, require('../static/abi/ChainROSCA.json'), signer);
    assert.equal(await signer.getAddress(), A);
    assert.equal(await contract.groupCount(), 1n);
    assert.equal(requests.includes('eth_requestAccounts'), false);
    assert.equal(requests.some(method => /send|sign/i.test(method)), false);
  } finally { provider.destroy(); }
});
