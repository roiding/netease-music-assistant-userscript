# Netease Music Helper Frontend

Tampermonkey userscript for Netease Music mutual playback.

## Install

- Greasy Fork: `https://greasyfork.org/scripts/584818`
- Direct install after publishing:
  `https://update.greasyfork.org/scripts/584818/%E7%BD%91%E6%98%93%E4%BA%91%E9%9F%B3%E4%B9%90%E4%BA%92%E5%8A%A9%E6%92%AD%E6%94%BE%E8%84%9A%E6%9C%AC.user.js`

## Configure

Deploy the backend first, then update `SERVICE_ORIGINS` in `互助脚本.user.js`.
The first entry is canonical and later entries are network-failure fallbacks:

```js
const SERVICE_ORIGINS = ['https://PRIMARY_WORKER_DOMAIN', 'https://FALLBACK_WORKER_DOMAIN'];
```

The script runs on:

```text
*://music.163.com/*
```

Linux.do OAuth binds the local account. After login, the script stores the
Worker's own `musicHelperToken` with Tampermonkey storage. A consumer user may
submit a target and recharge credit immediately; the separate "开通 Helper"
action opens the account-panel shop for limited-stock daily, weekly, monthly or
permanent Helper purchases. Prices and available inventory come from the admin
configuration. No CDK is required; an "已有 CDK" link preserves the existing
redemption flow. The LDC cashier still opens outside the panel and returns to
music; the panel checks the order and refreshes the access token automatically.

Daily and weekly renewals add 24 hours / 7 days to the remaining qualification.
Monthly cards retain the calendar-month rule: expiry is next month's first day
at 00:00 Beijing time. Existing permanent accounts are not changed. Buying
qualification does not recharge credit or override the monthly dispatch rules.
Since 3.9.2, permanent qualification reuses the original daily median and Linux.do
profile pricing. Use the panel's "同步 Linux.do 活跃度 / 永久售价" action before
buying permanent access. The userscript reads the profile in the signed-in
Linux.do popup and transfers it through local Tampermonkey storage; no separate
register storefront is needed. Daily/weekly/monthly prices remain admin-configured
and do not require profile sync. Existing pending orders keep their locked amount.
Read and confirm the risk notice before buying. From 3.9.1 onward, the panel
shop has no embedded Cloudflare verification widget. Other redemption pages
retain their existing verification. If payment creation is uncertain, use the retained order's query action
instead of creating another payment; unresolved payments retain their inventory
until verified by the gateway or administrator.

When a target is submitted as an album ID, the script will upload the album's
track metadata so the backend can randomly assign one concrete song and reserve
credits by that song's duration. Older records without metadata still fall back
to the userscript-side album parsing logic.

When the backend economy flags are enabled, the panel also shows LDC credit
top-up and rcredit redemption controls. rcredit is one balance: bounty jobs pay
`min(2 x credit reward, 30)` rcredit from the emergency pool, and Helpers also
earn the owner's credit 1:1. Only active Helpers may convert credit to rcredit
or withdraw rcredit; consumers and restricted Helpers see no wallet conversion
or withdrawal controls. Disabled economy features remain hidden.
The 4.1.0 shop turns the monthly card into the primary unlimited plan: the backend
calculates its price from the remaining Beijing calendar days, and a floor-price
purchase extends into the next month by its equivalent number of days. Permanent
qualification remains unlimited and profile-priced. Daily and weekly cards remain
activity-only limited-stock plans; they are hidden from the panel when stock is zero.
The panel includes the **应急悬赏** entry for non-Helpers only. It is shown as available when
the backend reports a funded pool and actual backlog pressure; the panel then
joins with `POST /api/join { bounty: true }` and requests `/api/next?bounty=1`.
The mode has no music target and does not erase an already saved target. Accounts
must be at least seven days old and not restricted or banned. A completed bounty
shows the regular and bounty portions separately, while unused funding returns
to the pool. The wallet displays a single merged rcredit balance. Withdrawal is
limited to active Helpers at the common rate; non-Helpers cannot redeem bounty
rcredit.
Emergency availability, supply balancing and slot totals are backend-managed;
the userscript has no local threshold or inventory controls.
The backend also publishes one randomly selected community help day each month.
On that date, a normal consumer account can start the local helper workflow and
earn decayable credit without opening Helper; banned and restricted accounts
remain excluded. The panel reads the Beijing activity date from `/api/me` and
shows the automatically generated announcement.
rcredit redemption and LDC packets use merchant payment orders created with
the recipient's bound EasyPay credentials; the administrator pays the order.
Opening the panel checks for active, unclaimed packets and shows a popup only
when a share is available. There is no separate packet tab. Claiming reserves
one share; server-confirmed payment determines receipt. Campaign expiry and
paying-link expiry never prove that an existing payment was unpaid.

