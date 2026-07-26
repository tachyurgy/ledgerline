# Ledgerline

**Chargeback-liability decisioning engine with exact log-odds attribution and a margin curve.**

Live: **https://ledgerline.levelbrook.com**

## What this is

When you carry the liability, fraud stops being a detection problem and becomes a pricing
problem, because a false decline costs real margin and nobody sends you a chargeback notice for it.

## Engineering notes

### Consortium model over specialists

Three specialist sub-models (address manipulation, IP and
device, basket composition) chain into a consortium model that also sees cross-merchant velocity, the signal no
single merchant can produce alone.

### Exact attribution

Because the top model is logistic regression, attribution is exact rather
than approximated: every bar is weight times value in log-odds, and the bars plus the bias sum to z. That
matters for representment, where "the model said so" is not an answer.

### The margin curve is the point

Sweeping the decline threshold shows net margin turning over, so
the optimum is not the tightest threshold. Tightening past it costs more in false declines than it saves in
fraud.

### Fixing a demo that was lying

The first pass scored 100 percent precision and recall, which
meant the synthetic fraud was trivially separable and the whole argument was hollow. Adding sophisticated fraud
(aged accounts, residential proxies, ordinary baskets) and risky-looking good customers (travelling, gifting to
a new address, expediting) produced genuine overlap and realistic numbers: about 80 percent recall at 87 percent
precision, with real false declines to trade against.

## Stack

Vanilla JavaScript, logistic regression ensemble, static hosting


## Running it

Static. Open `index.html`, or serve the directory:

```
python3 -m http.server 8000
```

## Honest scope

This is a focused engineering demo, not a production system. The data is synthetic and generated
locally so that the behaviour is reproducible. The reasoning, the arithmetic and the failure modes
are the point; the surface area is deliberately narrow.

## License

MIT
