import { generateOrders } from './orders.js';
import { decide, evaluatePolicy } from './model.js';

const $ = (s) => document.querySelector(s);
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const moneyK = (n) => (Math.abs(n) >= 1000 ? (n < 0 ? '-$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k' : money(n));
const pct = (n) => (n * 100).toFixed(1) + '%';

const ORDERS = generateOrders(1200);
let policy = { reviewAt: 0.20, declineAt: 0.62, guaranteeAt: 0.08, margin: 0.34, reviewCostEach: 4.25 };
let selected = null;
let filter = 'all';

const FEATURE_LABELS = {
  billShipMismatch: 'Billing ≠ shipping address',
  shipToFreightForwarder: 'Ships to known freight forwarder',
  addressNormalizationEdits: 'Address normalizer edits',
  newAddressForAccount: 'Address new to this account',
  shipCountryHighRisk: 'High-risk destination country',
  avsFail: 'AVS mismatch',
  proxyOrVpn: 'Proxy / VPN detected',
  datacenterAsn: 'Datacenter ASN',
  ipBillingDistanceKm: 'IP-to-billing distance',
  ipCountryMismatch: 'IP country ≠ billing country',
  deviceReuseAcrossAccounts: 'Device shared across accounts',
  browserLocaleMismatch: 'Browser locale mismatch',
  tzOffsetMismatch: 'Timezone offset mismatch',
  highResaleRatio: 'Resale-liquid basket share',
  expeditedShipping: 'Expedited shipping',
  basketZScore: 'Basket value vs merchant norm',
  singleSkuBulk: 'Bulk single-SKU quantity',
  giftCardPresent: 'Gift card in basket',
  addressRisk: 'Address sub-model',
  ipRisk: 'IP / device sub-model',
  skuRisk: 'Basket sub-model',
  emailAgeDays: 'Email age',
  accountAgeDays: 'Account age',
  cardVelocity24h: 'Card velocity, 24h consortium',
  emailVelocity24h: 'Email velocity, 24h consortium',
  cvvFail: 'CVV mismatch',
  priorChargebackOnEntity: 'Prior chargeback on identity',
  priorGoodOrders: 'Prior good orders',
  networkTrustedEmail: 'Consortium-trusted identity',
};

// ---------------------------------------------------------------- metrics
function renderMetrics() {
  const e = evaluatePolicy(ORDERS, policy);
  const tiles = [
    { k: 'Approval rate', v: pct(e.approvalRate), sub: `${e.approved} of ${ORDERS.length}`, cls: e.approvalRate > 0.9 ? 'good' : 'warn' },
    { k: 'Fraud caught', v: pct(e.recall), sub: `${e.tp} of ${e.tp + e.fn} fraud orders`, cls: e.recall > 0.8 ? 'good' : 'bad' },
    { k: 'Precision', v: pct(e.precision), sub: `${e.fp} good orders declined`, cls: e.precision > 0.5 ? 'good' : 'bad' },
    { k: 'Fraud loss', v: moneyK(e.fraudLoss), sub: `${e.fraudApproved} approved fraud`, cls: 'bad' },
    { k: 'False-decline cost', v: moneyK(e.revenueLost), sub: 'margin forgone', cls: 'warn' },
    { k: 'Net margin', v: moneyK(e.netMargin), sub: `after ${moneyK(e.reviewCost)} review cost`, cls: e.netMargin > 0 ? 'good' : 'bad' },
  ];
  $('#metrics').innerHTML = tiles
    .map((t) => `<div class="metric ${t.cls}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sub">${t.sub}</div></div>`)
    .join('');
}

// ---------------------------------------------------------------- policy sliders
function renderPolicy() {
  $('#policy').innerHTML = `
    <label class="fld">Review threshold
      <input type="range" id="pReview" min="0.02" max="0.6" step="0.01" value="${policy.reviewAt}">
      <span class="mono" style="color:var(--ink);font-size:12px">P(fraud) ≥ ${pct(policy.reviewAt)}</span>
    </label>
    <label class="fld">Decline threshold
      <input type="range" id="pDecline" min="0.1" max="0.95" step="0.01" value="${policy.declineAt}">
      <span class="mono" style="color:var(--ink);font-size:12px">P(fraud) ≥ ${pct(policy.declineAt)}</span>
    </label>
    <label class="fld">Guarantee ceiling
      <input type="range" id="pGuar" min="0.01" max="0.4" step="0.005" value="${policy.guaranteeAt}">
      <span class="mono" style="color:var(--ink);font-size:12px">P(fraud) &lt; ${pct(policy.guaranteeAt)}</span>
    </label>
    <label class="fld">Contribution margin
      <input type="range" id="pMargin" min="0.05" max="0.7" step="0.01" value="${policy.margin}">
      <span class="mono" style="color:var(--ink);font-size:12px">${pct(policy.margin)}</span>
    </label>`;

  const b = (id, k) => $(id).addEventListener('input', (e) => {
    policy[k] = parseFloat(e.target.value);
    if (policy.declineAt < policy.reviewAt) policy.declineAt = policy.reviewAt;
    render();
  });
  b('#pReview', 'reviewAt'); b('#pDecline', 'declineAt'); b('#pGuar', 'guaranteeAt'); b('#pMargin', 'margin');
}

// ---------------------------------------------------------------- frontier
function renderFrontier() {
  // Sweep the decline threshold and plot net margin, so the operating point is a
  // business choice with a visible optimum rather than a gut-feel number.
  const pts = [];
  for (let d = 0.1; d <= 0.95; d += 0.025) {
    const e = evaluatePolicy(ORDERS, { ...policy, declineAt: d, reviewAt: Math.min(policy.reviewAt, d) });
    pts.push({ d, margin: e.netMargin, recall: e.recall, approval: e.approvalRate });
  }
  const best = pts.reduce((a, b) => (b.margin > a.margin ? b : a));
  const maxM = Math.max(...pts.map((p) => p.margin));
  const minM = Math.min(...pts.map((p) => p.margin));
  const range = Math.max(1, maxM - minM);

  const w = 100, h = 62;
  const path = pts.map((p, i) => {
    const px = (i / (pts.length - 1)) * w;
    const py = h - ((p.margin - minM) / range) * h;
    return `${i ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`;
  }).join(' ');
  const curX = ((policy.declineAt - 0.1) / 0.85) * w;
  const bestX = ((best.d - 0.1) / 0.85) * w;

  $('#frontier').innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:118px;display:block">
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
      <line x1="${bestX}" y1="0" x2="${bestX}" y2="${h}" stroke="var(--amber)" stroke-width="1" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>
      <line x1="${curX}" y1="0" x2="${curX}" y2="${h}" stroke="var(--ink)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="mono" style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-3);margin-top:4px">
      <span>decline at 10%</span><span>net margin</span><span>95%</span>
    </div>
    <div class="note" style="margin-top:9px">
      Amber marks the margin-optimal decline threshold (<strong class="mono" style="color:var(--amber)">${pct(best.d)}</strong>,
      ${moneyK(best.margin)}); the white line is where you have it set. Tightening past the optimum
      costs more in false declines than it saves in fraud — the curve turning over is the entire
      argument for pricing a fraud decision instead of minimising fraud.
    </div>`;
}

// ---------------------------------------------------------------- queue
function renderQueue() {
  const scored = ORDERS.map((o) => ({ o, r: decide(o, policy) }));
  const rows = scored
    .filter((s) => filter === 'all' || s.r.decision === filter.toUpperCase())
    .sort((a, b) => b.r.top.p - a.r.top.p)
    .slice(0, 140);

  $('#qCount').textContent = `${rows.length} shown`;
  $('#queue').innerHTML = rows.map(({ o, r }) => {
    const cls = r.decision === 'DECLINE' ? 'bad' : r.decision === 'REVIEW' ? 'warn' : 'ok';
    return `<div class="row ${o.id === selected ? 'sel' : ''}" data-id="${o.id}" style="grid-template-columns:76px minmax(0,1fr) 74px 58px">
      <div><span class="chip ${cls}">${r.decision.slice(0, 3)}</span></div>
      <div>
        <div class="t">${o.merchant} · ${money(o.amount)}</div>
        <div class="m">${o.id} · ${o.city} · email ${o.emailAgeDays}d · ${o.priorGoodOrders} prior</div>
      </div>
      <div class="num" style="color:${r.top.p > 0.5 ? 'var(--rose)' : r.top.p > 0.2 ? 'var(--amber)' : 'var(--accent)'}">${pct(r.top.p)}</div>
      <div class="num">${r.guaranteed ? '<span class="chip ok" title="Chargeback liability assumed">G</span>' : o.actuallyFraud ? '<span class="chip bad" title="Ground truth: fraud">F</span>' : ''}</div>
    </div>`;
  }).join('');

  $('#queue').querySelectorAll('.row').forEach((el) =>
    el.addEventListener('click', () => { selected = el.dataset.id; render(); })
  );
}

// ---------------------------------------------------------------- detail
function renderDetail() {
  const o = ORDERS.find((x) => x.id === selected);
  if (!o) {
    $('#detail').innerHTML = `<div class="empty">Select an order to see the chained sub-model scores and the exact log-odds contribution of every signal.</div>`;
    return;
  }
  const r = decide(o, policy);

  const subCard = (name, label, sub) => `
    <div style="margin-bottom:11px">
      <div style="display:flex;align-items:baseline;gap:8px">
        <span class="mono" style="font-size:12px;font-weight:650">${label}</span>
        <span class="mono" style="font-size:11.5px;color:${sub.p > 0.5 ? 'var(--rose)' : sub.p > 0.2 ? 'var(--amber)' : 'var(--accent)'}">${pct(sub.p)}</span>
        <span style="flex:1"></span>
        <span class="mono" style="font-size:10.5px;color:var(--ink-3)">z=${sub.z.toFixed(2)}</span>
      </div>
      <div class="bar"><i style="width:${sub.p * 100}%;background:${sub.p > 0.5 ? 'var(--rose)' : sub.p > 0.2 ? 'var(--amber)' : 'var(--accent)'}"></i></div>
      <div style="margin-top:6px">${sub.contributions.slice(0, 3).map((c) =>
        `<div class="mono" style="font-size:10.5px;color:var(--ink-3)">${c.contribution > 0 ? '+' : ''}${c.contribution.toFixed(2)} · ${FEATURE_LABELS[c.feature] || c.feature}</div>`
      ).join('')}</div>
    </div>`;

  const maxAbs = Math.max(...r.top.contributions.map((c) => Math.abs(c.contribution)), 0.5);
  const attribution = r.top.contributions.map((c) => {
    const wpc = (Math.abs(c.contribution) / maxAbs) * 50;
    const pos = c.contribution > 0;
    return `<div style="display:grid;grid-template-columns:minmax(0,1fr) 120px 56px;gap:8px;align-items:center;padding:3px 0">
      <div style="font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${FEATURE_LABELS[c.feature] || c.feature}</div>
      <div style="position:relative;height:9px;background:var(--bg-2);border-radius:2px">
        <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--line-2)"></div>
        <div style="position:absolute;top:0;bottom:0;${pos ? `left:50%;width:${wpc}%;background:var(--rose)` : `right:50%;width:${wpc}%;background:var(--accent)`};border-radius:2px"></div>
      </div>
      <div class="mono num" style="font-size:10.5px;color:${pos ? 'var(--rose)' : 'var(--accent)'};text-align:right">${pos ? '+' : ''}${c.contribution.toFixed(2)}</div>
    </div>`;
  }).join('');

  const dcls = r.decision === 'DECLINE' ? 'bad' : r.decision === 'REVIEW' ? 'warn' : 'ok';

  $('#detail').innerHTML = `
    <div class="dsec">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:11px;flex-wrap:wrap">
        <strong class="mono" style="font-size:15px">${o.id}</strong>
        <span class="pill ${dcls}">${r.decision}</span>
        ${r.guaranteed ? '<span class="pill ok">guaranteed</span>' : ''}
        ${o.actuallyFraud ? '<span class="pill bad">ground truth: fraud</span>' : ''}
      </div>
      <dl class="kv">
        <dt>Merchant</dt><dd>${o.merchant} — ${o.vertical}</dd>
        <dt>Amount</dt><dd>${money(o.amount)}</dd>
        <dt>P(fraud)</dt><dd style="color:${r.top.p > 0.5 ? 'var(--rose)' : 'var(--accent)'}">${(r.top.p * 100).toFixed(2)}% (z = ${r.top.z.toFixed(3)})</dd>
        <dt>Expected loss</dt><dd>approve ${money(r.expectedFraudLoss)} · decline ${money(r.expectedDeclineLoss)}</dd>
        <dt>Identity</dt><dd>email ${o.emailAgeDays}d · account ${o.accountAgeDays}d · ${o.priorGoodOrders} prior orders</dd>
        <dt>Auth</dt><dd>AVS ${o.avs} · CVV ${o.cvv}</dd>
        <dt>Network</dt><dd>${o.ipDistanceKm.toLocaleString()} km from billing${o.proxy ? ' · proxy' : ''}${o.datacenterAsn ? ' · datacenter ASN' : ''}</dd>
        <dt>Consortium</dt><dd>card seen at ${o.cardVelocity} merchants/24h${o.priorChargeback ? ' · prior chargeback' : ''}${o.networkTrusted ? ' · trusted identity' : ''}</dd>
      </dl>
    </div>
    <div class="dsec">
      <h3>Chained sub-models</h3>
      ${subCard('address', 'Address manipulation', r.subs.address)}
      ${subCard('ip', 'IP &amp; device', r.subs.ip)}
      ${subCard('sku', 'Basket composition', r.subs.sku)}
    </div>
    <div class="dsec">
      <h3>Consortium model attribution</h3>
      ${attribution}
      <div class="note" style="margin-top:10px">
        Contributions are exact, not estimated: the model is logistic regression, so each bar is
        literally <code class="mono">weight × value</code> in log-odds and the bars plus the
        bias <code class="mono">${r.top.bias.toFixed(2)}</code> sum to
        <code class="mono">z = ${r.top.z.toFixed(3)}</code>. That is the difference between an
        explanation you can put in a chargeback representment and one you cannot.
      </div>
    </div>`;
}

function render() {
  renderMetrics();
  renderPolicy();
  renderFrontier();
  renderQueue();
  renderDetail();
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  $('#filters').querySelectorAll('button').forEach((x) => x.classList.toggle('primary', x.dataset.f === filter));
  renderQueue();
});

render();
window.fraud = { ORDERS, decide, evaluatePolicy, policy };
