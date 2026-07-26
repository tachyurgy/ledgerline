// Chained fraud decisioning.
//
// Three specialist sub-models each score one family of signals; their outputs
// become features of a consortium model alongside the raw order signals. That
// chaining is what lets a specialist trained on address manipulation contribute
// to a decision without the top-level model having to learn addresses from scratch.
//
// Everything here is plain logistic regression in log-odds space, which has the
// useful property that each feature's contribution to the decision is just
// weight * value — so the explanation is exact rather than an approximation.

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(p / (1 - p));

// --------------------------------------------------------------- sub-model: address manipulation
const ADDRESS_W = {
  bias: -2.6,
  billShipMismatch: 1.35,
  shipToFreightForwarder: 2.1,
  addressNormalizationEdits: 0.42,   // per edit the normalizer had to make
  newAddressForAccount: 0.78,
  shipCountryHighRisk: 1.15,
  avsFail: 1.05,
};

export function addressModel(o) {
  const f = {
    billShipMismatch: o.billShipMismatch ? 1 : 0,
    shipToFreightForwarder: o.freightForwarder ? 1 : 0,
    addressNormalizationEdits: Math.min(o.addressEdits, 4),
    newAddressForAccount: o.newShipAddress ? 1 : 0,
    shipCountryHighRisk: o.shipHighRisk ? 1 : 0,
    avsFail: o.avs === 'N' ? 1 : o.avs === 'Z' ? 0.5 : 0,
  };
  return score(f, ADDRESS_W);
}

// --------------------------------------------------------------- sub-model: IP / device risk
const IP_W = {
  bias: -2.9,
  proxyOrVpn: 1.9,
  datacenterAsn: 1.55,
  ipBillingDistanceKm: 0.00042,   // per km
  ipCountryMismatch: 1.2,
  deviceReuseAcrossAccounts: 0.55, // per additional account on the device
  browserLocaleMismatch: 0.62,
  tzOffsetMismatch: 0.48,
};

export function ipModel(o) {
  const f = {
    proxyOrVpn: o.proxy ? 1 : 0,
    datacenterAsn: o.datacenterAsn ? 1 : 0,
    ipBillingDistanceKm: Math.min(o.ipDistanceKm, 9000),
    ipCountryMismatch: o.ipCountryMismatch ? 1 : 0,
    deviceReuseAcrossAccounts: Math.max(0, o.accountsOnDevice - 1),
    browserLocaleMismatch: o.localeMismatch ? 1 : 0,
    tzOffsetMismatch: o.tzMismatch ? 1 : 0,
  };
  return score(f, IP_W);
}

// --------------------------------------------------------------- sub-model: SKU / basket risk
const SKU_W = {
  bias: -3.1,
  highResaleRatio: 2.2,      // share of basket that is easily fenced
  expeditedShipping: 0.85,
  basketZScore: 0.34,        // how unusual the order value is for this merchant
  singleSkuBulk: 1.1,
  giftCardPresent: 1.45,
};

export function skuModel(o) {
  const f = {
    highResaleRatio: o.resaleRatio,
    expeditedShipping: o.expedited ? 1 : 0,
    basketZScore: Math.max(0, o.basketZ),
    singleSkuBulk: o.singleSkuQty >= 5 ? 1 : 0,
    giftCardPresent: o.giftCard ? 1 : 0,
  };
  return score(f, SKU_W);
}

// --------------------------------------------------------------- consortium model
// Consumes the three specialist scores plus signals that only make sense at the
// network level — an email or card seen across many merchants is a consortium
// observation no single merchant can make on their own.
const CONSORTIUM_W = {
  bias: -3.4,
  addressRisk: 1.5,
  ipRisk: 1.65,
  skuRisk: 1.25,
  emailAgeDays: -0.0042,          // older email, lower risk
  accountAgeDays: -0.0031,
  cardVelocity24h: 0.44,          // distinct merchants this card hit in 24h
  emailVelocity24h: 0.38,
  cvvFail: 1.3,
  priorChargebackOnEntity: 2.4,
  priorGoodOrders: -0.085,
  networkTrustedEmail: -1.8,      // consortium says this identity is known-good
};

