'use strict'

// The owner's limit is cumulative across the original run and its one repair
// assessment. An incomplete or uncertain previous ledger cannot free budget.
function remainingAuthorization(manifest, ownerCapCny = 5, ownerRequestCap = 40) {
  if (Array.isArray(manifest)) {
    if (!manifest.length) throw new Error('Previous assessment ledger is missing')
    let spentMicros = 0
    let requests = 0
    for (const item of manifest) {
      const remaining = remainingAuthorization(item, ownerCapCny, ownerRequestCap)
      // Round consumption upwards, never make uncertain fractional spend free.
      spentMicros += Math.ceil(remaining.previousSpentUpperCny * 1e6)
      requests += remaining.previousRequests
    }
    const maxCostCny = (Math.floor(ownerCapCny * 1e6) - spentMicros) / 1e6
    const maxRequests = ownerRequestCap - requests
    if (!(maxCostCny > 0) || !(maxRequests > 0)) throw new Error('Owner assessment authorization is exhausted')
    return { maxCostCny, maxRequests, previousSpentUpperCny: spentMicros / 1e6, previousRequests: requests }
  }
  if (manifest?.model !== 'deepseek-flash' || manifest?.hardCapProtected !== true) throw new Error('Previous assessment identity or cap evidence is missing')
  const budget = manifest.budget
  const spent = manifest.spentUpperCny
  const inflight = manifest.inflightReservedCny
  const requests = budget?.requestsUsed
  if (!Number.isFinite(spent) || spent < 0 || !Number.isFinite(inflight) || inflight !== 0 ||
    !Number.isInteger(requests) || requests < 0 || budget?.spentUpperCny !== spent ||
    budget?.inflightReservedCny !== inflight || budget?.hardCapProtected !== true) throw new Error('Previous assessment has incomplete or inconsistent settled ledger evidence')
  const maxCostCny = Math.floor((ownerCapCny - spent) * 1e6) / 1e6
  const maxRequests = ownerRequestCap - requests
  if (!(maxCostCny > 0) || !(maxRequests > 0)) throw new Error('Owner assessment authorization is exhausted')
  return { maxCostCny, maxRequests, previousSpentUpperCny: spent, previousRequests: requests }
}

module.exports = { remainingAuthorization }
