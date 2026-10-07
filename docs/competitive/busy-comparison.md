# BUSY Comparison

Capability comparison between **Rohadas** (this repo) and **BUSY** (busy.in),
the incumbent Indian MSME accounting and GST billing suite.

**Purpose:** this file exists so the competitive gap is tracked in the repo
rather than in a conversation. When a row changes, update this table in the
same PR — a stale competitive matrix is worse than none.

- Last reviewed: against busy.in homepage, pricing, GST and inventory pages.
- BUSY pricing moves frequently (editions Start / Smart / Power / Power+);
  treat the pricing column as indicative, verify before quoting it.

---

## Summary

| | Rohadas | BUSY |
|---|---|---|
| Model | Open source, self-hostable, free | Proprietary, hosted + desktop |
| Price | Free (O'Saasy licence) | ~₹5,000 – ₹50,000 per year per edition |
| Positioning | Agent-native financial OS | Desktop-first MSME accounting suite |
| Users | Unlimited per self-hosted instance | Tiered by edition and user count |
| Data ownership | Your database | Vendor's servers |

**Where Rohadas is ahead:** bank reconciliation, agent-native access (MCP +
CLI), payment-gateway accounting, built-in online storefront, multi-tenancy,
open source, and enforced cross-client feature parity.

**Where Rohadas trails:** inventory depth (serial / batch / expiry / godown),
manufacturing, payroll, budgets, barcode label printing, report breadth, and
industry-specific templates.

---

## Capability matrix

Legend: ✅ shipped · ⚠️ partial · ❌ not implemented

### Invoicing and documents

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Sale / purchase invoice | ✅ | ✅ | |
| CGST/SGST/IGST auto-split from state codes | ✅ | ✅ | |
| PDF formats (A4 / A5 / thermal) | ✅ | ✅ | |
| UPI QR on invoice | ✅ | ✅ | |
| Quotations / proformas → invoice | ✅ | ✅ | |
| Delivery challan → invoice | ✅ | ✅ | Rohadas adds e-way bill linkage |
| Credit / debit notes | ✅ | ✅ | Separate numbering sequences |
| Sales / purchase returns | ✅ | ✅ | Automatic stock adjustment |
| Digital signature on invoice | ❌ | ✅ | BUSY plans list this explicitly |
| Recurring / automated invoices | ✅ | ⚠️ | |

### GST compliance

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| GSTR-1 | ✅ | ✅ | Rohadas adds HSN summary + CDN |
| GSTR-3B | ✅ | ✅ | |
| GSTR-4 (composition) | ✅ | ✅ | Added here; replaced CMP-08 |
| GSTR-4 portal JSON export | ✅ | ✅ | |
| CMP-08 (legacy) | ✅ | ⚠️ | Superseded by GSTR-4 from FY 2019-20 |
| GSTR-9 (annual) | ✅ | ✅ | |
| GSTR-2A/2B reconciliation | ✅ | ✅ | With per-record ignore |
| E-invoicing (IRN + signed QR) | ✅ | ✅ | |
| E-way bill | ✅ | ✅ | Rohadas adds Part-B update, expiry extension, expiring-soon list |
| Composition scheme enforcement | ✅ | ✅ | Inter-state supplies blocked at invoice create |
| HSN/SAC autocomplete + digit rules | ⚠️ | ✅ | **Rohadas: curated 437-code master, not the full NIC master** |
| Composition rate configurability | ✅ | ✅ | 1% / 0.5% / 5% / 6% |
| IMS (invoice management system) | ❌ | ✅ | Tracked in roadmap |
| Direct GSP filing | ❌ | ❌ | Neither files directly today |

### Accounting

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Double-entry ledger | ✅ | ✅ | |
| Chart of Accounts seeding | ✅ 40 accounts | ✅ | |
| Trial Balance / Balance Sheet / P&L | ✅ | ✅ | |
| Cash Flow Statement (indirect) | ✅ | ✅ | |
| General Ledger / Daybook | ✅ | ✅ | |
| Comparative FY-vs-FY with variance | ✅ | ✅ | Rohadas: 3 statements |
| Journal entries for CA adjustments | ✅ | ✅ | Depreciation, provisions, bad debt |
| Tally XML export | ✅ | ✅ | |
| Multi-branch / multi-company | ⚠️ multi-business via tenants | ✅ | Not intra-business branches |
| Budgets / cost centres | ❌ | ✅ | Tracked in roadmap |
| Payroll / salary register | ❌ | ✅ | Tracked in roadmap |
| TDS / Form 26AS | ❌ | ✅ | Only a `TDS Payable` CoA row exists |
| Excise / Cess modules | ❌ | ✅ | |

### Inventory

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Item master + variants | ✅ | ✅ | Rohadas: `simple` / `alt_units` / `variants` modes |
| Real-time stock + low-stock alerts | ✅ | ✅ | |
| Unit conversion | ✅ | ✅ | |
| SKU / barcode field | ✅ | ✅ | |
| Barcode scan in POS | ✅ | ✅ | Rohadas detects keyboard-wedge scanners |
| **Serial-number tracking** | ✅ | ✅ | Lot with `quantity = 1` per unit; serial unique per business |
| **Batch / lot tracking** | ✅ | ✅ | `stock_lots` ledger, FEFO-ready |
| **Expiry tracking** | ✅ | ✅ | FEFO allocation + near-expiry report |
| **Multi-godown / multi-location** | ✅ | ✅ | `inventory.stockByGodown` + transfers that leave the total unchanged |
| Inter-warehouse transfers | ✅ | ✅ | `inventory.transfer` |
| Stock ageing / reorder management | ✅ | ✅ | |
| Barcode label generation / printing | ❌ | ✅ | **Gap** — depends on nothing now that lots exist |
| **Manufacturing (BOM / work orders / job work)** | ❌ | ✅ | **Gap** |

### Banking and payments

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Bank accounts + balances | ✅ | ✅ | |
| **CSV bank reconciliation** | ✅ 10 banks, 4-tier match | ❌ | **Rohadas ahead** |
| BRS generation | ✅ | ❌ | Rohadas ahead |
| Auto-categorisation rules | ✅ | ❌ | |
| 9 payment modes | ✅ | ✅ | |
| Multi-invoice payment allocation | ✅ | ✅ | |
| Inter-account transfer | ✅ | ✅ | |
| **Payment gateway accounting** | ✅ charges/settlement/reversal | ⚠️ basic | **Rohadas ahead** |
| Account Aggregator / direct bank feed | ❌ | ❌ | Both need consent infra |

### Reporting and analytics

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Built-in reports | 20 | 100+ | **BUSY ahead on breadth** |
| Custom report builder | ❌ | ✅ | BUSY Power / Power+ |
| CSV export on reports | ✅ | ✅ | |
| Dashboard analytics (trend, top N, aging) | ✅ | ✅ | |
| Sales / profitability analysis | ✅ | ✅ | |


### Platform and access

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Web dashboard | ✅ | ✅ (Online) | |
| Mobile app | ✅ Expo | ✅ | Rohadas: ~90 screens; BUSY claims 100+ reports |
| Desktop app | ✅ Tauri | ✅ native | |
| Online storefront | ✅ built-in | ⚠️ separate Recom product | **Rohadas ahead** |
| POS | ✅ | ✅ | |
| Role-based access | ✅ 6 roles | ✅ | |
| Audit trail with before/after | ✅ | ✅ | Rohadas logs full state delta |
| Multi-tenant SaaS | ✅ | ❌ | **Rohadas ahead** |
| **CLI** | ✅ `@hisaabo/cli` | ❌ | **Rohadas ahead** |
| **MCP server for AI agents** | ✅ `@hisaabo/mcp` | ❌ | **Rohadas ahead** |
| Remote access to desktop | ✅ self-hosted | ✅ BUSY On Cloud | |

### Ecosystem

| Capability | Rohadas | BUSY | Notes |
|---|---|---|---|
| Industry templates (20+ verticals) | ❌ | ✅ | **Gap** |
| E-commerce marketplace sync | ❌ | ✅ Recom (Amazon/Flipkart/Shopify) | **Gap** |
| Commission-agent (mandi) module | ❌ | ✅ BUSY Mandi | Out of scope for Rohadas |
| Data migration from other tools | ✅ myBillBook / Tally / generic CSV | ✅ | |
| 24/7 phone support | ❌ | ✅ | **BUSY ahead** |

---

## Gap closure order

Ranked by how often an Indian MSME actually hits the gap, not by how
interesting the feature is.

1. **Full NIC HSN/SAC master** — blocks correct e-invoicing above ₹5 Cr turnover.
2. **Barcode label printing** — now the cheapest remaining inventory win: the
   lot and godown foundation it needs now exists.
3. **TDS + Form 26AS** — most CAs' clients need it; currently a CoA row only.
4. **Budgets** — common request from management-facing users.
5. **Invoice-line lot allocation** — lots are received, queried, transferred and
   FEFO-planned, but sale/purchase document lines do not yet consume or create
   lots automatically. The schema columns (`invoice_items.lot_id` /
   `godown_id`) are in place; the wiring in the document routers is not.
6. **Payroll** — large scope, narrower audience.
7. **Manufacturing / BOM** — only relevant for manufacturers.
8. **Industry templates** — high marketing value, low engineering depth.
9. **E-commerce sync** — large scope; the built-in storefront covers part of it.

Items 1 and 3 are compliance correctness issues. Items 2 and 5 are inventory
parity. Items 4 and 6–9 are scope decisions.

---

## Maintaining this file

- Update the row **and** the "Gap closure order" when a capability ships.
- Do not mark a capability ✅ until it is tested against a real database — the
  API suite is the source of truth, not the UI.
- If a capability is intentionally out of scope, say so in the Notes column
  rather than leaving it blank.

