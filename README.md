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

When a target is submitted as an album ID, the userscript will randomly choose
one song from that album and settle it the same way as a normal single-song job.

Tampermonkey will use the `@downloadURL` and `@updateURL` metadata to check for
new versions from the GitHub-backed jsDelivr URL.