`互助脚本.user.js` is the public userscript distributed to general users.

## Administrator Userscript: `Linux.do自动付款助手.user.js`

A standalone userscript designed specifically for the administrator, kept
separate from the public music script. It is stored in this repository; the
public music script is the Greasy Fork release artifact.

Features:
- Runs on `https://credit.linux.do/*` and the admin management console (`https://roiding.dpdns.org/admin`).
- Verifies `credit.linux.do` login state and strictly validates that the logged-in Linux.do UID matches the administrator (`207121`).
- Locally manages the 6-digit payment security code via Tampermonkey storage (`GM_setValue`); only credit.linux.do receives it when paying. Do not sync or share script storage.
- Reads up to 50 pending rcredit redemptions and 50 red-packet claims (`GET /api/admin/redemptions/auto-pay-tasks`) without creating orders. Each task has a type-qualified identity; packet payouts never debit rcredit.
- Performs zero-trust double-checking against Linux.do's official order API (`status === pending`, payee, amount, payer UID) before submitting payment.
- Batch auto-pays verified orders in one click and reports confirmation back to the Worker backend.

Version 1.0.6 checks Credit identity, queries payment details and submits payment
with native same-origin `fetch` and `credentials: include` on credit.linux.do.
It no longer uses extension requests for Credit cookies. The management page
syncs administrator credentials and lists orders, but does not infer Credit
login status cross-site or execute payments. After opening the management page,
use **前往 Credit 核验并付款** and open the assistant there. HTTP 401/403,
HTML challenge pages, invalid responses and network failures have separate
diagnostics and all block payment; no payment request is automatically retried.
Cookies are neither copied nor persisted by the assistant.

Unavailable checkout links (404, expired or non-pending) are reported to the
backend with the signed task, without posting a payment. The backend performs
an independent creator query. Already-paid orders settle; other results block
the link from batching. Blocked tasks remain visible but are excluded from the
confirmed batch total. Repeated list refreshes cannot revive a reported link.
Refreshing orders performs a creator-side recheck of blocked attempts. There
is no human-confirmation override. A paid result settles; an unequivocal
missing-order result or combined expiry evidence can allow a replacement.
Ambiguous results remain blocked; `status=0` or a checkout 404 alone never
triggers retry or payment. Packet success requires server claim settlement,
not merely an acknowledgement from the checkout payment endpoint.

After matching the order fields, the assistant records the official checkout
ID and expiry through an admin-bound signed task. The backend independently
queries the creator and requires matching merchant, business number, amount,
provider ID, `status=0`, explicit zero trade time and the saved expiry plus a
30-second grace. This observation comes from the trusted administrator's
browser; it is not provider-signed evidence. A confirmed expired/unpaid order
may be re-prepared once before any payment POST. Old unavailable links without
recorded expiry remain blocked rather than being blindly replaced.

Install this file again to update a locally installed copy; a Git push alone
does not update that copy. The assistant prepares orders
only after batch confirmation, rechecks original orders before replacement, and
stops on uncertain results instead of blindly retrying. Keep the
reserved balance until the original payment has been reconciled.

The public music script is distributed through Greasy Fork. Do not add GitHub/jsDelivr
metadata URLs to the userscript header; Greasy Fork should be the install origin.
The in-panel "更新脚本" button receives its URL from the Worker
`GREASYFORK_SCRIPT_ID` / `USERSCRIPT_UPDATE_URL` configuration.

## Release Notes

Whenever the frontend is released:

1. Edit `互助脚本.user.js`.
2. Push the frontend repository so the configured webhook triggers Greasy Fork.
3. Keep the script version aligned with backend `USERSCRIPT_LATEST_VERSION`.
4. Keep backend `GREASYFORK_SCRIPT_ID` set to `584818`.
5. Verify the Greasy Fork install URL serves the new header:
   ```bash
   curl -sS 'https://update.greasyfork.org/scripts/584818/%E7%BD%91%E6%98%93%E4%BA%91%E9%9F%B3%E4%B9%90%E4%BA%92%E5%8A%A9%E6%92%AD%E6%94%BE%E8%84%9A%E6%9C%AC.user.js' | sed -n '1,8p'
   ```

From `v3.2.1` onward, the script also sends its version to the Worker so the
backend can show a stronger in-panel upgrade prompt when you raise the minimum
supported version.
