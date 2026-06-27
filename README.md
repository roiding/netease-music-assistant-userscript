# Netease Music Helper Frontend

Tampermonkey userscript for Netease Music mutual playback.

## Install

- GitHub: [netease-music-assistant-userscript](https://github.com/roiding/netease-music-assistant-userscript)
- Direct install:
  [互助脚本.js](https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/互助脚本.js)

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
new versions from the GitHub-backed jsDelivr URL.

From `v3.2.1` onward, the script also sends its version to the Worker so the
backend can show a stronger in-panel upgrade prompt when you raise the minimum
supported version.
