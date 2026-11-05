function refusal(code, detail) {
  const err = new Error(`[trade] ${code}: ${detail}`)
  err.reasonCode = code
  return err
}

function readWallet(value, name) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) throw refusal('trade-unknown-target', `${name} needs a non-empty string id`)
  if (!value.items || typeof value.items !== 'object' || Array.isArray(value.items)) throw refusal('trade-invalid-wallet', `${name}.items must be an object`)
  if (!Number.isFinite(value.currency) || value.currency < 0) throw refusal('trade-invalid-wallet', `${name}.currency must be a non-negative finite number`)
  const items = {}
  for (const [item, count] of Object.entries(value.items)) {
    if (!Number.isInteger(count) || count < 0) throw refusal('trade-invalid-wallet', `${name}.items.${item} must be a non-negative integer`)
    if (count > 0) items[item] = count
  }
  return { id: value.id, items, currency: value.currency }
}

function readSide(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal('trade-invalid-side', `${name} must be an object`)
  const items = {}
  for (const [item, count] of Object.entries(value.items || {})) {
    if (!Number.isInteger(count) || count < 0) throw refusal('trade-invalid-quantity', `${name}.items.${item} must be a non-negative integer`)
    if (count > 0) items[item] = count
  }
  const currency = value.currency ?? 0
  if (!Number.isFinite(currency) || currency < 0) throw refusal('trade-invalid-quantity', `${name}.currency must be a non-negative finite number`)
  return { items, currency }
}

function holds(wallet, side) {
  for (const [item, count] of Object.entries(side.items)) {
    if ((wallet.items[item] || 0) < count) throw refusal('trade-not-held', `${wallet.id} does not hold ${count} of ${item}`)
  }
  if (wallet.currency < side.currency) throw refusal('trade-not-held', `${wallet.id} does not hold ${side.currency} currency`)
}

function apply(wallet, debit, credit) {
  const items = { ...wallet.items }
  for (const [item, count] of Object.entries(debit.items)) {
    const next = items[item] - count
    if (next === 0) delete items[item]
    else items[item] = next
  }
  for (const [item, count] of Object.entries(credit.items)) items[item] = (items[item] || 0) + count
  return { id: wallet.id, items, currency: wallet.currency - debit.currency + credit.currency }
}

export function settleTrade({ proposer, responder, offer, request, withdrawn = false } = {}) {
  const a = readWallet(proposer, 'proposer')
  const b = readWallet(responder, 'responder')
  if (a.id === b.id) throw refusal('trade-same-party', 'a player cannot trade with themselves')
  if (withdrawn) throw refusal('trade-withdrawn', 'the offer was withdrawn before settlement')
  const give = readSide(offer, 'offer')
  const want = readSide(request, 'request')
  holds(a, give)
  holds(b, want)
  return {
    ok: true,
    proposer: apply(a, give, want),
    responder: apply(b, want, give),
  }
}

export function createTradeBook(getWallet, commit) {
  if (typeof getWallet !== 'function' || typeof commit !== 'function') throw refusal('trade-invalid-hooks', 'getWallet and commit must be functions')
  const trades = new Map()
  const find = (id) => {
    const trade = trades.get(String(id))
    if (!trade) throw refusal('trade-unknown-trade', `no trade named ${id}`)
    return trade
  }
  return {
    offer({ id, proposerId, responderId, offer, request }) {
      if (typeof id !== 'string' || !id) throw refusal('trade-invalid-id', 'id must be a non-empty string')
      if (trades.has(id)) throw refusal('trade-duplicate', `trade ${id} already exists`)
      if (proposerId === responderId) throw refusal('trade-same-party', 'a player cannot trade with themselves')
      readSide(offer, 'offer')
      readSide(request, 'request')
      trades.set(id, { id, proposerId, responderId, offer, request, accepted: new Set(), settled: false, withdrawn: false })
      return { ok: true, id }
    },
    accept({ id, by }) {
      const trade = find(id)
      if (trade.settled) throw refusal('trade-already-settled', `trade ${id} is settled`)
      if (trade.withdrawn) throw refusal('trade-withdrawn', `trade ${id} was withdrawn`)
      if (by !== trade.proposerId && by !== trade.responderId) throw refusal('trade-not-a-party', `${by} is not a party to trade ${id}`)
      if (trade.accepted.has(by)) throw refusal('trade-duplicate-accept', `${by} already accepted trade ${id}`)
      trade.accepted.add(by)
      if (trade.accepted.size < 2) return { ok: true, settled: false, waitingFor: by === trade.proposerId ? trade.responderId : trade.proposerId }
      let result
      try {
        result = settleTrade({
          proposer: getWallet(trade.proposerId),
          responder: getWallet(trade.responderId),
          offer: trade.offer,
          request: trade.request,
        })
        commit(result)
      } catch (err) {
        trade.accepted.delete(by)
        throw err
      }
      trade.settled = true
      return { ok: true, settled: true, result }
    },
    withdraw({ id, by }) {
      const trade = find(id)
      if (trade.settled) throw refusal('trade-already-settled', `trade ${id} is settled`)
      if (by !== trade.proposerId && by !== trade.responderId) throw refusal('trade-not-a-party', `${by} is not a party to trade ${id}`)
      trade.withdrawn = true
      return { ok: true, withdrawn: true }
    },
    status(id) {
      const trade = find(id)
      return { id, accepted: [...trade.accepted], settled: trade.settled, withdrawn: trade.withdrawn }
    },
  }
}
