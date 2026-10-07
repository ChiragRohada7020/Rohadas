# live-godown-check.ps1 — end-to-end proof against the RUNNING API server.
#
# WHY THIS IS A FILE, NOT INLINE POWERSHELL:
# The integration tests already prove the stock engine against a TEST database.
# This proves the SHIPPED SERVER actually serves the new behaviour over the same
# HTTP surface the browser uses. That is a different question — a router change
# can typecheck, pass every test, and still be unreachable over the wire if the
# mount path or input validation is wrong.
#
# It walks the exact story from the feature request:
#   purchase into a godown -> "which godown did this arrive at?"
#   sale naming no godown  -> "which shelf did this leave from?" (cross-godown FEFO)

$base = 'http://localhost:3000/api/trpc'
$script:headers = @{}

function Invoke-Trpc {
  param([string]$Path, $Body, [string]$Method = 'POST')
  # tRPC's HTTP adapter accepts queries only over GET, and GET carries no body —
  # the input must be encoded into the `input` query parameter instead. POST is
  # used for mutations, which do take a JSON body.
  $encoded = @{ json = $Body } | ConvertTo-Json -Depth 12 -Compress
  try {
    if ($Method -eq 'GET') {
      $uri = "$base/$Path`?input=" + [Uri]::EscapeDataString($encoded)
      $r = Invoke-WebRequest -Uri $uri -Method GET -Headers $script:headers -TimeoutSec 30 -UseBasicParsing
    } else {
      $r = Invoke-WebRequest -Uri "$base/$Path" -Method POST -ContentType 'application/json' `
           -Headers $script:headers -Body $encoded -TimeoutSec 30 -UseBasicParsing
    }
    return ($r.Content | ConvertFrom-Json)
  } catch {
    Write-Host "  !! $Path -> $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host "     $($_.ErrorDetails.Message)" -ForegroundColor Red }
    throw
  }
}

function Step($n, $text) { Write-Host "`n$n. $text" -ForegroundColor Cyan }

# ── 1. Sign in as an owner ────────────────────────────────────────────────────
#
# NOTE ON WHY THIS LOGS IN RATHER THAN REGISTERS:
# auth.register assigns the FIRST user of a tenant "owner" and every later one
# "member". business.create requires owner, so a freshly registered user gets a
# 403. Using the seeded owner account exercises exactly the same code paths
# without fighting the onboarding rules.
Step 1 "Sign in as the seeded owner"
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$email = 'demo.inventory@example.com'
$login = Invoke-Trpc 'auth.login' @{ email = $email; password = 'demopass12345' }
$script:headers = @{ Authorization = "Bearer $($login.result.data.json.sessionToken)" }
Write-Host "   signed in as $email"

$bizList = (Invoke-Trpc 'business.list' @{} 'GET').result.data.json
$businessId = @($bizList)[0].id
Write-Host "   business $($bizList[0].name) ($businessId)"

# Every business-scoped procedure reads the active business from the
# `x-business-id` header — the same header the web client sends. Without it
# `hasBusinessAccess` rejects the call with "No business selected".
$script:headers['x-business-id'] = $businessId

# ── 2. Godowns ─────────────────────────────────────────────────────────────────
Step 2 "Create two godowns (back room + front counter)"
$g1 = Invoke-Trpc 'inventory.create' @{ name = 'Back Room'; isPrimary = $true }
$g2 = Invoke-Trpc 'inventory.create' @{ name = 'Front Counter' }
$backRoom = $g1.result.data.json.id
$front = $g2.result.data.json.id
Write-Host "   Back Room     = $backRoom (primary)"
Write-Host "   Front Counter = $front"

# ── 3. Tracked item + parties ─────────────────────────────────────────────────
Step 3 "Create a BATCH-tracked item, a supplier and a customer"
$item = Invoke-Trpc 'item.create' @{
  name = 'Demo Basmati 5kg'; itemType = 'product'; itemMode = 'simple'
  trackingMode = 'batch'; unit = 'bag'
  salePrice = '450'; purchasePrice = '380'; taxPercent = '5'; hsn = '1006'
}
$itemId = $item.result.data.json.id
Write-Host "   item $itemId trackingMode=$($item.result.data.json.trackingMode)"

# gstin must be a string — the schema accepts a valid GSTIN or the empty
# string, but NOT null.
$sup = Invoke-Trpc 'party.create' @{ name = 'Demo Supplier'; type = 'supplier'; gstin = ''; city = 'Pune'; state = 'Maharashtra'; stateCode = '27'; openingBalance = '0.00' }
$cust = Invoke-Trpc 'party.create' @{ name = 'Demo Customer'; type = 'customer'; gstin = ''; city = 'Pune'; state = 'Maharashtra'; stateCode = '27'; openingBalance = '0.00' }
$supplierId = $sup.result.data.json.id
$customerId = $cust.result.data.json.id
# ── 4. PURCHASE into the back room ────────────────────────────────────────────
Step 4 "PURCHASE 40 bags into Back Room, batch B-100, expiry 2027-06-30"
$expiry = ([DateTime]::new(2027, 6, 30)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$pur = Invoke-Trpc 'invoice.create' @{
  partyId = $supplierId; type = 'purchase'
  lineItems = @(@{
      itemId = $itemId; itemName = 'Demo Basmati 5kg'; quantity = '40'
      unitPrice = '380'; taxPercent = '5'
      godownId = $backRoom; batchNo = 'B-100'; expiryDate = $expiry
    })
}
Write-Host "   purchase invoice $($pur.result.data.json.invoiceNumber) created"

Step 5 "Verify the lot landed in the Back Room"
$lots = (Invoke-Trpc 'inventory.listLots' @{ itemId = $itemId } 'GET').result.data.json
if ($lots.Count -lt 1) { throw "No lot was created by the purchase" }
foreach ($l in $lots) {
  Write-Host "   lot=$($l.batchNo) qty=$($l.quantity) godown=$($l.godownId) expiry=$($l.expiryDate)"
  if ($l.batchNo -ne 'B-100')    { throw "Expected lot B-100, got '$($l.batchNo)'" }
  if ($l.godownId -ne $backRoom) { throw "Expected Back Room ($backRoom), got $($l.godownId)" }
  if ([double]$l.quantity -ne 40){ throw "Expected qty 40, got $($l.quantity)" }
}
Write-Host "   OK - purchase attributed to the chosen godown" -ForegroundColor Green

# ── 5. SALE with no godown -> cross-godown FEFO ───────────────────────────────
Step 6 "SELL 25 bags naming NO godown (cross-godown FEFO)"
$sale = Invoke-Trpc 'invoice.create' @{
  partyId = $customerId; type = 'sale'; source = 'pos'
  lineItems = @(@{
      itemId = $itemId; itemName = 'Demo Basmati 5kg'; quantity = '25'
      unitPrice = '450'; taxPercent = '5'
    })
}
Write-Host "   sale invoice $($sale.result.data.json.invoiceNumber) created"

Step 7 "Verify FEFO drained the lot to 15 and BOTH ledgers agree"
$after = (Invoke-Trpc 'inventory.listLots' @{ itemId = $itemId } 'GET').result.data.json
$lotQty = [double]$after[0].quantity
Write-Host "   lot quantity now = $lotQty"
if ($lotQty -ne 15) { throw "Expected 15 left after selling 25 of 40, got $lotQty" }

$itemRow = (Invoke-Trpc 'item.list' @{ page = 1; limit = 100 } 'GET').result.data.json.data |
           Where-Object { $_.id -eq $itemId } | Select-Object -First 1
$itemQty = [double]$itemRow.stockQuantity
Write-Host "   item stock_quantity = $itemQty"
# THE critical assertion: a lot system that disagrees with the item total is
# worse than no lot system, because the number on the invoice looks right.
if ($itemQty -ne $lotQty) { throw "LEDGER DRIFT: item says $itemQty but lots say $lotQty" }
Write-Host "   OK - the two ledgers agree" -ForegroundColor Green

# ── 6. Cancellation restores the lot ──────────────────────────────────────────
Step 8 "CANCEL the sale - the lot must be restored to 40"
Invoke-Trpc 'invoice.delete' @{ id = $sale.result.data.json.id } | Out-Null
$restored = (Invoke-Trpc 'inventory.listLots' @{ itemId = $itemId } 'GET').result.data.json
$back = [double]$restored[0].quantity
Write-Host "   lot quantity after cancel = $back"
if ($back -ne 40) { throw "Expected 40 restored after cancelling a 25-unit sale, got $back" }
Write-Host "   OK - cancellation is symmetric" -ForegroundColor Green

Step 9 "Godown-wise stock breakdown"
$byGodown = (Invoke-Trpc 'inventory.stockByGodown' @{ itemId = $itemId } 'GET').result.data.json
Write-Host "   $($byGodown | ConvertTo-Json -Depth 5 -Compress)"

Write-Host "`nALL LIVE CHECKS PASSED" -ForegroundColor Green