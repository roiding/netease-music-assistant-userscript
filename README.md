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
top-up and rcredit redemption controls. Users who have reached the monthly
received-help cap can continue helping and receive rcredit instead of ordinary
credit; disabled economy features remain hidden.
The 4.0.0 panel adds an **应急悬赏** switch. It is shown only as available when
the backend reports a funded pool and actual backlog pressure; the panel then
joins with `POST /api/join { bounty: true }` and requests `/api/next?bounty=1`.
The mode has no music target and does not erase an already saved target. Accounts
must be at least seven days old and not restricted or banned. A completed bounty
shows the regular and bounty portions separately, while unused funding returns
to the pool. The wallet displays bounty rcredit separately; non-Helpers can
redeem that balance through the normal redemption flow at the same rate.
Emergency availability, supply balancing and slot totals are backend-managed;
the userscript has no local threshold or inventory controls.
The backend also publishes one randomly selected community help day each month.
On that date, a normal consumer account can start the local helper workflow and
earn decayable credit without opening Helper; banned and restricted accounts
remain excluded. The panel reads the Beijing activity date from `/api/me` and
shows the automatically generated announcement.
When configured by the backend, rcredit redemption can be settled immediately
through the official LDC merchant distribution API. Ambiguous results remain
frozen for administrator reconciliation instead of being retried automatically.

`互助脚本.user.js` is the only distributed userscript source file.

The script is distributed through Greasy Fork. Do not add GitHub/jsDelivr
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
