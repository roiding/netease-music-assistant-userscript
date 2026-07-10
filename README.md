# Netease Music Helper Frontend

Tampermonkey userscript for Netease Music mutual playback.

## Install

- Greasy Fork: `https://greasyfork.org/scripts/584818`
- Direct install after publishing:
  `https://update.greasyfork.org/scripts/584818/%E7%BD%91%E6%98%93%E4%BA%91%E9%9F%B3%E4%B9%90%E4%BA%92%E5%8A%A9%E6%92%AD%E6%94%BE%E8%84%9A%E6%9C%AC.user.js`

## Configure

Deploy the backend first, then update `API_BASE` in `互助脚本.user.js`:

```js
const API_BASE = 'https://YOUR_WORKER_DOMAIN/api';
```

The script runs on:

```text
*://music.163.com/*
```

Linux.do OAuth is used only for the initial identity binding. After login, the
script stores the Worker's own `musicHelperToken` with Tampermonkey storage.

When a target is submitted as an album ID, the script will upload the album's
track metadata so the backend can randomly assign one concrete song and reserve
credits by that song's duration. Older records without metadata still fall back
to the userscript-side album parsing logic.

When the backend economy flags are enabled, the panel also shows LDC credit
top-up and rcredit redemption controls. Users who have reached the monthly
received-help cap can continue helping and receive rcredit instead of ordinary
credit; disabled economy features remain hidden.

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
