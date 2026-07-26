// Synthetic order stream, seeded. Fraud is generated from a different signal
// distribution than good traffic rather than by flipping a label on random rows —
// otherwise no model could separate them and the whole demo would be a lie.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = [
  { id: 'M-4401', name: 'Verdance Outfitters', vertical: 'Apparel & outdoor', avgOrder: 168 },
  { id: 'M-4402', name: 'Pinnacle Audio', vertical: 'Consumer electronics', avgOrder: 640 },
  { id: 'M-4403', name: 'Halcott Home', vertical: 'Home goods', avgOrder: 240 },
  { id: 'M-4404', name: 'Cobalt Supply Co', vertical: 'Industrial B2B', avgOrder: 1180 },
  { id: 'M-4405', name: 'Studio Ferrand', vertical: 'Luxury accessories', avgOrder: 890 },
];

const CITIES = [
  ['Portland, OR', 'US'], ['Austin, TX', 'US'], ['Columbus, OH', 'US'], ['Sacramento, CA', 'US'],
  ['Tampa, FL', 'US'], ['Providence, RI', 'US'], ['Boise, ID', 'US'], ['Charlotte, NC', 'US'],
];

const pick = (rng, a) => a[Math.floor(rng() * a.length)];
const gauss = (rng, mu, sd) => {
  const u = Math.max(1e-9, rng()), v = rng();
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export function generateOrders(n = 1200, seed = 424242, fraudRate = 0.034) {
  const rng = mulberry32(seed);
  const out = [];

  for (let i = 0; i < n; i++) {
    const merchant = pick(rng, MERCHANTS);
    const isFraud = rng() < fraudRate;
    const [city, country] = pick(rng, CITIES);

    // Real books are not separable. Two populations create the overlap that
    // makes thresholding a genuine trade-off rather than a formality:
    //   - sophisticated fraud: aged/purchased accounts, residential proxies,
    //     ordinary baskets. It deliberately looks like good traffic.
    //   - risky-looking good customers: travelling, shipping a gift to a new
    //     address, expediting a present. Declining them is the expensive error.
    const sophisticated = isFraud && rng() < 0.35;
    const riskyGood = !isFraud && rng() < 0.11;

    // `sig` scales how far a signal departs from the benign baseline.
    const sig = isFraud ? (sophisticated ? 0.38 : 1) : (riskyGood ? 0.5 : 0);
    const mix = (benign, hostile) => benign + (hostile - benign) * sig;

    // Good traffic: established identities, local IPs, ordinary baskets.
    // Fraud: fresh identities, distance between IP and billing, resale-heavy
    // baskets, expedited shipping, velocity across the consortium.
    const o = {
      id: `ORD-${(720000 + i)}`,
      merchant: merchant.name,
      merchantId: merchant.id,
      vertical: merchant.vertical,
      city, country,
      ts: new Date(Date.UTC(2026, 6, 24, 3 + Math.floor(rng() * 20), Math.floor(rng() * 60))).toISOString(),
      actuallyFraud: isFraud,

      amount: Math.max(24, Math.round(gauss(rng, merchant.avgOrder * mix(1.0, 1.75), merchant.avgOrder * 0.45))),
      basketZ: Math.abs(gauss(rng, mix(0.25, 1.6), mix(0.6, 1.1))),

      emailAgeDays: Math.max(0, Math.round(Math.abs(gauss(rng, mix(900, 22), mix(620, 40))))),
      accountAgeDays: Math.max(0, Math.round(Math.abs(gauss(rng, mix(640, 9), mix(520, 24))))),
      priorGoodOrders: Math.max(0, Math.round(Math.abs(gauss(rng, mix(7, 0.3), mix(8, 1))))),

      billShipMismatch: rng() < mix(0.14, 0.72),
      freightForwarder: rng() < mix(0.012, 0.28),
      addressEdits: Math.round(Math.abs(gauss(rng, mix(0.35, 1.6), 1))),
      newShipAddress: rng() < mix(0.22, 0.81),
      shipHighRisk: rng() < mix(0.02, 0.19),
      avs: rng() < mix(0.07, 0.42) ? 'N' : rng() < 0.12 ? 'Z' : 'Y',
      cvv: rng() < mix(0.03, 0.3) ? 'N' : 'M',

      proxy: rng() < mix(0.035, 0.44),
      datacenterAsn: rng() < mix(0.014, 0.31),
      ipDistanceKm: Math.round(Math.abs(gauss(rng, mix(42, 3100), mix(90, 2400)))),
      ipCountryMismatch: rng() < mix(0.015, 0.36),
      accountsOnDevice: 1 + Math.max(0, Math.round(Math.abs(gauss(rng, mix(0.08, 2.6), mix(0.3, 2))))),
      localeMismatch: rng() < mix(0.03, 0.33),
      tzMismatch: rng() < mix(0.05, 0.4),

      resaleRatio: Math.min(1, Math.abs(gauss(rng, mix(0.15, 0.66), mix(0.18, 0.28)))),
      expedited: rng() < mix(0.19, 0.68),
      singleSkuQty: rng() < mix(0.04, 0.34) ? 5 + Math.floor(rng() * 8) : 1 + Math.floor(rng() * 3),
      giftCard: rng() < mix(0.04, 0.22),

      cardVelocity: 1 + Math.max(0, Math.round(Math.abs(gauss(rng, mix(0.1, 4.2), mix(0.4, 3))))),
      emailVelocity: 1 + Math.max(0, Math.round(Math.abs(gauss(rng, mix(0.09, 3.6), mix(0.4, 2.6))))),
      priorChargeback: rng() < mix(0.004, 0.16),
      // A purchased aged account can carry consortium trust it has not earned.
      networkTrusted: sophisticated ? rng() < 0.18 : (!isFraud && rng() < 0.38),
      profile: isFraud ? (sophisticated ? 'sophisticated fraud' : 'opportunistic fraud') : (riskyGood ? 'atypical good customer' : 'ordinary good customer'),
    };
    out.push(o);
  }
  return out;
}

export { MERCHANTS };
