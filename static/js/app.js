(function () {
  'use strict';
  const H = window.ChainROSCAHelpers;
  const main = document.getElementById('main');
  const status = document.getElementById('app-status');
  if (!H) { status.textContent = 'Application helpers could not load. Refresh to try again.'; return; }
  const state = { ready: false, account: null, chain: null, session: null, epoch: 0, viewEpoch: 0,
    connecting: false, busy: false, unresolved: null, dashboardEnd: null, requestOffset: 0n, abi: null, ethereum: null };
  const fields = {
    group: ['id', 'name', 'creator', 'targetMembers', 'contributionAmount', 'roundDuration', 'gracePeriod', 'currentRound', 'status', 'memberCount'],
    member: ['exists', 'payoutRound', 'status', 'totalContributed', 'totalArrearsRepaid', 'outstandingArrears', 'defaultCount'],
    round: ['number', 'recipient', 'startTime', 'contributionDeadline', 'graceDeadline', 'expectedAmount', 'initiallyCollected', 'recoveredArrears', 'outstandingShortfall', 'contributionCount', 'status'],
    record: ['contributed', 'late', 'defaulted', 'arrearsRepaid', 'contributionTimestamp', 'defaultTimestamp', 'repaymentTimestamp'],
  };
  const unpack = (kind, values) => Object.fromEntries(fields[kind].map((key, i) => [key, values[i]]));
  function node(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'className') element.className = value;
      else if (key === 'disabled' || key === 'hidden' || key === 'noValidate') element[key] = value;
      else element.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return element;
  }
  function announce(message, kind = '') { status.textContent = message; status.className = `notice ${kind}`; }
  const money = value => `${H.eth(value)} ETH`;
  const badge = (kind, code) => { const text = H.ENUMS[kind][Number(code)] || 'UNKNOWN'; return node('span', { className: `badge ${text.toLowerCase()}` }, text); };
  const textBadge = text => node('span', { className: `badge ${text.toLowerCase()}` }, text);
  function date(value) {
    const number = Number(value);
    return number > 0 && number <= 8640000000000 ? new Date(number * 1000).toLocaleString() : 'Not started';
  }
  function details(pairs) { return node('dl', { className: 'details' }, pairs.flatMap(([label, value]) => [node('dt', {}, label), node('dd', {}, value)])); }
  function panel(title, ...children) { return node('section', { className: 'panel' }, node('h2', {}, title), ...children); }
  function intro(title, description) { return node('div', { className: 'view-intro' }, node('p', { className: 'eyebrow' }, 'Trusted savings · Sepolia'), node('h1', {}, title), node('p', { className: 'lead' }, description)); }
  function action(label, callback, enabled = true, extra = '') {
    return node('button', { type: 'button', className: extra, 'data-write': 'true', disabled: state.busy || !enabled, onclick: callback }, label);
  }
  function link(label, href, external = false) { return node('a', external ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href }, label); }
  function txLink(hash) { return /^0x[0-9a-f]{64}$/i.test(hash || '') ? link(H.shortAddress(hash), `${H.EXPLORER}/tx/${hash}`, true) : 'Unavailable'; }
  function updateHeader() {
    const connect = document.getElementById('connect-wallet');
    connect.textContent = state.connecting ? 'Connecting…' : state.account ? H.shortAddress(state.account) : 'Connect MetaMask';
    connect.disabled = !state.ready || state.connecting || state.busy;
    connect.title = state.account || 'Connect MetaMask';
    document.getElementById('copy-address').hidden = !state.account;
    document.getElementById('switch-network').hidden = !state.account || H.isSepolia(state.chain);
    document.getElementById('network-label').textContent = state.account && !H.isSepolia(state.chain) ? 'Wrong Network' : 'Sepolia testnet';
    document.querySelectorAll('[data-write]').forEach(button => { if (state.busy) button.disabled = true; });
  }
  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new H.InputError('The requested service is currently unavailable.');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  const indexTransaction = hash => fetchJSON('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
  function transactionStage(stage, data = {}) {
    document.getElementById('transaction-panel').hidden = false;
    document.getElementById('transaction-stage').textContent = stage;
    document.getElementById('transaction-message').textContent = data.message || (stage === 'Awaiting MetaMask' ? 'Checking live eligibility. Review the operation in MetaMask.' : stage === 'Confirmed' ? 'Transaction confirmed on Sepolia. Updating indexed history…' : 'Do not resubmit while confirmation is pending.');
    if (data.hash) {
      const anchor = document.getElementById('transaction-link');
      anchor.hidden = false; anchor.href = `${H.EXPLORER}/tx/${data.hash}`; anchor.textContent = `View transaction ${H.shortAddress(data.hash)} on Etherscan`;
    }
  }
  async function ensureSession(session) {
    if (!session || session !== state.session || session.epoch !== state.epoch) throw new H.InputError('Wallet changed. Refresh before taking an action.');
    const [chain, accounts] = await Promise.all([state.ethereum.request({ method: 'eth_chainId' }), state.ethereum.request({ method: 'eth_accounts' })]);
    if (!H.isSepolia(chain)) throw new H.InputError('Select Sepolia in MetaMask before taking an action.');
    if (!H.sameAddress(accounts[0], session.address) || session !== state.session) throw new H.InputError('Wallet disconnected or changed. Refresh before taking an action.');
  }
  async function syncWallet(accounts = null) {
    const epoch = ++state.epoch;
    state.viewEpoch++; state.session = null; state.account = null; state.chain = null; state.dashboardEnd = null; state.requestOffset = 0n;
    main.replaceChildren(panel('Wallet state changed', node('p', {}, 'Refreshing account and network. Stale actions have been cleared.')));
    updateHeader();
    try {
      const selected = accounts || await state.ethereum.request({ method: 'eth_accounts' });
      const chain = await state.ethereum.request({ method: 'eth_chainId' });
      if (epoch !== state.epoch) return;
      state.account = selected[0] ? window.ethers.getAddress(selected[0]) : null;
      state.chain = chain; updateHeader();
      if (!state.account) announce('Connect MetaMask to read live groups. No transaction is needed to connect.');
      else if (!H.isSepolia(chain)) announce('Wrong Network. Switch to Sepolia. If unavailable, enable or select Sepolia in MetaMask.', 'warning');
      else {
        const provider = new window.ethers.BrowserProvider(state.ethereum, 'any');
        // The account has already been explicitly authorized. Constructing this
        // signer avoids an implicit second eth_requestAccounts prompt.
        const signer = new window.ethers.JsonRpcSigner(provider, state.account);
        const code = await provider.getCode(H.ADDRESS);
        if (window.ethers.keccak256(code) !== '0xef43d8a6310c47ab4a105c3f3c96c06b576bb17fb2e91ace2104c090bb4461dc') throw new H.InputError('The Sepolia contract runtime does not match the expected deployment.');
        if (epoch !== state.epoch) { provider.destroy(); return; }
        state.session = { provider, signer, contract: new window.ethers.Contract(H.ADDRESS, state.abi, signer), address: state.account, epoch };
        announce('Connected to Sepolia. Displayed financial state is read directly from Ethereum.');
      }
      if (epoch === state.epoch) await renderRoute();
    } catch (error) { if (epoch === state.epoch) { state.session = null; announce(H.errorMessage(error), 'error'); await renderRoute(); } }
    finally { updateHeader(); }
  }
  async function connect() {
    if (!state.ready || state.connecting || state.busy) return;
    if (state.account) { await syncWallet(); return; }
    if (!state.ethereum) { announce('MetaMask is unavailable. Install MetaMask or open this DApp inside the MetaMask mobile browser.', 'warning'); return; }
    state.connecting = true; updateHeader();
    try { await syncWallet(await state.ethereum.request({ method: 'eth_requestAccounts' })); }
    catch (error) { announce(H.errorMessage(error), 'error'); }
    finally { state.connecting = false; updateHeader(); }
  }
  async function readGroup(id, session) {
    const c = session.contract;
    const block = await session.provider.getBlock('latest');
    if (!block) throw new H.InputError('Latest Sepolia block is unavailable. Refresh to try again.');
    const at = { blockTag: block.number };
    const [raw, addresses, mine, joinStatus, withdrawable] = await Promise.all([
      c.getGroupDetails(id, at), c.getMembers(id, at), c.getMemberDetails(id, session.address, at),
      c.getJoinRequestStatus(id, session.address, at), c.getWithdrawableBalance(session.address, at),
    ]);
    const group = unpack('group', raw), member = unpack('member', mine);
    const members = await Promise.all(Array.from(addresses).map(async address => {
      const [detail, balance] = await Promise.all([c.getMemberDetails(id, address, at), c.getWithdrawableBalance(address, at)]);
      return { address, ...unpack('member', detail), withdrawable: balance };
    }));
    const rounds = new Map(), records = new Map();
    // Membership is capped at five. Inspect only this member's bounded rounds.
    if (member.exists) {
      for (let number = 1; number <= Number(group.targetMembers); number++) {
        const [r, record] = await Promise.all([c.getRoundDetails(id, number, at), c.getContributionRecord(id, number, session.address, at)]);
        rounds.set(String(number), unpack('round', r)); records.set(String(number), unpack('record', record));
      }
    }
    const current = String(group.currentRound);
    let round = rounds.get(current) || null;
    if (!round && group.currentRound > 0n) round = unpack('round', await c.getRoundDetails(id, group.currentRound, at));
    const record = records.get(current) || {};
    let requests = null;
    if (H.sameAddress(session.address, group.creator) && Number(group.status) === 0) {
      const total = await c.getJoinRequestCount(id, at);
      const page = await c.getJoinRequestsPage(id, state.requestOffset, 20, at);
      requests = { total, offset: state.requestOffset, items: Array.from(page[0]).map((address, i) => ({ address, status: page[1][i] })) };
    }
    return { id, group, member, members, joinStatus, withdrawable, round, record, rounds, records, requests,
      chainTime: block.timestamp, blockNumber: block.number, wallet: session.address, chainId: H.CHAIN_ID };
  }
  async function sendAction(name, id = null, applicant = null, form = null) {
    if (state.busy || !state.session) return;
    const session = state.session;
    state.busy = true; state.unresolved = null; updateHeader();
    document.getElementById('transaction-link').hidden = true;
    document.getElementById('transaction-title').textContent = name === 'createGroup' ? 'Create group' : name;
    document.getElementById('check-confirmation').hidden = true;
    const result = await H.runTransaction({
      index: indexTransaction, onStage: transactionStage,
      send: async () => {
        await ensureSession(session);
        const c = session.contract;
        if (name === 'createGroup') {
          await ensureSession(session);
          return c.createGroup(form.name, form.target, form.amount, form.roundDuration, form.gracePeriod);
        }
        if (name === 'withdrawPayout') {
          const amount = await c.getWithdrawableBalance(session.address);
          if (!H.eligibility({ wallet: session.address, chainId: H.CHAIN_ID, withdrawable: amount }).withdraw) throw new H.InputError('No payout is currently available.');
          if (!window.confirm(`Withdraw your entire global allocation of ${money(amount)}?`)) throw new H.InputError('Withdrawal cancelled.');
          await ensureSession(session); return c.withdrawPayout();
        }
        const fresh = await readGroup(id, session);
        let applicantStatus;
        if (applicant && ['approveJoinRequest', 'rejectJoinRequest'].includes(name)) applicantStatus = await c.getJoinRequestStatus(id, applicant);
        const allowed = H.eligibility({ ...fresh, applicantStatus });
        const keys = { requestJoin: 'request', approveJoinRequest: 'approve', rejectJoinRequest: 'reject', cancelGroup: 'cancel', contribute: 'contribute', settleRound: 'settle' };
        if (name !== 'repayArrears' && !allowed[keys[name]]) throw new H.InputError('This action is no longer eligible. Refresh the group.');
        if (name === 'approveJoinRequest' && allowed.finalApproval && !window.confirm('Approving this member will fill the group, activate it immediately, and start Round 1. Membership and payout order cannot be changed afterward.')) throw new H.InputError('Final approval cancelled.');
        if (name === 'cancelGroup' && !window.confirm('Cancel this OPEN group? Its registered members will become CANCELLED.')) throw new H.InputError('Cancellation cancelled.');
        if (name === 'settleRound' && allowed.underfunded && !window.confirm('Missing contributions will be recorded as defaults and the round will settle with the amount actually collected.')) throw new H.InputError('Settlement cancelled.');
        if (name === 'contribute' && !window.confirm(`Contribute exactly ${money(fresh.group.contributionAmount)} to Round ${fresh.group.currentRound}?`)) throw new H.InputError('Contribution cancelled.');
        if (name === 'repayArrears') {
          const round = fresh.rounds.get(String(applicant)), record = fresh.records.get(String(applicant));
          if (!H.eligibility({ ...fresh, round, record }).repay) throw new H.InputError('This historical arrear is no longer repayable.');
          if (!window.confirm(`Repay exactly ${money(fresh.group.contributionAmount)} for Round ${applicant}, allocated to its original recipient ${round.recipient}?`)) throw new H.InputError('Repayment cancelled.');
        }
        await ensureSession(session);
        if (name === 'requestJoin') return c.requestJoin(id);
        if (name === 'approveJoinRequest') return c.approveJoinRequest(id, applicant);
        if (name === 'rejectJoinRequest') return c.rejectJoinRequest(id, applicant);
        if (name === 'cancelGroup') return c.cancelGroup(id);
        if (name === 'contribute') return c.contribute(id, { value: fresh.group.contributionAmount });
        if (name === 'settleRound') return c.settleRound(id);
        if (name === 'repayArrears') return c.repayArrears(id, applicant, { value: fresh.group.contributionAmount });
        throw new H.InputError('Unsupported action.');
      },
    });
    if (result.message) document.getElementById('transaction-message').textContent = result.message;
    if (result.uncertain) {
      state.unresolved = { hash: result.hash, name, session };
      document.getElementById('check-confirmation').hidden = false;
      return; // Writes remain locked until this hash is reconciled.
    }
    state.busy = false; updateHeader();
    if (result.confirmed && name === 'createGroup') {
      const createdId = H.createdGroup(result.receipt, session.contract.interface);
      if (createdId !== null && state.session === session) { window.location.hash = `#/group/${createdId}`; return; }
    }
    await renderRoute();
  }
  async function checkConfirmation() {
    const pending = state.unresolved;
    if (!pending) return;
    const button = document.getElementById('check-confirmation'); button.disabled = true;
    try {
      if (!H.isSepolia(await state.ethereum.request({ method: 'eth_chainId' }))) throw new H.InputError('Switch to Sepolia to check this transaction.');
      const provider = new window.ethers.BrowserProvider(state.ethereum, 'any');
      const receipt = await provider.getTransactionReceipt(pending.hash);
      provider.destroy();
      if (!receipt) { document.getElementById('transaction-message').textContent = 'No mined receipt yet. Keep this hash and inspect Etherscan; do not resubmit.'; return; }
      if (Number(receipt.status) === 1) {
        transactionStage('Confirmed', { hash: pending.hash });
        let result; try { result = await indexTransaction(pending.hash); } catch (_) { /* Chain success stands. */ }
        document.getElementById('transaction-message').textContent = H.indexingMessage(result);
        if (pending.name === 'createGroup') {
          const id = H.createdGroup(receipt, pending.session.contract.interface);
          if (id !== null) window.location.hash = `#/group/${id}`;
        }
      } else transactionStage('Failed', { hash: pending.hash, message: 'Transaction reverted on Sepolia.' });
      state.unresolved = null; state.busy = false; button.hidden = true; updateHeader(); await renderRoute();
    } catch (error) { document.getElementById('transaction-message').textContent = H.errorMessage(error); }
    finally { button.disabled = false; }
  }
  function disconnected(view) {
    return [intro(view, 'Live financial state is read through your wallet on Ethereum Sepolia.'), panel('Connect on Sepolia', node('p', {}, state.account ? 'Switch to Sepolia to load this view. Writes are disabled on other networks.' : 'Connect MetaMask to continue. On mobile, open the DApp inside the MetaMask mobile browser.'), node('p', {}, 'Connection does not send a transaction. Your wallet keeps control of signing.'))];
  }
  function groupCard(item) {
    const g = item.group;
    const allowed = H.eligibility({ wallet: state.account, chainId: state.chain, group: g, member: item.member, joinStatus: item.joinStatus });
    return node('article', { className: 'group-card' }, node('div', { className: 'section-heading' }, node('span', { className: 'muted' }, `Group #${g.id}`), badge('group', g.status)),
      node('h3', {}, g.name), details([['Members', `${g.memberCount} / ${g.targetMembers}`], ['Contribution', money(g.contributionAmount)], ['Creator', H.shortAddress(g.creator)], ['Current round', g.currentRound > 0n ? g.currentRound : 'Not started']]),
      !item.member.exists ? node('p', {}, 'Join request: ', badge('join', item.joinStatus)) : null,
      node('div', { className: 'actions' }, node('a', { href: `#/group/${g.id}`, className: 'button' }, 'View group'), allowed.request ? action('Request Join', () => sendAction('requestJoin', g.id)) : null));
  }
  async function dashboard(session) {
    const c = session.contract, block = await session.provider.getBlock('latest'), at = { blockTag: block.number };
    const [count, balance, withdrawable] = await Promise.all([c.groupCount(at), session.provider.getBalance(session.address, block.number), c.getWithdrawableBalance(session.address, at)]);
    const page = H.groupPage(count, state.dashboardEnd);
    const items = await Promise.all(page.ids.map(async id => {
      const [g, m, joinStatus] = await Promise.all([c.getGroupDetails(id, at), c.getMemberDetails(id, session.address, at), c.getJoinRequestStatus(id, session.address, at)]);
      return { group: unpack('group', g), member: unpack('member', m), joinStatus };
    }));
    const mine = items.filter(item => item.member.exists), available = items.filter(item => !item.member.exists && Number(item.group.status) === 0);
    const lookup = node('form', { className: 'inline-form', onsubmit: event => {
      event.preventDefault(); try { const id = H.uint(event.currentTarget.elements.groupId.value, 'group ID', true); window.location.hash = `#/group/${id}`; } catch (error) { announce(H.errorMessage(error), 'error'); }
    } }, node('div', { className: 'field' }, node('label', { for: 'group-id' }, 'Open group by ID'), node('input', { id: 'group-id', name: 'groupId', inputmode: 'numeric', placeholder: 'Group ID', required: 'required' })), node('button', { type: 'submit' }, 'Open group'));
    const metric = (label, value) => node('div', { className: 'metric' }, node('span', { className: 'label' }, label), node('span', { className: 'value' }, value));
    return [intro('Your savings, in order.', 'Create a trusted group, follow a fixed payout order, and keep every obligation visible.'),
      node('p', { className: 'address' }, `Wallet ${session.address}`),
      node('div', { className: 'metrics' }, metric('Wallet balance · Sepolia ETH', money(balance)), metric('Global payout available', money(withdrawable)), metric('My groups on this page', mine.length)),
      panel('Payouts', node('p', {}, 'Payouts are allocated on-chain first and withdrawn separately. This balance combines all your groups.'), action(`Withdraw Payout · ${money(withdrawable)}`, () => sendAction('withdrawPayout'), withdrawable > 0n)),
      panel('Find a group', lookup),
      node('h2', {}, 'My Groups'), node('p', { className: 'muted' }, 'Groups on this discovery page only. Use Group ID lookup for older personal groups.'),
      mine.length ? node('div', { className: 'cards' }, mine.map(groupCard)) : node('p', { className: 'empty' }, 'No memberships found on this page.'),
      node('h2', {}, 'Available / Open Groups'), available.length ? node('div', { className: 'cards' }, available.map(groupCard)) : node('p', { className: 'empty' }, 'No open groups available on this page.'),
      node('p', { className: 'muted' }, `Inspected ${page.ids.length} of ${count} groups at block ${block.number}. Discovery never reads more than 20 groups per page.`),
      node('div', { className: 'actions' }, node('button', { disabled: page.next === 0n, onclick: () => { state.dashboardEnd = page.next; renderRoute(); } }, 'Load Older'), node('button', { onclick: () => { state.dashboardEnd = null; renderRoute(); } }, 'Latest groups'))];
  }
  function createView() {
    const field = (label, id, attrs = {}) => node('div', { className: 'field' }, node('label', { for: id }, label), node('input', { id, name: id, required: 'required', ...attrs }));
    const form = node('form', { className: 'form', noValidate: true, onsubmit: event => {
      event.preventDefault(); if (state.busy) return;
      try { const values = H.createForm(Object.fromEntries(new FormData(event.currentTarget))); sendAction('createGroup', null, null, values); }
      catch (error) { announce(H.errorMessage(error), 'error'); }
    } }, node('div', { className: 'form-grid' },
      field('Group name', 'name', { autocomplete: 'off', placeholder: 'Your trusted savings circle' }),
      node('div', { className: 'field' }, node('label', { for: 'target' }, 'Target members'), node('select', { id: 'target', name: 'target' }, [3, 4, 5].map(v => node('option', { value: v }, `${v} members`)))),
      field('Contribution per member, per round (ETH)', 'amount', { inputmode: 'decimal', placeholder: '0.0001' }),
      field('Round duration (integer minutes)', 'roundMinutes', { inputmode: 'numeric', value: '60' }),
      field('Grace period (integer minutes)', 'graceMinutes', { inputmode: 'numeric', value: '10' })),
      node('p', { className: 'notice warning' }, 'ChainROSCA is designed for trusted savings groups. Blockchain rules do not guarantee that members will make future contributions.'),
      node('p', {}, 'You become Member 1 and receive payout order 1. Creation collects no ETH; your wallet will pay the network fee. Final member approval activates the group automatically.'),
      node('button', { type: 'submit', className: 'primary', 'data-write': 'true', disabled: state.busy }, 'Create Group in MetaMask'));
    return [intro('Create a savings group', 'Choose fixed terms together before anyone joins.'), panel('Group terms', form)];
  }
  function memberCard(m) {
    return node('article', { className: 'list-item' }, node('div', { className: 'section-heading' }, node('h3', {}, `Payout order ${m.payoutRound}`), badge('member', m.status)), node('p', { className: 'address' }, m.address),
      details([['Total contributed', money(m.totalContributed)], ['Arrears repaid', money(m.totalArrearsRepaid)], ['Outstanding arrears', money(m.outstandingArrears)], ['Historical defaults', m.defaultCount], ['Global withdrawable payout', money(m.withdrawable)]]));
  }
  async function groupView(id, session) {
    const s = await readGroup(id, session), g = s.group, r = s.round, m = s.member, a = H.eligibility(s);
    const summary = panel(g.name, badge('group', g.status), details([['Group ID', g.id], ['Creator', node('span', { className: 'address' }, g.creator)], ['Members', `${g.memberCount} / ${g.targetMembers}`], ['Contribution per round', money(g.contributionAmount)], ['Round duration', `${g.roundDuration} seconds`], ['Grace period', `${g.gracePeriod} seconds`], ['Current round', g.currentRound > 0n ? g.currentRound : 'Not started']]),
      node('div', { className: 'actions' }, a.request ? action('Request Join', () => sendAction('requestJoin', id), true, 'primary') : null, a.cancel ? action('Cancel Group', () => sendAction('cancelGroup', id), true, 'danger') : null));
    const user = panel('Your position', details([['Membership', m.exists ? 'Member' : 'Not a member'], ['Member status', m.exists ? badge('member', m.status) : 'Not registered'], ['Payout round', m.exists ? m.payoutRound : '—'], ['Join request', badge('join', s.joinStatus)], ['Outstanding arrears', money(m.outstandingArrears)], ['Global payout available', money(s.withdrawable)]]),
      node('p', {}, 'Payouts are allocated on-chain first and withdrawn separately. A completed group may still have an unwithdrawn allocation.'),
      action(`Withdraw Payout · ${money(s.withdrawable)}`, () => sendAction('withdrawPayout'), a.withdraw),
      m.exists && g.currentRound > 0n ? node('div', {}, node('h3', {}, 'Current-round contribution record'), details([
        ['Contributed', s.record.contributed ? 'Yes' : 'No'], ['Late contribution', s.record.late ? 'Yes' : 'No'],
        ['Historical default', s.record.defaulted ? 'Yes · permanently recorded' : 'No'], ['Arrears repaid', s.record.arrearsRepaid ? 'Yes' : 'No'],
        ['Contribution time (local)', s.record.contributionTimestamp > 0n ? date(s.record.contributionTimestamp) : '—'],
        ['Default time (local)', s.record.defaultTimestamp > 0n ? date(s.record.defaultTimestamp) : '—'],
        ['Repayment time (local)', s.record.repaymentTimestamp > 0n ? date(s.record.repaymentTimestamp) : '—'],
      ])) : null);
    const roundPanel = r ? panel(`Current round · ${g.currentRound}`, badge('round', r.status), details([
      ['Recipient', node('span', { className: 'address' }, r.recipient)], ['Expected pot', money(r.expectedAmount)], ['Initially collected', money(r.initiallyCollected)], ['Recovered arrears', money(r.recoveredArrears)], ['Outstanding shortfall', money(r.outstandingShortfall)], ['Contribution count', `${r.contributionCount} / ${g.targetMembers}`], ['Start time (local)', date(r.startTime)], ['Contribution deadline (local)', date(r.contributionDeadline)], ['Grace deadline (local)', date(r.graceDeadline)],
      ['Your current contribution', m.exists ? s.record.contributed ? s.record.late ? 'Paid late' : 'Paid on time' : 'Not paid' : 'Not a member'],
    ]), node('p', { className: 'muted' }, `Eligibility uses Sepolia block ${s.blockNumber}, chain timestamp ${s.chainTime} (${date(s.chainTime)}). Refresh to update; the contract makes the final decision.`),
      a.contribute ? node('p', {}, `Exact payment: ${money(g.contributionAmount)}. ${BigInt(s.chainTime) > r.contributionDeadline ? 'This contribution will be recorded as late.' : 'On-time at the displayed chain timestamp.'}`) : null,
      a.underfunded && a.settle ? node('p', { className: 'notice warning' }, 'Missing contributions will be recorded as defaults and the round will settle with the amount actually collected.') : null,
      node('div', { className: 'actions' }, action(`Contribute · ${money(g.contributionAmount)}`, () => sendAction('contribute', id), a.contribute, 'primary'), action('Settle Round', () => sendAction('settleRound', id), a.settle))) : panel('Round timing', node('p', {}, 'Rounds have not started. The final required approval starts Round 1 in the same transaction.'));
    const arrears = [];
    for (const [number, round] of s.rounds) {
      if (H.eligibility({ ...s, round, record: s.records.get(number) }).repay) arrears.push(node('article', { className: 'list-item' }, node('h3', {}, `Round ${number}`), details([['Original recipient', node('span', { className: 'address' }, round.recipient)], ['Exact repayment', money(g.contributionAmount)]]), action(`Repay Arrears · ${money(g.contributionAmount)}`, () => sendAction('repayArrears', id, BigInt(number)))));
    }
    let requests = null;
    if (s.requests) {
      const page = s.requests;
      const items = page.items.map(item => {
        const options = H.eligibility({ ...s, applicantStatus: item.status });
        return node('article', { className: 'list-item' }, node('p', { className: 'address' }, item.address), badge('join', item.status), Number(item.status) === 1 ? node('div', { className: 'actions' },
          action(options.finalApproval ? 'Approve & activate group' : 'Approve', () => sendAction('approveJoinRequest', id, item.address), options.approve), action('Reject', () => sendAction('rejectJoinRequest', id, item.address), options.reject, 'danger')) : null);
      });
      requests = panel('Join requests · creator controls', node('p', { className: 'muted' }, `${page.total} distinct applicants. Showing at most 20 from offset ${page.offset}. Approval order becomes payout order.`),
        node('div', { className: 'list' }, items.length ? items : node('p', { className: 'empty' }, 'No applicants on this page.')),
        node('div', { className: 'actions' }, node('button', { disabled: page.offset === 0n, onclick: () => { state.requestOffset = page.offset >= 20n ? page.offset - 20n : 0n; renderRoute(); } }, 'Previous applicants'), node('button', { disabled: page.offset + 20n >= page.total, onclick: () => { state.requestOffset = page.offset + 20n; renderRoute(); } }, 'Next applicants')));
    }
    const history = await historyPanel(`/api/groups/${id}/history`);
    return [intro(`Group #${id}`, 'Fixed terms. Ordered payouts. Financial state read directly from Sepolia.'), node('div', { className: 'grid' }, summary, user), roundPanel,
      panel('Members · exact payout order', node('div', { className: 'list' }, s.members.map(memberCard))), requests,
      panel('Your historical arrears', arrears.length ? node('div', { className: 'list' }, arrears) : node('p', { className: 'muted' }, 'No settled, unpaid historical arrears for this wallet. Defaults remain recorded after repayment.')), history];
  }
  async function historyPanel(url, beforeBlock = null) {
    const section = panel('Indexed history', node('p', { className: 'muted' }, 'History may be incomplete; Ethereum is the source of truth.'));
    try {
      const query = `?limit=50${beforeBlock !== null ? `&beforeBlock=${beforeBlock}` : ''}`;
      const result = await fetchJSON(url + query);
      if (result.source !== 'mongodb-index' || !Array.isArray(result.items)) throw new Error('Invalid indexed history');
      if (!result.items.length) section.append(node('p', { className: 'empty' }, 'No indexed events on this page. Confirmed transactions are indexed only when submitted to the backend.'));
      const list = node('div', { className: 'list' });
      for (const event of result.items) list.append(node('article', { className: 'list-item history-event' }, node('h3', {}, event.eventName), details([
        ['Group / round', `${event.groupId ?? 'Global'} / ${event.roundNumber ?? '—'}`], ['Wallet / member', event.wallet ? node('span', { className: 'address' }, event.wallet) : '—'], ['Recipient', event.recipient ? node('span', { className: 'address' }, event.recipient) : '—'], ['Amount', event.amountWei !== null && event.amountWei !== undefined ? money(event.amountWei) : '—'], ['Block', event.blockNumber], ['Time (local)', date(event.blockTimestamp)], ['Transaction', txLink(event.txHash)],
      ])));
      section.append(list);
      if (result.items.length === 50) {
        const oldest = Math.min(...result.items.map(item => Number(item.blockNumber)));
        section.append(node('p', { className: 'muted' }, 'Older loads events before the last displayed block. Block-boundary pagination can omit additional events in that block.'),
          node('button', { onclick: async event => { event.currentTarget.disabled = true; const next = await historyPanel(url, oldest); if (section.isConnected) section.replaceWith(next); } }, 'Older indexed events'));
      }
    } catch (_) { section.append(node('p', { className: 'notice warning' }, 'Indexed history is currently unavailable.')); }
    return section;
  }
  async function renderRoute() {
    const token = ++state.viewEpoch, session = state.session;
    const hash = window.location.hash || '#/dashboard';
    const match = /^#\/group\/(\d+)$/.exec(hash);
    const view = match ? 'group' : hash === '#/create' ? 'create' : hash === '#/history' ? 'history' : 'dashboard';
    document.querySelectorAll('[data-view]').forEach(anchor => { if (anchor.dataset.view === (view === 'group' ? 'dashboard' : view)) anchor.setAttribute('aria-current', 'page'); else anchor.removeAttribute('aria-current'); });
    if (!state.ready) return;
    if (!session) { main.replaceChildren(...disconnected(view === 'group' ? 'Group details' : view === 'create' ? 'Create Group' : view === 'history' ? 'Wallet History' : 'Dashboard')); return; }
    main.replaceChildren(panel('Loading live state…', node('p', {}, 'Reading Sepolia through MetaMask.')));
    try {
      let content;
      if (view === 'group') content = await groupView(H.uint(match[1], 'group ID', true), session);
      else if (view === 'create') content = createView();
      else if (view === 'history') content = [intro('Wallet History', 'Supplementary indexed events for your wallet, including allocations received.'), await historyPanel(`/api/wallet/${session.address}/history`)];
      else content = await dashboard(session);
      if (token === state.viewEpoch && session === state.session) { main.replaceChildren(...content.filter(Boolean)); updateHeader(); }
    } catch (error) {
      if (token === state.viewEpoch && session === state.session) main.replaceChildren(panel('Live state unavailable', node('p', { className: 'notice error' }, H.errorMessage(error)), node('p', {}, 'Check the Group ID and network, then use Refresh. Indexed history never replaces live financial state.')));
    }
  }
  async function init() {
    document.getElementById('skip-to-content').addEventListener('click', event => { event.preventDefault(); main.focus(); });
    document.getElementById('connect-wallet').addEventListener('click', connect);
    document.getElementById('refresh').addEventListener('click', () => { if (!state.ready) window.location.reload(); else if (state.account && !state.busy) syncWallet(); else renderRoute(); });
    document.getElementById('copy-address').addEventListener('click', async () => { try { if (state.account) { await navigator.clipboard.writeText(state.account); announce('Wallet address copied.'); } } catch (_) { announce('Copy unavailable. Select the wallet address shown on the dashboard.'); } });
    document.getElementById('switch-network').addEventListener('click', async () => { try { await state.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] }); await syncWallet(); } catch (error) { announce(H.errorMessage(error), 'warning'); } });
    document.getElementById('check-confirmation').addEventListener('click', checkConfirmation);
    window.addEventListener('hashchange', () => { state.requestOffset = 0n; renderRoute(); });
    try {
      if (!window.ethers || window.ethers.version !== '6.17.0') throw new H.InputError('Ethers.js 6.17.0 could not load. Check CDN access and refresh. Wallet actions are unavailable.');
      const config = await fetchJSON('/api/config');
      if (config.network !== 'sepolia' || !H.isSepolia(config.chainId) || !H.sameAddress(config.contractAddress, H.ADDRESS) || config.abiUrl !== '/static/abi/ChainROSCA.json') throw new H.InputError('Public contract configuration does not match the approved Sepolia deployment.');
      state.abi = await fetchJSON('/static/abi/ChainROSCA.json');
      if (!Array.isArray(state.abi)) throw new H.InputError('The canonical contract ABI is unavailable.');
      new window.ethers.Interface(state.abi);
      state.ethereum = window.ethereum?.providers?.find(provider => provider.isMetaMask) || window.ethereum;
      state.ready = true;
      if (state.ethereum) {
        state.ethereum.on?.('accountsChanged', accounts => { if (state.account || state.connecting) syncWallet(accounts); });
        state.ethereum.on?.('chainChanged', () => { if (state.account || state.connecting) syncWallet(); });
        announce('Connect MetaMask to read live Sepolia groups. Connection does not send a transaction.');
      } else announce('MetaMask is unavailable. Install MetaMask or open this DApp inside the MetaMask mobile browser.', 'warning');
      updateHeader(); await renderRoute();
    } catch (error) { announce(H.errorMessage(error), 'error'); main.replaceChildren(panel('Unable to start', node('p', {}, 'Wallet actions remain disabled. Use Refresh after restoring access to configuration, ABI, and the pinned Ethers library.'))); updateHeader(); }
  }
  init();
})();
