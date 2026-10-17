(function (root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.ChainROSCAHelpers = helpers;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const CHAIN_ID = 11155111n;
  const ADDRESS = '0xF3cd73c19b49b58dFa743fB3165Aa753e839b422';
  const EXPLORER = 'https://sepolia.etherscan.io';
  const UINT_MAX = (1n << 256n) - 1n;
  const GROUP_PAGE_SIZE = 20;
  const ENUMS = {
    group: ['OPEN', 'ACTIVE', 'COMPLETED', 'CANCELLED'],
    member: ['REGISTERED', 'ACTIVE', 'OUTSTANDING', 'COMPLETED', 'CANCELLED'],
    join: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
    round: ['NOT_STARTED', 'COLLECTING', 'SETTLED'],
  };
  class InputError extends Error {}
  function uint(value, label = 'number', positive = false, maximum = UINT_MAX) {
    const text = String(value).trim();
    if (!/^\d{1,78}$/.test(text)) throw new InputError(`Enter a valid integer ${label}.`);
    const n = BigInt(text);
    if (n < (positive ? 1n : 0n) || n > maximum) throw new InputError(`${label} is outside the supported range.`);
    return n;
  }
  function chainId(value) {
    try {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
      if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(String(value))) return null;
      return BigInt(value);
    } catch (_) { return null; }
  }
  const isSepolia = value => chainId(value) === CHAIN_ID;
  const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  function shortAddress(value) {
    return typeof value === 'string' && value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : String(value || 'Not connected');
  }
  function minutesToSeconds(value) { return uint(value, 'duration in minutes', true, UINT_MAX / 60n) * 60n; }
  function parseAmount(value) {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(text) || text.length > 100) throw new InputError('Enter a positive ETH amount with at most 18 decimal places.');
    const [whole, decimals = ''] = text.split('.');
    const wei = BigInt(whole) * 10n ** 18n + BigInt(decimals.padEnd(18, '0'));
    if (wei <= 0n || wei > UINT_MAX) throw new InputError('ETH amount is outside the supported range.');
    return wei;
  }
  function eth(value) {
    try {
      const wei = BigInt(value);
      const whole = wei / 10n ** 18n;
      const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
      return fraction ? `${whole}.${fraction}` : String(whole);
    } catch (_) { return 'Unavailable'; }
  }
  function createForm(values) {
    const name = String(values.name || '').trim();
    if (!name) throw new InputError('Enter a group name.');
    const target = uint(values.target, 'target members', true, 5n);
    if (target < 3n) throw new InputError('Target members must be 3–5.');
    return { name, target: Number(target), amount: parseAmount(values.amount),
      roundDuration: minutesToSeconds(values.roundMinutes), gracePeriod: minutesToSeconds(values.graceMinutes) };
  }
  function eligibility(s) {
    const g = s.group || {}, m = s.member || {}, r = s.round || {}, record = s.record || {};
    const ready = Boolean(s.wallet) && isSepolia(s.chainId);
    const open = Number(g.status) === 0;
    const creator = ready && sameAddress(s.wallet, g.creator);
    const pending = Number(s.applicantStatus) === 1;
    const collecting = Number(g.status) === 1 && Number(r.status) === 1 && Number(g.currentRound) > 0;
    const funded = collecting && Number(r.contributionCount) === Number(g.targetMembers);
    const chainTimeKnown = s.chainTime !== undefined && s.chainTime !== null;
    const deadlineKnown = r.graceDeadline !== undefined && r.graceDeadline !== null;
    return {
      request: ready && open && !m.exists && Number(g.memberCount) < Number(g.targetMembers) && [0, 3].includes(Number(s.joinStatus)),
      approve: creator && open && pending && Number(g.memberCount) < Number(g.targetMembers),
      reject: creator && open && pending,
      finalApproval: creator && open && pending && Number(g.memberCount) + 1 === Number(g.targetMembers),
      cancel: creator && open,
      contribute: ready && collecting && Boolean(m.exists) && [1, 2].includes(Number(m.status)) && !record.contributed
        && chainTimeKnown && deadlineKnown && BigInt(s.chainTime) <= BigInt(r.graceDeadline),
      settle: ready && collecting && (funded || (chainTimeKnown && deadlineKnown && BigInt(s.chainTime) > BigInt(r.graceDeadline))),
      underfunded: collecting && !funded,
      repay: ready && [1, 2].includes(Number(g.status)) && Boolean(m.exists) && Number(r.status) === 2 && Boolean(record.defaulted) && !record.arrearsRepaid,
      withdraw: ready && BigInt(s.withdrawable || 0) > 0n,
    };
  }
  function groupPage(total, end = null) {
    const top = end === null ? BigInt(total) : BigInt(end) < BigInt(total) ? BigInt(end) : BigInt(total);
    const ids = [];
    for (let id = top; id > 0n && ids.length < GROUP_PAGE_SIZE; id--) ids.push(id);
    return { ids, next: top > BigInt(GROUP_PAGE_SIZE) ? top - BigInt(GROUP_PAGE_SIZE) : 0n };
  }
  function indexingMessage(result) {
    return result && result.onChainStatus === 'confirmed' && result.indexed === true
      ? 'Confirmed and added to history.'
      : 'Transaction confirmed on Sepolia. History indexing is currently unavailable.';
  }
  const REVERTS = new Set(['Group does not exist', 'Creator only', 'Group is not open', 'Already a member', 'Group is full',
    'Request already exists', 'Request is not pending', 'Applicant is zero address', 'Group is not active', 'Not a member',
    'Member cannot contribute', 'Round has not started', 'Round is not collecting', 'Already contributed', 'Incorrect contribution amount',
    'Grace deadline has passed', 'Settlement is not ready', 'Group cannot accept repayment', 'Invalid round number', 'Round is not settled',
    'No default to repay', 'Arrears already repaid', 'Incorrect repayment amount', 'No payout to withdraw', 'Payout transfer failed']);
  function errorMessage(error) {
    if (error instanceof InputError) return error.message;
    const code = error?.code ?? error?.info?.error?.code ?? error?.error?.code;
    if (code === 4001 || code === 'ACTION_REJECTED') return 'Request cancelled in MetaMask.';
    if (code === 4902) return 'Enable or select Sepolia in MetaMask, then try switching again.';
    if (code === -32002) return 'A MetaMask request is already open. Finish it before trying again.';
    if (code === 'INSUFFICIENT_FUNDS') return 'Insufficient Sepolia ETH for the amount and network fee.';
    if (code === 'TRANSACTION_REPLACED') return 'Transaction replaced or cancelled. Check Etherscan before trying again.';
    if (code === 'CALL_EXCEPTION' && REVERTS.has(error.reason)) return `Contract: ${error.reason}.`;
    if (code === 'CALL_EXCEPTION') return 'The contract rejected this action. Refresh live state and check eligibility.';
    return 'Unable to complete the request. Check your connection and refresh. No transaction is automatically retried.';
  }
  function createdGroup(receipt, iface) {
    for (const log of receipt.logs || []) {
      if (!sameAddress(log.address, ADDRESS)) continue;
      try { const event = iface.parseLog(log); if (event?.name === 'GroupCreated') return event.args.groupId; } catch (_) { /* Foreign/unknown event. */ }
    }
    return null;
  }
  async function runTransaction({ send, onStage = () => {}, index = async () => null }) {
    let hash = null;
    try {
      onStage('Awaiting MetaMask');
      const tx = await send();
      hash = tx.hash;
      onStage('Submitted', { hash });
      onStage('Confirming', { hash });
      let receipt;
      try { receipt = await tx.wait(1, 120000); }
      catch (error) {
        if (error.code === 'TRANSACTION_REPLACED' && error.reason === 'repriced' && !error.cancelled && error.receipt) {
          receipt = error.receipt; hash = receipt.hash;
        } else throw error;
      }
      if (!receipt) return { hash, uncertain: true, message: 'Confirmation is pending. Check confirmation before taking another action.' };
      if (Number(receipt.status) !== 1) {
        onStage('Failed', { hash, message: 'Transaction reverted on Sepolia.' });
        return { hash, confirmed: false };
      }
      onStage('Confirmed', { hash });
      let result;
      try { result = await index(hash); } catch (_) { /* Index availability cannot undo chain success. */ }
      return { hash, receipt, confirmed: true, message: indexingMessage(result) };
    } catch (error) {
      const uncertain = Boolean(hash) && !error.receipt && error.code !== 'TRANSACTION_REPLACED';
      const message = uncertain ? 'Confirmation unavailable. Inspect the transaction and check confirmation before another action.' : errorMessage(error);
      onStage(uncertain ? 'Confirming' : 'Failed', { hash, message });
      return { hash, confirmed: false, uncertain, message };
    }
  }
  return Object.freeze({ CHAIN_ID, ADDRESS, EXPLORER, GROUP_PAGE_SIZE, ENUMS, InputError, uint, chainId, isSepolia,
    sameAddress, shortAddress, minutesToSeconds, parseAmount, eth, createForm, eligibility, groupPage,
    indexingMessage, errorMessage, createdGroup, runTransaction });
});
