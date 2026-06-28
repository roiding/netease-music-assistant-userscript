// ==UserScript==
// @name         网易云音乐互助播放脚本
// @namespace    http://tampermonkey.net/
// @version      3.3.6
// @description  V3.3.6：优化服务暂停与互助失败提示，优先显示后端返回原因。
// @author       roiding
// @homepageURL  https://github.com/roiding/netease-music-assistant-userscript
// @supportURL   https://github.com/roiding/netease-music-assistant-userscript/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/%E4%BA%92%E5%8A%A9%E8%84%9A%E6%9C%AC.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/%E4%BA%92%E5%8A%A9%E8%84%9A%E6%9C%AC.user.js
// @match        *://music.163.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      netease.ran-ding.gq
// ==/UserScript==

(function() {
    'use strict';
    if (window.self !== window.top) return;

    const API_BASE = 'https://netease.ran-ding.gq/api';
    const CURRENT_VERSION = '3.3.6';
    const UPDATE_FALLBACK_URL = 'https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/%E4%BA%92%E5%8A%A9%E8%84%9A%E6%9C%AC.user.js';
    const TOKEN_KEY = 'musicHelperToken';
    const LEGACY_TOKEN_KEY = 'linuxDoToken';
    const ACCESS_EXPIRES_AT_KEY = 'musicHelperAccessExpiresAt';
    const REFRESH_EXPIRES_AT_KEY = 'musicHelperRefreshExpiresAt';
    const ERROR_KEY = 'musicHelperLastError';
    const TAB_LOCK_KEY = 'musicHelperActiveTabLock';
    const TAB_ID_KEY = 'musicHelperTabId';
    const JOIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
    const TOKEN_REFRESH_SKEW_MS = 5000;
    const TAB_LOCK_HEARTBEAT_MS = 5000;
    const TAB_LOCK_STALE_MS = 15000;

    let isHelperRunning = false;
    let monitorTimer = null;
    let joinTimer = null;
    let authConfig = null;
    let isDragging = false;
    let activeJoinState = null;
    let upgradeRequired = false;
    let refreshPromise = null;
    let tabLockTimer = null;
    let tabLockOwned = false;

    const TAB_INSTANCE_ID = getOrCreateTabInstanceId();

    function safeJSON(text) { try { return JSON.parse(text); } catch (e) { return null; } }
    function getUnsafeWindow() { try { return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; } catch(e) { return window; } }
    function getSafePlayer() { try { const uw = getUnsafeWindow(); return window.player || uw.player || null; } catch(e) { return null; } }

    function createLocalInstanceId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function getOrCreateTabInstanceId() {
        try {
            const existing = sessionStorage.getItem(TAB_ID_KEY);
            if (existing) return existing;
            const created = createLocalInstanceId();
            sessionStorage.setItem(TAB_ID_KEY, created);
            return created;
        } catch (e) {
            return createLocalInstanceId();
        }
    }

    function readTabLock() {
        try {
            const raw = localStorage.getItem(TAB_LOCK_KEY);
            return raw ? safeJSON(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function isTabLockStale(lock) {
        const updatedAt = Number(lock && lock.updatedAt || 0);
        return !updatedAt || Date.now() - updatedAt > TAB_LOCK_STALE_MS;
    }

    function writeTabLock() {
        try {
            localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({
                id: TAB_INSTANCE_ID,
                updatedAt: Date.now(),
            }));
        } catch (e) {}
    }

    function releaseTabLock() {
        if (tabLockTimer) {
            clearInterval(tabLockTimer);
            tabLockTimer = null;
        }
        try {
            const lock = readTabLock();
            if (lock && lock.id === TAB_INSTANCE_ID) {
                localStorage.removeItem(TAB_LOCK_KEY);
            }
        } catch (e) {}
        tabLockOwned = false;
    }

    function tryAcquireTabLock() {
        const current = readTabLock();
        if (!current || current.id === TAB_INSTANCE_ID || isTabLockStale(current)) {
            writeTabLock();
            const confirmed = readTabLock();
            tabLockOwned = !!(confirmed && confirmed.id === TAB_INSTANCE_ID);
            return tabLockOwned;
        }
        tabLockOwned = false;
        return false;
    }

    function startTabLockHeartbeat() {
        if (!tryAcquireTabLock()) return false;
        if (tabLockTimer) clearInterval(tabLockTimer);
        tabLockTimer = setInterval(() => {
            if (!tryAcquireTabLock()) {
                releaseTabLock();
                handleTabConflict();
            }
        }, TAB_LOCK_HEARTBEAT_MS);
        return true;
    }

    function ensureSingleTabLock() {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) {
            releaseTabLock();
            return true;
        }
        if (tabLockOwned && tryAcquireTabLock()) return true;
        if (startTabLockHeartbeat()) return true;
        handleTabConflict();
        return false;
    }

    function triggerIframePlay() {
        try {
            const frame = document.getElementById('g_iframe');
            if (!frame || !frame.contentDocument) return false;
            const doc = frame.contentDocument;
            const playBtn = doc.querySelector('.u-btni-play') || doc.querySelector('[data-res-action="play"]') || doc.querySelector('#playall') || doc.querySelector('.u-btn2-2');
            if (playBtn) {
                ['mousedown', 'mouseup', 'click'].forEach(t => playBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, view: frame.contentWindow })));
                return true;
            }
        } catch (e) {}
        return false;
    }

    function getProgress() {
        let cur = 0, dur = 0, state = '';
        const p = getSafePlayer();
        try { if (p && typeof p.getDuration === 'function' && p.getDuration() > 0) return { cur: p.getPosition(), dur: p.getDuration(), state: p.getState ? p.getState() : '' }; } catch(e) {}
        try {
            const timeEl = document.querySelector('.g-btmbar .time');
            if (timeEl) {
                const parts = timeEl.innerText.split('/').map(s => s.trim());
                if (parts.length === 2) {
                    const toMs = (t) => { const [m, s] = t.split(':').map(Number); return (m * 60 + s) * 1000; };
                    cur = toMs(parts[0]); dur = toMs(parts[1]);
                }
            }
            const playBtn = document.querySelector('.g-btmbar .ply');
            state = (playBtn && playBtn.classList.contains('pas')) ? 'play' : 'stop';
        } catch(e) {}
        return { cur, dur, state };
    }

    function getPlaybackRate() {
        try {
            const p = getSafePlayer();
            if (p && p.audio && Number.isFinite(Number(p.audio.playbackRate))) {
                return Number(p.audio.playbackRate);
            }
        } catch (e) {}
        try {
            const audio = document.querySelector('audio');
            if (audio && Number.isFinite(Number(audio.playbackRate))) {
                return Number(audio.playbackRate);
            }
        } catch (e) {}
        return 1;
    }

    function getCurrentPlayingSongId() {
        try {
            const currentLink = document.querySelector('.m-playbar .words .name') || document.querySelector('.g-btmbar a[href*="song?id="]');
            return currentLink ? extractSongId(currentLink.getAttribute('href')) : '';
        } catch (e) {}
        return '';
    }

    function getQueueCount() {
        try {
            const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
            const count = Number((panelBtn && panelBtn.textContent || '').trim());
            return Number.isFinite(count) ? count : 0;
        } catch (e) {}
        return 0;
    }

    async function ensurePlaybarExpanded() {
        try {
            const hand = document.querySelector('.g-btmbar .hand, .m-playbar .hand');
            if (!hand) return false;
            const title = String(hand.getAttribute('title') || '').trim();
            if (title.includes('展开播放条')) {
                hand.click();
                await wait(300);
                return true;
            }
        } catch (e) {}
        return false;
    }

    function getVisibleQueuePanelState() {
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        const clearButton = Array.from(document.querySelectorAll('.m-playbar a, .m-playbar button, .m-layer a, .m-layer button'))
            .find((node) => {
                const text = String(node.textContent || '').trim();
                const title = String(node.getAttribute('title') || '').trim();
                const aria = String(node.getAttribute('aria-label') || '').trim();
                return text === '清除' || title === '清除' || aria === '清除';
            });
        return {
            queueCount: getQueueCount(),
            panelButtonVisible: !!(panelBtn && panelBtn.offsetParent !== null),
            clearButton,
        };
    }

    async function openQueuePanelBestEffort() {
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        if (!panelBtn) return null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            panelBtn.click();
            await wait(350 + attempt * 150);
            const state = getVisibleQueuePanelState();
            if (state.clearButton) {
                return state;
            }
        }
        return getVisibleQueuePanelState();
    }

    function ensureTargetSong(targetSongId) {
        if (!targetSongId) return;
        const currentHashSongId = extractSongId(window.location.hash);
        if (currentHashSongId !== String(targetSongId)) {
            window.location.hash = `#/song?id=${targetSongId}`;
        }
    }

    async function forcePlayTargetSong(targetSongId) {
        if (!targetSongId) return false;
        ensureTargetSong(targetSongId);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const currentHashSongId = extractSongId(window.location.hash);
            if (currentHashSongId !== String(targetSongId)) {
                ensureTargetSong(targetSongId);
                await wait(400);
                continue;
            }

            const clicked = triggerIframePlay();
            await wait(clicked ? 1200 : 600);
            if (getCurrentPlayingSongId() === String(targetSongId)) {
                return true;
            }
        }
        return false;
    }

    async function clearPlayQueueBestEffort() {
        await ensurePlaybarExpanded();
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        if (!panelBtn) return false;
        const queueCount = getQueueCount();
        if (queueCount <= 1) return false;

        const clearKeywords = ['清空', '清除', '删除全部', '清空列表', 'Clear'];
        const selectors = [
            '.m-playbar .listhdc a',
            '.m-playbar .listhdc .clear',
            '.m-playbar .listbd a',
            '.m-playbar .listlyric a',
            '.m-playbar a',
            '.m-playbar button',
            '.m-layer a',
            '.m-layer button',
        ];

        const findClearButton = () => {
            const exactMatches = [];
            for (const selector of selectors) {
                const nodes = document.querySelectorAll(selector);
                for (const node of nodes) {
                    const text = String(node.textContent || '').trim();
                    const title = String(node.getAttribute('title') || '').trim();
                    const aria = String(node.getAttribute('aria-label') || '').trim();
                    if (text === '清除' || title === '清除' || aria === '清除') {
                        exactMatches.push(node);
                        continue;
                    }
                    if (clearKeywords.some((keyword) => text.includes(keyword) || title.includes(keyword) || aria.includes(keyword))) {
                        exactMatches.push(node);
                    }
                }
            }
            return exactMatches[0] || null;
        };

        try {
            let state = await openQueuePanelBestEffort();
            let clearBtn = state && state.clearButton ? state.clearButton : findClearButton();
            if (!clearBtn) return false;

            clearBtn.click();
            await wait(500);

            const confirmBtn = Array.from(document.querySelectorAll('.m-layer a, .m-layer button, .z-show a, .z-show button'))
                .find((node) => {
                    const text = String(node.textContent || '').trim();
                    return /确定|确认|清空|是/.test(text);
                });
            if (confirmBtn) {
                confirmBtn.click();
                await wait(500);
            }
            const finalCount = getQueueCount();
            return finalCount <= 1;
        } catch (e) {
            return false;
        } finally {
            try {
                panelBtn.click();
            } catch (e) {}
        }
    }

    function formatTime(ms) { if (isNaN(ms) || ms <= 0) return "00:00"; const s = Math.floor(ms / 1000); return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function normalizeVersion(value) {
        const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
        return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
    }
    function compareVersions(left, right) {
        const a = normalizeVersion(left).split('.').map(n => Number(n || 0));
        const b = normalizeVersion(right).split('.').map(n => Number(n || 0));
        for (let i = 0; i < 3; i += 1) {
            const delta = (a[i] || 0) - (b[i] || 0);
            if (delta !== 0) return delta > 0 ? 1 : -1;
        }
        return 0;
    }
    function getUpdateUrl() {
        return (authConfig && authConfig.updateUrl) || UPDATE_FALLBACK_URL;
    }

    function showUpdateButton(label = '更新脚本') {
        const updateButton = document.getElementById('update-script-btn');
        if (!updateButton) return;
        updateButton.innerText = label;
        updateButton.style.display = 'block';
    }
    function getErrorText(code) {
        if (code === 'banned') return '当前账号已被管理员封禁，互助与登录态已失效。';
        if (code === 'registration_required') return '当前账号尚未完成注册，请先完成开通流程。';
        if (code === 'invalid_or_expired_token') return '登录态已失效，请重新登录。';
        if (code === 'token_session_conflict') return '当前账号已在其他设备重新登录，当前页面登录态已失效。';
        if (code === 'tab_conflict') return '当前账号已经在另一个标签页运行，本页已停止服务。';
        if (code === 'client_upgrade_required') return '当前脚本版本过旧，请先更新到最新版本后再继续使用。';
        if (code === 'service_paused') return '北京时间每日 0:00-8:00 暂停互助，请 8:00 后再试。';
        if (code === 'service_d1_blocked') return 'D1 额度已触发保护阈值，服务已临时自动断流，请北京时间 8:00 后再试。';
        if (code === 'service_manual_blocked') return '服务已被管理员临时暂停，请稍后再试。';
        return code ? `发生错误：${code}` : '';
    }

    function getPayloadErrorText(payload, fallbackCode = '') {
        const errorCode = (payload && payload.error) || fallbackCode;
        return (payload && payload.message) || getErrorText(errorCode) || '访问受限';
    }

    function isApiErrorPayload(payload) {
        return !!(payload && typeof payload === 'object' && payload.error);
    }

    function isServicePauseError(code) {
        return code === 'service_paused' || code === 'service_d1_blocked' || code === 'service_manual_blocked';
    }

    function handleAccessError(code, messageOverride = '') {
        const text = messageOverride || getErrorText(code);
        stopHelper();
        clearStoredToken(code || 'unknown');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = text || '访问受限';
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text || '访问受限';
        }
        if (authSection) authSection.style.display = 'block';
        if (helperForm) helperForm.style.display = 'none';
        if (logoutLink) logoutLink.style.display = 'none';
    }

    function handleTabConflict() {
        stopHelper();
        GM_setValue(ERROR_KEY, 'tab_conflict');
        const text = getErrorText('tab_conflict');
        const token = GM_getValue(TOKEN_KEY, '');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = token ? `已登录，${text}` : text;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text;
        }
        if (authSection) authSection.style.display = token ? 'none' : 'block';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
    }

    function handleServicePaused(payload = null) {
        const errorCode = (payload && payload.error) || 'service_paused';
        const text = (payload && payload.message) || getErrorText(errorCode);
        stopHelper();
        GM_setValue(ERROR_KEY, errorCode);
        const token = GM_getValue(TOKEN_KEY, '');
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const logoutLink = document.getElementById('logout-link');
        if (loginStatus) loginStatus.innerText = token ? `已登录，${text}` : text;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = text;
        }
        if (authSection) authSection.style.display = token ? 'none' : 'block';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
    }

    function handleClaimFailure(result) {
        const payload = result && result.payload ? result.payload : null;
        const status = Number(result && result.status || 0);
        if (payload && (
            payload.error === 'service_paused'
            || payload.error === 'service_d1_blocked'
            || payload.error === 'service_manual_blocked'
        )) {
            handleServicePaused(payload);
            return;
        }
        if (payload && payload.error) {
            handleAccessError(payload.error, payload.message || '');
            return;
        }
        const message = status === 0 ? '服务器连接失败，请稍后重试。' : '登录失败，请稍后重试。';
        GM_setValue(ERROR_KEY, '');
        stopHelper();
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        if (loginStatus) loginStatus.innerText = message;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = message;
        }
    }

    function showUpgradeRequired(requiredVersion, latestVersion) {
        upgradeRequired = true;
        stopHelper();
        const loginStatus = document.getElementById('login-status');
        const helperInfo = document.getElementById('helper-info');
        const authSection = document.getElementById('auth-section');
        const helperForm = document.getElementById('helper-form');
        const loginButton = document.getElementById('login-linuxdo');
        const updateButton = document.getElementById('update-script-btn');
        const requiredText = normalizeVersion(requiredVersion) || (authConfig && authConfig.minSupportedVersion) || '';
        const latestText = normalizeVersion(latestVersion) || (authConfig && authConfig.latestVersion) || '';
        const title = requiredText
            ? `脚本版本过旧，最低支持版本为 v${requiredText}`
            : '脚本版本过旧，请先更新';
        const detail = latestText && latestText !== requiredText
            ? `当前最新版本：v${latestText}`
            : '';
        if (loginStatus) loginStatus.innerText = title;
        if (helperInfo) {
            helperInfo.style.display = 'block';
            helperInfo.innerText = `${title}${detail ? `\n${detail}` : ''}\n点击下方按钮安装最新版脚本。`;
        }
        if (authSection) authSection.style.display = 'block';
        if (helperForm) helperForm.style.display = 'none';
        if (loginButton) loginButton.style.display = 'none';
        if (updateButton) {
            updateButton.innerText = '立即更新脚本';
            updateButton.style.display = 'block';
        }
    }

    async function fetchSongDuration(songId) {
        try {
            const normalizedSongId = encodeURIComponent(String(songId || '').trim());
            const res = await fetch(`/api/song/detail/?ids=%5B${normalizedSongId}%5D`, { credentials: 'include' });
            const data = safeJSON(await res.text());
            const songs = Array.isArray(data && data.songs) ? data.songs : [];
            const song = songs.find(item => String(item && item.id ? item.id : '') === String(songId));
            const durationMs = Number(song && (song.dt || song.duration || 0));
            if (Number.isFinite(durationMs) && durationMs > 0) return Math.floor(durationMs);
        } catch (e) {}

        const currentSongId = extractSongId(window.location.hash);
        const { dur } = getProgress();
        if (currentSongId === String(songId) && dur > 0) return dur;
        return 0;
    }

    async function fetchAlbumTracks(albumId) {
        try {
            const res = await fetch(`/api/v1/album/${albumId}`, { credentials: 'include' });
            const data = safeJSON(await res.text());
            const songs = Array.isArray(data && data.songs) ? data.songs : [];
            return songs
                .map(song => {
                    const id = String(song && song.id ? song.id : '').trim();
                    const durationMs = Number(song && (song.dt || song.duration || 0));
                    if (!/^\d+$/.test(id) || !Number.isFinite(durationMs) || durationMs <= 0) {
                        return null;
                    }
                    return { id, durationMs: Math.floor(durationMs) };
                })
                .filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    async function fetchAlbumSongIds(albumId) {
        const tracks = await fetchAlbumTracks(albumId);
        return tracks.map(track => track.id);
    }

    function extractSongId(value) {
        const text = String(value || '');
        const match = text.match(/(?:song\?id=|\/song\?id=|id=)(\d+)/);
        return match ? match[1] : '';
    }

    function getAlbumSongIds() {
        const ids = new Set();
        try {
            const frame = document.getElementById('g_iframe');
            if (!frame || !frame.contentDocument) return [];
            const doc = frame.contentDocument;
            const selectors = [
                '.m-table a[href*="song?id="]',
                '.n-songtb a[href*="song?id="]',
                'a[href*="song?id="]',
                '[data-res-id][data-res-type="18"]'
            ];
            selectors.forEach(selector => {
                doc.querySelectorAll(selector).forEach(el => {
                    const fromHref = extractSongId(el.getAttribute('href'));
                    const fromData = /^\d+$/.test(String(el.getAttribute('data-res-id') || ''))
                        ? String(el.getAttribute('data-res-id'))
                        : '';
                    const songId = fromHref || fromData;
                    if (songId) ids.add(songId);
                });
            });
        } catch (e) {}
        return Array.from(ids);
    }

    async function resolveAlbumSongId(albumId) {
        const apiSongIds = await fetchAlbumSongIds(albumId);
        if (apiSongIds.length > 0) {
            return apiSongIds[Math.floor(Math.random() * apiSongIds.length)];
        }

        window.location.hash = `#/album?id=${albumId}`;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const songIds = getAlbumSongIds();
            if (songIds.length > 0) {
                return songIds[Math.floor(Math.random() * songIds.length)];
            }
            await wait(500);
        }
        return '';
    }

    async function resolveMusicMeta(musicId, musicType) {
        if (musicType === 'song') {
            const durationMs = await fetchSongDuration(musicId);
            return durationMs > 0 ? { durationMs } : null;
        }

        const tracks = await fetchAlbumTracks(musicId);
        return tracks.length > 0 ? { tracks } : null;
    }

    function initUI() {
        const token = GM_getValue(TOKEN_KEY, '');
        const params = new URLSearchParams(window.location.search);
        const hasPendingAuthRedirect = params.has('music_helper_ticket') || params.has('music_helper_error');
        const savedType = GM_getValue('myMusicType', 'song');
        const container = document.createElement('div');
        container.id = 'music-helper-container';
        container.innerHTML = `
            <div id="helper-toggle-btn">🎵</div>
            <div id="music-helper-panel">
                <div id="helper-header">
                    <span>🎵 互助面板 (${CURRENT_VERSION})</span>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <a id="logout-link" style="font-size:10px; color:#999; display:${token ? 'block' : 'none'}">退出</a>
                        <span id="min-btn" style="cursor:pointer; color:#999;">—</span>
                    </div>
                </div>
                <div id="helper-body">
                    <div id="login-status" style="font-size:12px; margin-bottom:8px; color:#666;">${token ? '检测登录中...' : '未登录'}</div>
                    <div id="auth-section" style="${token ? 'display:none' : 'display:block'}">
                        <button id="login-linuxdo" style="background:#000; color:#fff; width:100%; padding:8px; border:none; border-radius:4px; cursor:pointer;">登录 Linux.do</button>
                        <button id="update-script-btn" style="display:none; margin-top:8px; background:#d33; color:#fff; width:100%; padding:8px; border:none; border-radius:4px; cursor:pointer;">更新脚本</button>
                    </div>
                    <div id="helper-form" style="${token ? 'display:block' : 'display:none'}">
                        <div style="display:flex; margin-bottom:8px;">
                            <select id="my-music-type" style="padding:4px; border:1px solid #ccc; border-radius:4px 0 0 4px; background:#f9f9f9;">
                                <option value="song" ${savedType === 'song' ? 'selected' : ''}>单曲</option>
                                <option value="album" ${savedType === 'album' ? 'selected' : ''}>专辑</option>
                            </select>
                            <input type="text" id="my-music-id" placeholder="输入 ID" style="flex:1; padding:4px; border:1px solid #ccc; border-radius:0 4px 4px 0;" value="${GM_getValue('myMusicId', '')}">
                        </div>
                        <button id="toggle-helper" style="width:100%; padding:8px; background:#d33; color:#fff; border:none; border-radius:4px; cursor:pointer;">开启互助</button>
                    </div>
                    <div id="helper-info" style="display:none; white-space:pre-line; font-size:11px; margin-top:8px; padding:8px; border-radius:4px; background:#f0f7ff; border:1px solid #adc6ff; color:#1890ff; line-height:1.5;">就绪...</div>
                    <button id="manual-btn" style="display:none; width:100%; margin-top:8px; background:#d33; color:#fff; border:none; padding:8px; border-radius:4px; cursor:pointer; animation: blink 1s infinite;">点我激活播放</button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        GM_addStyle(`
            #music-helper-container { position: fixed; top: 100px; right: 20px; z-index: 1000000; font-family: sans-serif; user-select: none; }
            #music-helper-panel { background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); width: 220px; }
            #helper-header { background: #f5f5f5; padding: 10px; display: flex; justify-content: space-between; align-items: center; border-radius: 8px 8px 0 0; cursor: move; }
            #helper-body { padding: 12px; }
            #helper-toggle-btn { width: 44px; height: 44px; background: #d33; color: #fff; border-radius: 50%; display: none; align-items: center; justify-content: center; cursor: move; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        `);

        const drag = (el, h) => {
            let p1=0,p2=0,p3=0,p4=0;
            h.onmousedown = (e) => {
                isDragging=false; e.preventDefault(); p3=e.clientX; p4=e.clientY;
                document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};
                document.onmousemove=(e)=>{isDragging=true; p1=p3-e.clientX; p2=p4-e.clientY; p3=e.clientX; p4=e.clientY;
                el.style.top=(el.offsetTop-p2)+"px"; el.style.right=(window.innerWidth-(el.offsetLeft+el.offsetWidth)+p1)+"px"; el.style.left="auto";};
            };
        };
        drag(container, document.getElementById('helper-header'));
        drag(container, document.getElementById('helper-toggle-btn'));

        document.getElementById('login-linuxdo').onclick = async () => {
            GM_setValue(ERROR_KEY, '');
            if(!authConfig) await fetchConfig();
            if(authConfig && authConfig.loginUrl) window.location.href = authConfig.loginUrl;
        };
        document.getElementById('update-script-btn').onclick = () => { window.location.href = getUpdateUrl(); };
        document.getElementById('logout-link').onclick = async () => {
            await requestAPI('POST', '/auth/logout');
            releaseTabLock();
            clearStoredToken('');
            location.reload();
        };
        document.getElementById('toggle-helper').onclick = toggleHelper;
        document.getElementById('manual-btn').onclick = () => { triggerIframePlay(); document.getElementById('manual-btn').style.display='none'; };
        document.getElementById('min-btn').onclick = () => { document.getElementById('music-helper-panel').style.display='none'; document.getElementById('helper-toggle-btn').style.display='flex'; };
        document.getElementById('helper-toggle-btn').onclick = () => { if(!isDragging){ document.getElementById('music-helper-panel').style.display='block'; document.getElementById('helper-toggle-btn').style.display='none'; } };

        fetchConfig();
        if (token && ensureSingleTabLock()) refreshMe();
        const lastError = GM_getValue(ERROR_KEY, '');
        if (lastError && !hasPendingAuthRedirect) {
            if (lastError === 'service_paused' || lastError === 'service_d1_blocked' || lastError === 'service_manual_blocked') {
                handleServicePaused();
            } else if (lastError === 'tab_conflict') {
                handleTabConflict();
            } else {
                handleAccessError(lastError);
            }
        }
    }

    async function fetchConfig() {
        return new Promise(r => GM_xmlhttpRequest({
            method:'GET',
            url:`${API_BASE}/auth-config`,
            headers:{'X-Music-Helper-Version': CURRENT_VERSION},
            onload:res=>{
                const d = safeJSON(res.responseText);
                if(d && d.latestVersion && compareVersions(d.latestVersion, CURRENT_VERSION) > 0) {
                    const up = document.createElement('div');
                    up.innerHTML = `<div style="background:#fffbe6; border:1px solid #ffe58f; padding:8px; border-radius:4px; margin-bottom:8px; font-size:11px; color:#856404;">发现新版本 v${d.latestVersion}</div>`;
                    document.getElementById('helper-body').prepend(up);
                    showUpdateButton(`更新到 v${d.latestVersion}`);
                }
                authConfig = d;
                if (d && d.minSupportedVersion && compareVersions(CURRENT_VERSION, d.minSupportedVersion) < 0) {
                    showUpgradeRequired(d.minSupportedVersion, d.latestVersion);
                }
                r(d);
            },
            onerror:()=>r(null),
            ontimeout:()=>r(null)
        }));
    }

    function clearStoredToken(errorCode = '') {
        releaseTabLock();
        GM_setValue(TOKEN_KEY, '');
        GM_setValue(LEGACY_TOKEN_KEY, '');
        GM_setValue(ACCESS_EXPIRES_AT_KEY, '');
        GM_setValue(REFRESH_EXPIRES_AT_KEY, '');
        GM_setValue(ERROR_KEY, errorCode || '');
    }

    function storeSessionToken(payload) {
        if (!payload || !payload.token) return false;
        GM_setValue(TOKEN_KEY, payload.token);
        GM_setValue(LEGACY_TOKEN_KEY, '');
        GM_setValue(ACCESS_EXPIRES_AT_KEY, String(payload.access_expires_at || ''));
        GM_setValue(REFRESH_EXPIRES_AT_KEY, String(payload.refresh_expires_at || ''));
        GM_setValue(ERROR_KEY, '');
        startTabLockHeartbeat();
        return true;
    }

    function parseStoredTime(key) {
        const raw = String(GM_getValue(key, '') || '').trim();
        if (!raw) return 0;
        const unixMs = Date.parse(raw);
        return Number.isFinite(unixMs) ? unixMs : 0;
    }

    function tokenNeedsRefresh(force = false) {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) return false;
        if (force) return true;
        const now = Date.now();
        const expiresAt = parseStoredTime(ACCESS_EXPIRES_AT_KEY);
        return expiresAt > 0 && now >= expiresAt - TOKEN_REFRESH_SKEW_MS;
    }

    async function requestAPI(method, path, body = null, token = GM_getValue(TOKEN_KEY, '')) {
        return new Promise(r => GM_xmlhttpRequest({
            method, url:`${API_BASE}${path}`, headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','X-Music-Helper-Version': CURRENT_VERSION},
            data: body?JSON.stringify(body):null,
            onload: res => r({ status: res.status, payload: safeJSON(res.responseText) }),
            onerror:()=>r({ status: 0, payload: null }),
            ontimeout:()=>r({ status: 0, payload: null })
        }));
    }

    async function refreshAccessToken(force = false) {
        const token = GM_getValue(TOKEN_KEY, '');
        if (!token) return false;
        const refreshExpiresAt = parseStoredTime(REFRESH_EXPIRES_AT_KEY);
        if (refreshExpiresAt > 0 && Date.now() >= refreshExpiresAt - TOKEN_REFRESH_SKEW_MS) {
            clearStoredToken('invalid_or_expired_token');
            location.reload();
            return false;
        }
        if (!force && !tokenNeedsRefresh()) return true;
        if (refreshPromise) return refreshPromise;

        refreshPromise = (async () => {
            const result = await requestAPI('POST', '/auth/refresh', { token }, '');
            if (result.status === 200 && result.payload && result.payload.token) {
                storeSessionToken(result.payload);
                return true;
            }
            if (result.status === 503 && result.payload && (
                result.payload.error === 'service_paused'
                || result.payload.error === 'service_d1_blocked'
                || result.payload.error === 'service_manual_blocked'
            )) {
                handleServicePaused(result.payload);
                return false;
            }
            if (result.status === 403) {
                handleAccessError(
                    result.payload && result.payload.error ? result.payload.error : 'forbidden',
                    result.payload && result.payload.message ? result.payload.message : '',
                );
                return false;
            }
            clearStoredToken(result.payload && result.payload.error ? result.payload.error : 'invalid_or_expired_token');
            location.reload();
            return false;
        })();

        try {
            return await refreshPromise;
        } finally {
            refreshPromise = null;
        }
    }

    async function ensureFreshToken() {
        if (!ensureSingleTabLock()) return false;
        if (!tokenNeedsRefresh()) return true;
        return refreshAccessToken(true);
    }

    async function callAPI(method, path, body = null, allowRefreshRetry = true) {
        if (!await ensureFreshToken()) return null;
        const token = GM_getValue(TOKEN_KEY, '');
        const result = await requestAPI(method, path, body, token);
        const payload = result.payload;
        if(result.status===401){
            if (allowRefreshRetry && token && payload && payload.error === 'token_expired') {
                const refreshed = await refreshAccessToken(true);
                if (refreshed) {
                    return callAPI(method, path, body, false);
                }
                return null;
            }
            clearStoredToken(payload && payload.error ? payload.error : 'invalid_or_expired_token');
            location.reload();
            return null;
        }
        if(result.status===403){
            if (payload && payload.error === 'client_upgrade_required') {
                showUpgradeRequired(payload.minSupportedVersion, payload.latestVersion);
                return payload;
            }
            handleAccessError(
                payload && payload.error ? payload.error : 'forbidden',
                payload && payload.message ? payload.message : '',
            );
            return payload;
        }
        if (result.status === 503 && payload && (
            payload.error === 'service_paused'
            || payload.error === 'service_d1_blocked'
            || payload.error === 'service_manual_blocked'
        )) {
            handleServicePaused(payload);
            return payload;
        }
        if (result.status === 0) {
            return null;
        }
        GM_setValue(ERROR_KEY, '');
        return payload;
    }

    async function claimTicket(ticket) {
        return new Promise(r => GM_xmlhttpRequest({
            method:'POST',
            url:`${API_BASE}/auth/claim`,
            headers:{'Content-Type':'application/json','X-Music-Helper-Version': CURRENT_VERSION},
            data: JSON.stringify({ ticket }),
            onload: res => {
                const d = safeJSON(res.responseText);
                if (res.status === 403 && d && d.error === 'client_upgrade_required') {
                    showUpgradeRequired(d.minSupportedVersion, d.latestVersion);
                    r({ ok: false, status: res.status, payload: d });
                    return;
                }
                if (res.status === 200 && storeSessionToken(d)) {
                    r({ ok: true, status: res.status, payload: d });
                } else {
                    r({ ok: false, status: res.status, payload: d });
                }
            },
            onerror:()=>r({ ok: false, status: 0, payload: null }),
            ontimeout:()=>r({ ok: false, status: 0, payload: null })
        }));
    }

    async function refreshMe() {
        const d = await callAPI('GET', '/me');
        if (d && d.user) {
            document.getElementById('login-status').innerText = `已登录: ${d.user.displayName}`;
            updateParticipantInfo(d.participant);
        }
    }

    function updateParticipantInfo(participant) {
        if (!participant) return;
        const infoEl = document.getElementById('helper-info');
        const credits = Number(participant.credits || 0);
        const monthlyReceived = Number(participant.monthly_received_help_count || 0);
        const monthlyLimit = Number(participant.monthly_received_limit || 0);
        const monthlyLine = monthlyLimit > 0
            ? `本月已收到: ${monthlyReceived} / ${monthlyLimit}${participant.monthly_cap_reached ? '（已封顶）' : ''}`
            : '';
        if (!isHelperRunning) {
            infoEl.style.display = 'block';
            infoEl.innerText = `剩余可被互助额度: ${credits}${monthlyLine ? `\n${monthlyLine}` : ''}`;
        }
    }

    async function toggleHelper() {
        if (upgradeRequired) return;
        const mid = document.getElementById('my-music-id').value.trim();
        const mtp = document.getElementById('my-music-type').value;
        if(!mid) return;
        GM_setValue('myMusicId', mid); GM_setValue('myMusicType', mtp);
        if(isHelperRunning) stopHelper(); else await startHelper(mid, mtp);
    }

    function stopHelper() {
        isHelperRunning = false;
        activeJoinState = null;
        clearInterval(monitorTimer);
        clearInterval(joinTimer);
        const toggleButton = document.getElementById('toggle-helper');
        const helperInfo = document.getElementById('helper-info');
        if (toggleButton) {
            toggleButton.innerText = '开启互助';
            toggleButton.style.background = '#d33';
        }
        if (helperInfo) {
            helperInfo.innerText = '已停止本机互助播放；已保存的 ID 仍会按剩余额度被其他人互助。';
        }
    }

    async function startHelper(mid, mtp) {
        isHelperRunning = true;
        activeJoinState = { mid, mtp, musicMeta: null };
        document.getElementById('toggle-helper').innerText = '停止互助';
        document.getElementById('toggle-helper').style.background = '#666';
        document.getElementById('helper-info').style.display = 'block';
        document.getElementById('helper-info').innerText = '正在加入互助队列...';

        const joined = await joinSelf(activeJoinState);
        if (!joined) {
            stopHelper();
            document.getElementById('helper-info').innerText = '服务器连接失败，未能加入互助队列';
            return;
        }
        if (!joined.ok) {
            stopHelper();
            if (isApiErrorPayload(joined)) {
                if (!isServicePauseError(joined.error)) {
                    document.getElementById('helper-info').innerText = getPayloadErrorText(joined, 'join_failed');
                }
            } else {
                document.getElementById('helper-info').innerText = '服务器连接失败，未能加入互助队列';
            }
            return;
        }

        joinTimer = setInterval(() => {
            if (activeJoinState) joinSelf(activeJoinState);
        }, JOIN_REFRESH_INTERVAL_MS);
        playNext();
    }

    async function joinSelf(state) {
        if (!state) return false;
        if (!state.musicMeta) {
            state.musicMeta = await resolveMusicMeta(state.mid, state.mtp);
        }
        const payload = { musicId: `${state.mtp}:${state.mid}` };
        if (state.musicMeta) payload.musicMeta = state.musicMeta;
        const d = await callAPI('POST', '/join', payload);
        if(d && d.loginUser) document.getElementById('login-status').innerText = `已登录: ${d.loginUser}`;
        if(d && d.participant) updateParticipantInfo(d.participant);
        return d;
    }

    async function finishCurrentJob(jobId, playedMs, positionMs, durationMs) {
        if (!jobId) return null;
        return callAPI('POST', '/play/finish', { jobId, playedMs, positionMs, durationMs });
    }

    async function playNext() {
        if (!isHelperRunning) return;
        clearInterval(monitorTimer);
        const infoEl = document.getElementById('helper-info');
        const data = await callAPI('GET', '/next');
        if(!data) { infoEl.innerText = '服务器连接失败'; return; }
        if (isApiErrorPayload(data)) {
            if (!isServicePauseError(data.error)) {
                infoEl.innerText = getPayloadErrorText(data, 'next_failed');
            }
            return;
        }
        if (data.participant) updateParticipantInfo(data.participant);

        if (data.musicId) {
            const sourceMusicId = data.sourceMusicId || data.musicId;
            let [type, id] = data.musicId.includes(':') ? data.musicId.split(':') : ['song', data.musicId];
            const jobId = data.jobId;
            const creditCost = Number(data.creditCost || 1);
            const expectedDurationMs = Number(data.targetDurationMs || 0);
            try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
            if (type === 'album') {
                infoEl.innerText = `正在从专辑随机选歌...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;
                const randomSongId = await resolveAlbumSongId(id);
                if (!randomSongId) {
                    infoEl.innerText = '专辑歌曲读取失败，稍后重试';
                    setTimeout(playNext, 5000);
                    return;
                }
                type = 'song';
                id = randomSongId;
                infoEl.innerText = `已从专辑中随机选中一首歌\n正在跳转...`;
            } else {
                infoEl.innerText = `正在跳转...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;
            }

            const expectedSongId = String(id);
            ensureTargetSong(expectedSongId);
            await wait(600);
            await clearPlayQueueBestEffort();
            const forcePlayed = await forcePlayTargetSong(expectedSongId);
            if (!forcePlayed) {
                infoEl.innerText = `目标歌曲加载失败，准备重试...\n目标歌曲: ${expectedSongId}`;
                setTimeout(playNext, 3000);
                return;
            }
            let startTime = Date.now(), hasTriggered = false, finished = false;
            let prevCur = 0, prevDur = 0, prevTickAt = 0, localListenedMs = 0, suspiciousJumps = 0;
            let mismatchTicks = 0, lastRetargetAt = 0, retargeting = false;
            monitorTimer = setInterval(async () => {
                if (!isHelperRunning || finished) return;
                const { cur, dur, state } = getProgress();
                const now = Date.now();
                const elapsed = now - startTime;
                const currentHashSongId = extractSongId(window.location.hash);
                const currentPlayingSongId = getCurrentPlayingSongId();
                const hashMismatch = currentHashSongId && currentHashSongId !== expectedSongId;
                const playingSongMismatch = currentPlayingSongId && currentPlayingSongId !== expectedSongId;
                const durationMismatch = expectedDurationMs > 0
                    && dur > 0
                    && Math.abs(dur - expectedDurationMs) > Math.max(12000, expectedDurationMs * 0.12);

                if (hashMismatch || playingSongMismatch || (elapsed > 8000 && durationMismatch)) {
                    mismatchTicks += 1;
                    infoEl.innerText = `当前加载歌曲与任务不一致，正在重新跳转...\n目标歌曲: ${expectedSongId}\n预期时长: ${expectedDurationMs > 0 ? formatTime(expectedDurationMs) : '未知'}`;
                    if (!retargeting && now - lastRetargetAt > 4000) {
                        lastRetargetAt = now;
                        retargeting = true;
                        try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
                        const corrected = await forcePlayTargetSong(expectedSongId);
                        retargeting = false;
                        if (!corrected && mismatchTicks >= 6) {
                            finished = true;
                            clearInterval(monitorTimer);
                            setTimeout(playNext, 3000);
                            return;
                        }
                    }
                    if (mismatchTicks >= 12) {
                        finished = true;
                        clearInterval(monitorTimer);
                        setTimeout(playNext, 3000);
                    }
                    prevCur = 0;
                    prevDur = 0;
                    prevTickAt = 0;
                    localListenedMs = 0;
                    return;
                }

                mismatchTicks = 0;

                const playbackRate = getPlaybackRate();
                const playbackRateInvalid = state === 'play' && playbackRate > 1.05;
                const listenCeilingMs = Math.max(expectedDurationMs || 0, dur || 0);

                if (prevTickAt > 0) {
                    const wallDelta = Math.max(0, now - prevTickAt);
                    const allowedProgress = wallDelta * 1.5 + 3000;
                    if (cur >= prevCur) {
                        const progressDelta = cur - prevCur;
                        if (progressDelta > allowedProgress) {
                            suspiciousJumps += 1;
                        } else if (state === 'play' && !playbackRateInvalid) {
                            const validListenDelta = Math.max(0, Math.min(wallDelta, progressDelta));
                            localListenedMs += validListenDelta;
                        }
                    } else if (prevCur - cur > 15000) {
                        suspiciousJumps += 1;
                    }
                }

                if (listenCeilingMs > 0) {
                    localListenedMs = Math.min(localListenedMs, listenCeilingMs);
                }

                if (!hasTriggered && elapsed > 5000 && state !== 'play') hasTriggered = triggerIframePlay();
                if (dur > 0) {
                    document.getElementById('manual-btn').style.display = 'none';
                    const requiredListenMs = Number(data.requiredListenMs || Math.max(20000, Math.floor(dur * 0.75)));
                    const isAlbumSource = String(sourceMusicId).startsWith('album:');
                    const speedWarning = playbackRateInvalid ? '\n检测到倍速播放，请恢复 1x 后继续' : '';
                    const displayDurationMs = expectedDurationMs > 0 ? expectedDurationMs : dur;
                    const displayListenedMs = displayDurationMs > 0 ? Math.min(localListenedMs, displayDurationMs) : localListenedMs;
                    infoEl.innerText = `正在互助 [${isAlbumSource ? '专辑随机单曲' : '单曲'}]\n歌曲时长: ${formatTime(displayDurationMs)}\n当前进度: ${formatTime(cur)}\n有效播放: ${formatTime(displayListenedMs)} / ${formatTime(requiredListenMs)}\n本次完成可得额度: ${creditCost}${speedWarning}`;

                    const enoughSongListen = displayListenedMs >= requiredListenMs;
                    const songFinished = (cur >= dur - 2000 || (state === 'stop' && cur > 0))
                        && enoughSongListen
                        && suspiciousJumps <= 1
                        && !playbackRateInvalid;
                    if (songFinished) {
                        finished = true;
                        clearInterval(monitorTimer);
                        try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
                        const result = await finishCurrentJob(jobId, displayListenedMs, cur, dur);
                        if (result && result.participant) updateParticipantInfo(result.participant);
                        setTimeout(playNext, 2000);
                    }
                } else {
                    infoEl.innerText = `正在努力加载...`;
                    if (elapsed > 20000) document.getElementById('manual-btn').style.display = 'block';
                }
                prevCur = cur;
                prevDur = dur;
                prevTickAt = now;
            }, 1000);
        } else {
            infoEl.innerText = '暂无可互助目标，30s 后重试';
            setTimeout(playNext, 30000);
        }
    }

    function cleanLoginParams() {
        const url = new URL(window.location.href);
        url.searchParams.delete('music_helper_ticket');
        url.searchParams.delete('music_helper_error');
        window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }

    setTimeout(async () => {
        initUI();
        window.addEventListener('storage', (event) => {
            if (event.key !== TAB_LOCK_KEY) return;
            const lock = readTabLock();
            if (lock && lock.id !== TAB_INSTANCE_ID && GM_getValue(TOKEN_KEY, '')) {
                releaseTabLock();
                handleTabConflict();
            }
        });
        window.addEventListener('beforeunload', () => releaseTabLock());
        const params = new URLSearchParams(window.location.search);
        const ticket = params.get('music_helper_ticket');
        const loginError = params.get('music_helper_error');
        if (ticket) {
            GM_setValue(ERROR_KEY, '');
            const claimResult = await claimTicket(ticket);
            cleanLoginParams();
            if (claimResult && claimResult.ok) {
                const authSection = document.getElementById('auth-section');
                const helperForm = document.getElementById('helper-form');
                const logoutLink = document.getElementById('logout-link');
                if (authSection) authSection.style.display = 'none';
                if (helperForm) helperForm.style.display = 'block';
                if (logoutLink) logoutLink.style.display = 'block';
                await refreshMe();
            } else {
                handleClaimFailure(claimResult);
            }
        } else if (loginError) {
            GM_setValue(ERROR_KEY, loginError);
            cleanLoginParams();
            handleAccessError(loginError);
        }
    }, 1500);
})();
