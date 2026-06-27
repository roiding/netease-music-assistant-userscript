# Netease Music Helper Frontend

Tampermonkey userscript for Netease Music mutual playback.

## Install

- GitHub: [netease-music-assistant-userscript](https://github.com/roiding/netease-music-assistant-userscript)
- Direct install:
  [互助脚本.user.js](https://raw.githubusercontent.com/roiding/netease-music-assistant-userscript/main/%E4%BA%92%E5%8A%A9%E8%84%9A%E6%9C%AC.user.js)

## Configure

Deploy the backend first, then update `API_BASE` in `互助脚本.js`:

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

Tampermonkey will use the `@downloadURL` and `@updateURL` metadata to check for
new versions from the `.user.js` distribution URL. The in-panel "更新脚本"
button also points to that `.user.js` install link so Tampermonkey can open the
update/install dialog directly.

From `v3.2.1` onward, the script also sends its version to the Worker so the
backend can show a stronger in-panel upgrade prompt when you raise the minimum
supported version.