export function consortiumModel(o, subs) {
  const f = {
    addressRisk: subs.address.p,
    ipRisk: subs.ip.p,
    skuRisk: subs.sku.p,
    emailAgeDays: Math.min(o.emailAgeDays, 2200),
    accountAgeDays: Math.min(o.accountAgeDays, 2200),
    cardVelocity24h: Math.min(o.cardVelocity, 12),
    emailVelocity24h: Math.min(o.emailVelocity, 12),
    cvvFail: o.cvv === 'N' ? 1 : 0,
    priorChargebackOnEntity: o.priorChargeback ? 1 : 0,
    priorGoodOrders: Math.min(o.priorGoodOrders, 40),
    networkTrustedEmail: o.networkTrusted ? 1 : 0,
  };
  return score(f, CONSORTIUM_W);
}

// Shared scorer: returns probability plus exact per-feature log-odds contribution.
function score(features, weights) {
  let z = weights.bias;
  const contributions = [];
  for (const [k, v] of Object.entries(features)) {
    const c = (weights[k] || 0) * v;
    z += c;
    if (Math.abs(c) > 1e-9) contributions.push({ feature: k, value: v, weight: weights[k], contribution: c });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { z, p: sigmoid(z), contributions, bias: weights.bias };
}

export function decide(order, policy) {
  const subs = {
    address: addressModel(order),
    ip: ipModel(order),
    sku: skuModel(order),
  };
  const top = consortiumModel(order, subs);

  // Expected loss if approved = P(fraud) * order value (we carry the liability).
  // Expected loss if declined = P(good) * order value * margin (revenue forgone).
  const expectedFraudLoss = top.p * order.amount;
  const expectedDeclineLoss = (1 - top.p) * order.amount * policy.margin;

  let decision;
  if (top.p >= policy.declineAt) decision = 'DECLINE';
  else if (top.p >= policy.reviewAt) decision = 'REVIEW';
  else decision = 'APPROVE';

  // A guarantee is only offered where we are willing to eat the chargeback.
  const guaranteed = decision === 'APPROVE' && top.p < policy.guaranteeAt;

  return { subs, top, decision, guaranteed, expectedFraudLoss, expectedDeclineLoss };
}

// --------------------------------------------------------------- portfolio economics
export function evaluatePolicy(orders, policy) {
  let approved = 0, declined = 0, review = 0;
  let gmvApproved = 0, gmvDeclined = 0;
  let fraudApproved = 0, fraudLoss = 0;
  let goodDeclined = 0, revenueLost = 0;
  let guaranteedCount = 0, guaranteedLoss = 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const o of orders) {
    const r = decide(o, policy);
    const isFraud = o.actuallyFraud;

    if (r.decision === 'DECLINE') {
      declined++; gmvDeclined += o.amount;
      if (isFraud) tp++; else { fp++; goodDeclined++; revenueLost += o.amount * policy.margin; }
    } else if (r.decision === 'REVIEW') {
      // Held for a human. The standard modelling assumption is that review
      // resolves correctly — the cost of the queue is the analyst time and the
      // customer friction, both priced in `reviewCostEach`, not missed fraud.
      review++;
      if (isFraud) tp++; else tn++;
    } else {
      approved++; gmvApproved += o.amount;
      if (isFraud) { fn++; fraudApproved++; fraudLoss += o.amount; if (r.guaranteed) { guaranteedLoss += o.amount; } }
      else tn++;
      if (r.guaranteed) guaranteedCount++;
    }
  }

  const reviewCost = review * policy.reviewCostEach;
  const netMargin = gmvApproved * policy.margin - fraudLoss - reviewCost - revenueLost;

  return {
    approved, declined, review, gmvApproved, gmvDeclined,
    fraudApproved, fraudLoss, goodDeclined, revenueLost,
    guaranteedCount, guaranteedLoss, reviewCost, netMargin,
    approvalRate: orders.length ? approved / orders.length : 0,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    tp, fp, tn, fn,
  };
}
