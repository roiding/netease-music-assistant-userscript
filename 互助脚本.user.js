// ==UserScript==
// @name         网易云音乐互助播放脚本
// @namespace    http://tampermonkey.net/
// @version      3.7.1
// @description  V3.7.1：全新 Tab 面板，互助、钱包与账户分区展示。
// @author       Netease Music Helper
// @license      Copyright Netease Music Helper
// @match        *://music.163.com/*
// @match        *://linux.do/latest*
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
    const CURRENT_VERSION = '3.7.1';
    const UPDATE_FALLBACK_URL = 'https://greasyfork.org/scripts';
    const MIN_HELP_TRACK_DURATION_MS = 30 * 1000;
    const LINUXDO_PROBE_SOURCE = 'music-helper-linuxdo-probe';
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
    let economyState = null;
    let currentUserState = null;
    let currentMerchantCredential = null;

    const TAB_INSTANCE_ID = getOrCreateTabInstanceId();

    function safeJSON(text) { try { return JSON.parse(text); } catch (e) { return null; } }
    function getUnsafeWindow() { try { return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; } catch(e) { return window; } }
    function getSafePlayer() { try { const uw = getUnsafeWindow(); return window.player || uw.player || null; } catch(e) { return null; } }

    function normalizeProbeCallbackUrl(value) {
        try {
            const callback = new URL(String(value || '').trim());
            const serviceOrigin = new URL(API_BASE).origin;
            if (callback.protocol !== 'https:' || callback.origin !== serviceOrigin) return '';
            if (callback.pathname !== '/register/probe-callback') return '';
            if (callback.username || callback.password || callback.search || callback.hash) return '';
            return callback.toString();
        } catch (e) {
            return '';
        }
    }

    if (window.location.hostname === 'linux.do') {
        handleLinuxDoProbePage();
        return;
    }

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

    async function handleLinuxDoProbePage() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('music_helper_probe') !== '1') return;
        const probeToken = String(params.get('music_helper_probe_token') || '').trim();
        const username = String(params.get('music_helper_username') || '').trim();
        const callbackUrl = normalizeProbeCallbackUrl(params.get('music_helper_callback'));

        const relayResult = (payload) => {
            try {
                window.name = JSON.stringify({
                    source: LINUXDO_PROBE_SOURCE,
                    probeToken,
                    username,
                    ...payload,
                });
            } catch (error) {}
            if (callbackUrl) {
                window.location.href = callbackUrl;
            }
        };

        const showStatus = (text) => {
            try {
                const status = document.createElement('div');
                status.style.cssText = 'padding:24px;font:14px/1.6 sans-serif;color:#333;';
                status.textContent = String(text || '');
                document.body.replaceChildren(status);
            } catch (error) {}
        };

        if (!probeToken || !username) {
            relayResult({ ok: false, errorMessage: 'Linux.do 同步参数不完整，请返回注册页刷新后重试。' });
            showStatus('Linux.do 同步参数不完整，请返回注册页刷新后重试。');
            return;
        }
        if (!callbackUrl) {
            showStatus('缺少回传地址，请返回注册页刷新后重试。');
            return;
        }

        showStatus('正在读取 Linux.do 活跃度画像...');
        try {
            const response = await fetch(`/u/${encodeURIComponent(username)}/card.json`, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            });
            const rawText = await response.text();
            const payload = safeJSON(rawText);
            if (!response.ok || !payload || !payload.user) {
                relayResult({
                    ok: false,
                    status: response.status,
                    contentType: response.headers.get('content-type') || '',
                    bodyPreview: String(rawText || '').slice(0, 300),
                    errorMessage: response.status === 403
                        ? 'Linux.do 当前拒绝了画像读取，请确认本浏览器已经登录 Linux.do。'
                        : 'Linux.do 活跃度画像读取失败，请稍后重试。',
                });
                showStatus('Linux.do 活跃度画像读取失败，请返回注册页重试。');
                return;
            }

            relayResult({
                ok: true,
                status: response.status,
                contentType: response.headers.get('content-type') || '',
                cardPayload: payload,
            });
        } catch (error) {
            relayResult({
                ok: false,
                errorMessage: 'Linux.do 活跃度画像读取失败：' + String(error && error.message || error || 'request_failed'),
            });
            showStatus('Linux.do 活跃度画像读取失败，请返回注册页重试。');
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

            const pageIssue = detectTargetPageIssue(targetSongId);
            if (pageIssue) {
                return { ok: false, reason: pageIssue.reason, title: pageIssue.title || '' };
            }

            const clicked = triggerIframePlay();
            await wait(clicked ? 1200 : 600);
            if (getCurrentPlayingSongId() === String(targetSongId)) {
                return { ok: true };
            }
        }
        const timeoutIssue = detectTargetPageIssue(targetSongId);
        if (timeoutIssue) {
            return { ok: false, reason: timeoutIssue.reason, title: timeoutIssue.title || '' };
        }
        return { ok: false, reason: 'play_timeout' };
    }

    async function clearPlayQueueBestEffort(targetSongId = '') {
        await ensurePlaybarExpanded();
        const panelBtn = document.querySelector('.m-playbar a[data-action="panel"]');
        if (!panelBtn) return false;
        const queueCount = getQueueCount();
        const currentPlayingSongId = getCurrentPlayingSongId();
        const shouldForceClearSingle =
            !!targetSongId &&
            !!currentPlayingSongId &&
            currentPlayingSongId !== String(targetSongId);
        if (queueCount <= 0 && !shouldForceClearSingle) return false;

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
            if (!clearBtn) {
                if (shouldForceClearSingle) {
                    try {
                        const player = getSafePlayer();
                        if (player && typeof player.stop === 'function') {
                            player.stop();
                        }
                    } catch (e) {}
                }
                return false;
            }

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
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (char) => {
            if (char === '&') return '&amp;';
            if (char === '<') return '&lt;';
            if (char === '>') return '&gt;';
            if (char.charCodeAt(0) === 34) return '&quot;';
            return '&#39;';
        });
    }

    function showUpdateButton(label = '更新脚本') {
        const updateButton = document.getElementById('update-script-btn');
        const headerUpdateLink = document.getElementById('header-update-link');
        if (updateButton) {
            updateButton.innerText = label;
            updateButton.style.display = 'block';
        }
        if (headerUpdateLink) {
            headerUpdateLink.innerText = label;
            headerUpdateLink.style.display = 'block';
        }
    }
    function getErrorText(code) {
        if (code === 'banned') return '当前账号已被管理员封禁，互助与登录态已失效。';
        if (code === 'registration_required') return '当前账号尚未完成注册，请先完成开通流程。';
        if (code === 'helper_registration_required') return '当前是消费用户；开通 Helper 后才能帮助他人并赚取 credit 或 rcredit。';
        if (code === 'invalid_or_expired_token') return '登录态已失效，请重新登录。';
        if (code === 'token_session_conflict') return '当前账号已在其他设备重新登录，当前页面登录态已失效。';
        if (code === 'tab_conflict') return '当前账号已经在另一个标签页运行，本页已停止服务。';
        if (code === 'client_upgrade_required') return '当前脚本版本过旧，请先更新到最新版本后再继续使用。';
        if (code === 'song_too_short') return '当前歌曲时长不足 30 秒，不能用于互助。';
        if (code === 'join_target_required') return '请先提交一首可用于互助的歌曲或专辑。';
        if (code === 'missing_played_ms') return '播放器没有返回有效播放时长，本次任务会稍后重试。';
        if (code === 'service_paused') return '北京时间每日 0:00-8:00 暂停互助，请 8:00 后再试。';
        if (code === 'service_d1_blocked') return 'D1 额度已触发保护阈值，服务已临时自动断流，请北京时间 8:00 后再试。';
        if (code === 'service_manual_blocked') return '服务已被管理员临时暂停，请稍后再试。';
        if (code === 'helper_credit_held') return '你本月已达到被互助上限，且当前额度已达到留存上限，本月暂不再给你派发新的互助任务。';
        if (code === 'helper_credit_overflow') return '你的当前额度过高，系统暂时不会再给你派发新的互助任务。';
        if (code === 'pool_empty') return '当前没有可用的互助目标。';
        if (code === 'targets_out_of_credit') return '当前互助池里的目标额度已经耗尽。';
        if (code === 'targets_busy') return '当前可用目标都已有进行中的互助任务。';
        if (code === 'targets_monthly_capped') return '当前可用目标都已达到本月被互助上限。';
        if (code === 'targets_temporarily_unavailable') return '当前没有可立即分配的互助任务。';
        if (code === 'credit_topup_disabled') return 'LDC 充值 credit 暂未开放。';
        if (code === 'invalid_topup_amount') return '请输入有效的 LDC 充值金额。';
        if (code === 'invalid_topup_amount_precision') return 'LDC 充值金额最多支持两位小数。';
        if (code === 'topup_amount_out_of_range') return '充值金额不在当前允许范围内。';
        if (code === 'rcredit_redemption_disabled') return 'rcredit 兑换 LDC 暂未开放。';
        if (code === 'redemption_amount_too_small') return '兑换的 rcredit 数量低于最低要求。';
        if (code === 'redemption_net_amount_too_small') return '扣除手续费后的 LDC 金额低于最低要求。';
        if (code === 'redemption_already_pending') return '你已有一笔待处理的兑换申请。';
        if (code === 'insufficient_rcredits') return '可用 rcredit 不足。';
        if (code === 'merchant_credential_required') return '兑换前需要先绑定 EasyPay 收款应用。';
        if (code === 'merchant_credential_immutable') return 'EasyPay 收款应用已经绑定，不能自行修改；如需重置请联系管理员。';
        if (code === 'merchant_pid_already_bound') return '这个 EasyPay pid 已被其他 Helper 绑定。';
        if (code === 'invalid_merchant_pid') return 'EasyPay pid 格式不正确。';
        if (code === 'invalid_merchant_key') return 'EasyPay key 格式不正确。';
        if (code === 'invalid_merchant_credential') return '无法验证这组 EasyPay pid/key，请检查后重试。';
        return code ? `发生错误：${code}` : '';
    }

    function isJoinBlockingError(code) {
        return [
            'join_target_required',
            'song_too_short',
            'song_not_found',
            'song_unplayable',
            'album_not_found',
            'album_no_playable_tracks',
        ].includes(String(code || ''));
    }

    function getParticipantNoticeText(participant) {
        if (!participant || typeof participant !== 'object') return '';
        const issue = participant.music_issue;
        const notice = participant.music_notice;
        if (issue && issue.message) return issue.message;
        if (notice && notice.message) return notice.message;
        return '';
    }

    function isDisabledPlayTitle(title) {
        const text = String(title || '').trim();
        if (!text) return false;
        return /暂时无法使用|版权保护|无法播放|不可播放|仅限|地区/.test(text);
    }

    function detectTargetPageIssue(targetSongId = '') {
        try {
            const frame = document.getElementById('g_iframe');
            const doc = frame && frame.contentDocument;
            if (!doc) return null;

            const disabledPlay = doc.querySelector('.u-btni-play-dis');
            if (disabledPlay && isDisabledPlayTitle(disabledPlay.getAttribute('title') || disabledPlay.textContent || '')) {
                return {
                    reason: 'page_unplayable',
                    title: String(disabledPlay.getAttribute('title') || disabledPlay.textContent || '').trim(),
                };
            }

            const bodyText = String(doc.body && doc.body.innerText || '').replace(/\s+/g, ' ').trim();
            if (bodyText) {
                const notFoundPatterns = [
                    /页面不存在/,
                    /网页找不到/,
                    /资源不存在/,
                    /歌曲不存在/,
                    /专辑不存在/,
                    /内容不存在/,
                    /404/,
                ];
                if (notFoundPatterns.some((pattern) => pattern.test(bodyText))) {
                    return {
                        reason: 'page_not_found',
                        title: bodyText.slice(0, 120),
                    };
                }
            }

            const playButton = doc.querySelector('.u-btni-play, [data-res-action="play"], #playall, .u-btn2-2');
            const frameLocation = frame && frame.contentWindow && frame.contentWindow.location
                ? (frame.contentWindow.location.hash || frame.contentWindow.location.href || '')
                : '';
            const pageSongId = extractSongId(frameLocation) || extractSongId(window.location.hash);
            if (targetSongId && pageSongId === String(targetSongId) && !playButton) {
                return {
                    reason: 'page_not_found',
                    title: '目标页面没有可用播放入口',
                };
            }
        } catch (e) {}
        return null;
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

    function isCurrentUserHelper() {
        return !!(currentUserState && currentUserState.isRegistered);
    }

    function activateHelperTab(tabName, persist = true) {
        const nextTab = ['help', 'wallet', 'account'].includes(tabName) ? tabName : 'help';
        document.querySelectorAll('[data-helper-tab]').forEach((button) => {
            const active = button.dataset.helperTab === nextTab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('[data-helper-panel]').forEach((panel) => {
            panel.classList.toggle('active', panel.dataset.helperPanel === nextTab);
        });
        if (persist) GM_setValue('musicHelperActiveTab', nextTab);
    }

    function updatePrimaryAction() {
        const toggleButton = document.getElementById('toggle-helper');
        const registerButton = document.getElementById('helper-register-btn');
        if (toggleButton && !isHelperRunning) {
            toggleButton.innerText = isCurrentUserHelper() ? '开启互助' : '提交互助目标';
            toggleButton.style.background = '';
        }
        if (registerButton) {
            registerButton.style.display = currentUserState && !isCurrentUserHelper() ? 'block' : 'none';
        }
        updateAccountSummary();
    }

    function updateAccountSummary() {
        const summary = document.getElementById('account-summary');
        if (!summary) return;
        if (!currentUserState) {
            summary.innerText = '尚未读取到账户信息。';
            return;
        }
        const accountType = isCurrentUserHelper() ? 'Helper' : '消费用户';
        const permission = isCurrentUserHelper()
            ? '可以提交目标、接取助力任务并赚取 credit / rcredit。'
            : '可以提交目标和充值 credit；开通 Helper 后可接取助力任务。';
        summary.innerHTML = `
            <div class="helper-account-head"><strong>${escapeHtml(currentUserState.displayName)}</strong><span>${accountType}</span></div>
            <p>${permission}</p>
        `;
    }

    function handleHelperRegistrationRequired(payload = null) {
        stopHelper();
        if (currentUserState) currentUserState = { ...currentUserState, isRegistered: false };
        updatePrimaryAction();
        const infoEl = document.getElementById('helper-info');
        if (infoEl) {
            infoEl.style.display = 'block';
            infoEl.innerText = getPayloadErrorText(payload, 'helper_registration_required');
        }
        activateHelperTab('help');
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
        if (authSection) authSection.style.display = 'grid';
        if (helperForm) helperForm.style.display = 'none';
        if (logoutLink) logoutLink.style.display = 'none';
        activateHelperTab('help');
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
        if (authSection) authSection.style.display = token ? 'none' : 'grid';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
        activateHelperTab('help');
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
        if (authSection) authSection.style.display = token ? 'none' : 'grid';
        if (helperForm) helperForm.style.display = token ? 'block' : 'none';
        if (logoutLink) logoutLink.style.display = token ? 'block' : 'none';
        activateHelperTab('help');
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
        if (authSection) authSection.style.display = 'grid';
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
            const res = await fetch(`/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{ id: Number(songId) }]))}`, { credentials: 'include' });
            const data = safeJSON(await res.text());
            const songs = Array.isArray(data && data.songs) ? data.songs : [];
            const privileges = Array.isArray(data && data.privileges) ? data.privileges : [];
            const song = songs.find(item => String(item && item.id ? item.id : '') === String(songId));
            const privilege = privileges.find(item => String(item && item.id ? item.id : '') === String(songId));
            if (!song) return { durationMs: 0, issue: { code: 'song_not_found' } };
            const durationMs = Number(song && (song.dt || song.duration || 0));
            if (!Number.isFinite(durationMs) || durationMs <= 0) return { durationMs: 0, issue: { code: 'song_not_found' } };
            if (durationMs < MIN_HELP_TRACK_DURATION_MS) return { durationMs: 0, issue: { code: 'song_too_short' } };
            const blocked = !!(song.noCopyrightRcmd
                || (typeof song.resourceState === 'boolean' && song.resourceState === false)
                || (Number(song.st) < 0)
                || (privilege && Number(privilege.st) < 0)
                || (privilege && privilege.freeTrialPrivilege && Number(privilege.freeTrialPrivilege.cannotListenReason) > 0)
                || (privilege && privilege.message));
            if (blocked) {
                return { durationMs: 0, issue: { code: 'song_unplayable' } };
            }
            return { durationMs: Math.floor(durationMs) };
        } catch (e) {}

        const currentSongId = extractSongId(window.location.hash);
        const { dur } = getProgress();
        if (currentSongId === String(songId) && dur > 0) return { durationMs: dur };
        return { durationMs: 0 };
    }

    async function fetchAlbumTracks(albumId) {
        try {
            const res = await fetch(`/api/v1/album/${albumId}`, { credentials: 'include' });
            const data = safeJSON(await res.text());
            const songs = Array.isArray(data && data.songs) ? data.songs : [];
            if ((data && data.resourceState === false) || Number(data && data.code) === 404 || songs.length === 0) {
                return { tracks: [], issue: { code: 'album_not_found' } };
            }
            const tracks = songs
                .map(song => {
                    const id = String(song && song.id ? song.id : '').trim();
                    const durationMs = Number(song && (song.dt || song.duration || 0));
                    const privilege = song && song.privilege;
                    const blocked = !!(song && song.noCopyrightRcmd)
                        || (typeof (song && song.resourceState) === 'boolean' && song.resourceState === false)
                        || Number(song && song.st) < 0
                        || Number(privilege && privilege.st) < 0
                        || Number(privilege && privilege.freeTrialPrivilege && privilege.freeTrialPrivilege.cannotListenReason) > 0
                        || !!(privilege && privilege.message);
                    if (!/^\d+$/.test(id) || !Number.isFinite(durationMs) || durationMs < MIN_HELP_TRACK_DURATION_MS || blocked) {
                        return null;
                    }
                    return { id, durationMs: Math.floor(durationMs) };
                })
                .filter(Boolean);
            return tracks.length > 0 ? { tracks } : { tracks: [], issue: { code: 'album_no_playable_tracks' } };
        } catch (e) {
            return { tracks: [] };
        }
    }

    async function fetchAlbumSongIds(albumId) {
        const tracks = await fetchAlbumTracks(albumId);
        return Array.isArray(tracks && tracks.tracks) ? tracks.tracks.map(track => track.id) : [];
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
            const result = await fetchSongDuration(musicId);
            if (result && result.durationMs > 0) return { durationMs: result.durationMs };
            return result && result.issue ? { issue: result.issue } : null;
        }

        const result = await fetchAlbumTracks(musicId);
        if (result && Array.isArray(result.tracks) && result.tracks.length > 0) return { tracks: result.tracks };
        return result && result.issue ? { issue: result.issue } : null;
    }

    function initUI() {
        const token = GM_getValue(TOKEN_KEY, '');
        const params = new URLSearchParams(window.location.search);
        const hasPendingAuthRedirect = params.has('music_helper_ticket') || params.has('music_helper_error') || params.has('music_helper_topup_order');
        const savedType = GM_getValue('myMusicType', 'song');
        const savedTab = GM_getValue('musicHelperActiveTab', 'help');
        const container = document.createElement('div');
        container.id = 'music-helper-container';
        container.innerHTML = `
            <div id="helper-toggle-btn" title="打开互助面板">♪</div>
            <div id="music-helper-panel">
                <div id="helper-header">
                    <div class="helper-brand">
                        <span class="helper-brand-mark">♪</span>
                        <span><strong>网易云互助</strong><small>v${CURRENT_VERSION}</small></span>
                    </div>
                    <div class="helper-header-actions">
                        <a id="header-update-link" class="helper-update-link" style="display:none;">更新</a>
                        <button id="min-btn" class="helper-icon-btn" type="button" aria-label="最小化">—</button>
                    </div>
                </div>
                <div id="helper-body">
                    <div id="login-status" class="helper-session-status">${token ? '正在读取账户...' : '登录后即可提交互助目标'}</div>
                    <div id="auth-section" class="helper-auth-card" style="${token ? 'display:none' : 'display:grid'}">
                        <div class="helper-auth-icon">LD</div>
                        <div><strong>使用 Linux.do 账户</strong><p>登录后可提交目标、充值额度并查看钱包。</p></div>
                        <button id="login-linuxdo" class="helper-btn helper-btn-dark" type="button">登录 Linux.do</button>
                        <button id="update-script-btn" class="helper-btn helper-btn-danger" type="button" style="display:none;">更新脚本</button>
                    </div>
                    <div id="helper-form" style="${token ? 'display:block' : 'display:none'}">
                        <div class="helper-tabs" role="tablist" aria-label="互助面板功能">
                            <button type="button" data-helper-tab="help" role="tab"><span>▶</span>互助</button>
                            <button type="button" data-helper-tab="wallet" role="tab"><span>◈</span>钱包</button>
                            <button type="button" data-helper-tab="account" role="tab"><span>●</span>账户</button>
                        </div>

                        <section class="helper-tab-panel" data-helper-panel="help" role="tabpanel">
                            <div class="helper-section-heading"><strong>互助目标</strong><span>歌曲或专辑 ID</span></div>
                            <div class="helper-target-row">
                                <select id="my-music-type" aria-label="目标类型">
                                    <option value="song" ${savedType === 'song' ? 'selected' : ''}>单曲</option>
                                    <option value="album" ${savedType === 'album' ? 'selected' : ''}>专辑</option>
                                </select>
                                <input type="text" id="my-music-id" placeholder="输入网易云 ID" value="${escapeHtml(GM_getValue('myMusicId', ''))}">
                            </div>
                            <button id="toggle-helper" class="helper-btn helper-btn-primary" type="button">开启互助</button>
                            <div id="helper-info" class="helper-status-card" style="display:none;">就绪...</div>
                            <button id="manual-btn" class="helper-btn helper-btn-danger helper-manual-btn" type="button" style="display:none;">点我激活播放</button>
                        </section>

                        <section class="helper-tab-panel" data-helper-panel="wallet" role="tabpanel">
                            <div class="helper-section-heading"><strong>我的钱包</strong><span>LDC 与互助额度</span></div>
                            <div id="wallet-actions" style="display:none;">
                                <div id="wallet-summary" class="helper-balance-grid"></div>
                                <div class="helper-action-grid">
                                    <button id="credit-topup-btn" class="helper-btn helper-btn-blue" type="button" style="display:none;">LDC 充值</button>
                                    <button id="rcredit-redeem-btn" class="helper-btn helper-btn-purple" type="button" style="display:none;">兑换 LDC</button>
                                </div>
                            </div>
                            <div id="merchant-credential-section" class="helper-merchant-card" style="display:none;">
                                <div class="helper-card-title"><span>EasyPay 收款应用</span><span class="helper-lock-badge">一次绑定</span></div>
                                <div id="merchant-credential-summary" class="helper-card-copy"></div>
                                <div id="merchant-credential-form" class="helper-credential-form" style="display:none;">
                                    <input id="merchant-pid-input" type="text" autocomplete="off" placeholder="EasyPay pid">
                                    <input id="merchant-key-input" type="password" autocomplete="new-password" placeholder="EasyPay key">
                                    <button id="merchant-bind-btn" class="helper-btn helper-btn-teal" type="button">绑定收款应用</button>
                                </div>
                            </div>
                        </section>

                        <section class="helper-tab-panel" data-helper-panel="account" role="tabpanel">
                            <div class="helper-section-heading"><strong>账户</strong><span>身份与权限</span></div>
                            <div id="account-summary" class="helper-account-card">正在读取账户信息...</div>
                            <button id="helper-register-btn" class="helper-btn helper-btn-teal" type="button" style="display:none;">开通 Helper</button>
                            <button id="logout-link" class="helper-btn helper-btn-ghost" type="button" style="display:${token ? 'block' : 'none'}">退出当前账户</button>
                        </section>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(container);
        GM_addStyle(`
            #music-helper-container {
                --mh-red: #e5484d;
                --mh-red-dark: #c9363e;
                --mh-ink: #202124;
                --mh-muted: #777b82;
                --mh-line: #e9e9ec;
                --mh-soft: #f6f6f8;
                position: fixed;
                top: 92px;
                right: 20px;
                z-index: 1000000;
                color: var(--mh-ink);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 13px;
                user-select: none;
            }
            #music-helper-container * { box-sizing: border-box; }
            #music-helper-panel {
                width: 310px;
                overflow: hidden;
                border: 1px solid rgba(25, 25, 28, 0.1);
                border-radius: 16px;
                background: rgba(255, 255, 255, 0.98);
                box-shadow: 0 18px 55px rgba(22, 24, 29, 0.22), 0 2px 8px rgba(22, 24, 29, 0.08);
                backdrop-filter: blur(18px);
            }
            #helper-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 13px 14px;
                color: #fff;
                background: linear-gradient(135deg, #d9363e 0%, #e95a55 58%, #ee765f 100%);
                cursor: move;
            }
            .helper-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
            .helper-brand-mark {
                display: grid;
                width: 30px;
                height: 30px;
                place-items: center;
                border: 1px solid rgba(255,255,255,.34);
                border-radius: 10px;
                background: rgba(255,255,255,.15);
                font-size: 17px;
                font-weight: 800;
            }
            .helper-brand strong { display: block; font-size: 14px; line-height: 1.2; letter-spacing: .02em; }
            .helper-brand small { display: block; margin-top: 2px; color: rgba(255,255,255,.72); font-size: 10px; font-weight: 500; }
            .helper-header-actions { display: flex; align-items: center; gap: 7px; }
            .helper-update-link { color: #fff; font-size: 11px; cursor: pointer; text-decoration: none; }
            .helper-icon-btn {
                display: grid;
                width: 28px;
                height: 28px;
                padding: 0;
                place-items: center;
                border: 1px solid rgba(255,255,255,.28);
                border-radius: 9px;
                color: #fff;
                background: rgba(255,255,255,.12);
                cursor: pointer;
            }
            #helper-body { max-height: min(620px, calc(100vh - 130px)); overflow-y: auto; padding: 12px; }
            .helper-session-status {
                margin-bottom: 10px;
                overflow: hidden;
                color: var(--mh-muted);
                font-size: 11px;
                line-height: 1.4;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .helper-auth-card { gap: 10px; padding: 16px; border: 1px solid var(--mh-line); border-radius: 13px; background: linear-gradient(145deg, #fff, #fafafd); }
            .helper-auth-card > div:nth-child(2) { min-width: 0; }
            .helper-auth-card strong { font-size: 14px; }
            .helper-auth-card p { margin: 4px 0 0; color: var(--mh-muted); font-size: 11px; line-height: 1.5; }
            .helper-auth-icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 12px; color: #fff; background: #1e1f22; font-size: 12px; font-weight: 800; }
            .helper-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-bottom: 12px; padding: 4px; border-radius: 12px; background: var(--mh-soft); }
            .helper-tabs button {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                padding: 8px 5px;
                border: 0;
                border-radius: 9px;
                color: #74777d;
                background: transparent;
                font: inherit;
                font-size: 12px;
                cursor: pointer;
            }
            .helper-tabs button span { font-size: 9px; }
            .helper-tabs button.active { color: var(--mh-red-dark); background: #fff; box-shadow: 0 2px 8px rgba(31,33,38,.08); font-weight: 700; }
            .helper-tab-panel { display: none; gap: 10px; }
            .helper-tab-panel.active { display: grid; }
            .helper-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
            .helper-section-heading strong { font-size: 14px; }
            .helper-section-heading span { color: var(--mh-muted); font-size: 10px; }
            .helper-target-row { display: grid; grid-template-columns: 76px 1fr; }
            .helper-target-row select, .helper-target-row input, .helper-credential-form input {
                min-width: 0;
                padding: 9px 10px;
                border: 1px solid #dfe0e4;
                color: var(--mh-ink);
                background: #fff;
                font: inherit;
                outline: none;
                user-select: text;
            }
            .helper-target-row select { border-radius: 10px 0 0 10px; background: #fafafd; }
            .helper-target-row input { margin-left: -1px; border-radius: 0 10px 10px 0; }
            .helper-target-row input:focus, .helper-credential-form input:focus { position: relative; border-color: rgba(229,72,77,.65); box-shadow: 0 0 0 3px rgba(229,72,77,.1); }
            .helper-btn { width: 100%; padding: 9px 11px; border: 0; border-radius: 10px; color: #fff; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; transition: transform .12s ease, filter .12s ease; }
            .helper-btn:hover { filter: brightness(.97); }
            .helper-btn:active { transform: translateY(1px); }
            .helper-btn:disabled { cursor: wait; opacity: .58; }
            .helper-btn-primary, .helper-btn-danger { background: linear-gradient(135deg, var(--mh-red-dark), var(--mh-red)); }
            .helper-btn-dark { background: #202124; }
            .helper-btn-blue { background: #2979e8; }
            .helper-btn-purple { background: #7552c8; }
            .helper-btn-teal { background: #128276; }
            .helper-btn-ghost { color: #555960; border: 1px solid var(--mh-line); background: #fff; }
            .helper-status-card { padding: 10px 11px; border: 1px solid #dbe8f7; border-radius: 11px; color: #27608e; background: #f4f9ff; white-space: pre-line; font-size: 11px; line-height: 1.55; }
            .helper-manual-btn { animation: mh-pulse 1.4s ease-in-out infinite; }
            .helper-balance-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
            .helper-balance-card { padding: 12px; border: 1px solid var(--mh-line); border-radius: 12px; background: linear-gradient(145deg, #fff, #f8f8fa); }
            .helper-balance-card span { display: block; margin-bottom: 4px; color: var(--mh-muted); font-size: 10px; }
            .helper-balance-card strong { display: block; font-size: 20px; line-height: 1.1; }
            .helper-balance-card small { display: block; margin-top: 5px; color: #999ca2; font-size: 9px; }
            .helper-action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
            .helper-merchant-card, .helper-account-card { padding: 12px; border: 1px solid var(--mh-line); border-radius: 12px; background: #fafafd; }
            .helper-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; }
            .helper-lock-badge { padding: 3px 6px; border-radius: 999px; color: #8a6218; background: #fff1cc; font-size: 9px; font-weight: 700; }
            .helper-card-copy { margin-top: 7px; color: var(--mh-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
            .helper-credential-form { gap: 7px; margin-top: 9px; flex-direction: column; }
            .helper-credential-form input { width: 100%; border-radius: 9px; }
            .helper-account-card { color: #555960; line-height: 1.6; white-space: pre-line; }
            .helper-account-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .helper-account-head strong { color: var(--mh-ink); font-size: 14px; }
            .helper-account-head span { padding: 3px 7px; border-radius: 999px; color: var(--mh-red-dark); background: #feecee; font-size: 9px; font-weight: 700; }
            .helper-account-card p { margin: 8px 0 0; color: var(--mh-muted); font-size: 11px; line-height: 1.55; white-space: normal; }
            #helper-toggle-btn { display: none; width: 48px; height: 48px; align-items: center; justify-content: center; border-radius: 16px; color: #fff; background: linear-gradient(135deg, #d9363e, #ed6b5d); cursor: move; font-size: 22px; font-weight: 800; box-shadow: 0 12px 28px rgba(207,52,61,.35); }
            @keyframes mh-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(229,72,77,.12); } 50% { box-shadow: 0 0 0 5px rgba(229,72,77,.16); } }
            @media (max-width: 480px) {
                #music-helper-container { top: 64px; right: 12px; }
                #music-helper-panel { width: calc(100vw - 24px); }
                #helper-body { max-height: calc(100vh - 112px); }
            }
        `);

        const drag = (el, h) => {
            let p1=0,p2=0,p3=0,p4=0;
            h.onmousedown = (e) => {
                if (e.target.closest('a, button, input, select')) return;
                isDragging=false; e.preventDefault(); p3=e.clientX; p4=e.clientY;
                document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};
                document.onmousemove=(e)=>{isDragging=true; p1=p3-e.clientX; p2=p4-e.clientY; p3=e.clientX; p4=e.clientY;
                el.style.top=(el.offsetTop-p2)+"px"; el.style.right=(window.innerWidth-(el.offsetLeft+el.offsetWidth)+p1)+"px"; el.style.left="auto";};
            };
        };
        drag(container, document.getElementById('helper-header'));
        drag(container, document.getElementById('helper-toggle-btn'));

        document.querySelectorAll('[data-helper-tab]').forEach((button) => {
            button.onclick = () => activateHelperTab(button.dataset.helperTab);
        });
        activateHelperTab(savedTab, false);

        document.getElementById('login-linuxdo').onclick = async () => {
            GM_setValue(ERROR_KEY, '');
            if(!authConfig) await fetchConfig();
            if(authConfig && authConfig.loginUrl) window.location.href = authConfig.loginUrl;
        };
        document.getElementById('update-script-btn').onclick = () => { window.location.href = getUpdateUrl(); };
        document.getElementById('header-update-link').onclick = () => { window.location.href = getUpdateUrl(); };
        document.getElementById('logout-link').onclick = async () => {
            await requestAPI('POST', '/auth/logout');
            releaseTabLock();
            clearStoredToken('');
            location.reload();
        };
        document.getElementById('toggle-helper').onclick = toggleHelper;
        document.getElementById('helper-register-btn').onclick = startHelperRegistration;
        document.getElementById('credit-topup-btn').onclick = startCreditTopup;
        document.getElementById('rcredit-redeem-btn').onclick = startRcreditRedemption;
        document.getElementById('merchant-bind-btn').onclick = bindMerchantCredential;
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

    async function startHelperRegistration() {
        if (!authConfig) await fetchConfig();
        const target = authConfig && authConfig.helperRegisterLoginUrl;
        if (!target) {
            alert('暂时无法读取 Helper 开通入口，请稍后重试。');
            return;
        }
        window.location.href = target;
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
            if (payload && payload.error === 'helper_registration_required') {
                handleHelperRegistrationRequired(payload);
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
            currentUserState = d.user;
            const accountType = d.user.isRegistered ? 'Helper' : '消费用户';
            document.getElementById('login-status').innerText = `已登录: ${d.user.displayName} · ${accountType}`;
            economyState = d.economy || null;
            currentMerchantCredential = d.merchantCredential || { bound: false };
            updatePrimaryAction();
            updateParticipantInfo(d.participant);
            updateMerchantCredentialControls();
        }
    }

    function updateParticipantInfo(participant) {
        const infoEl = document.getElementById('helper-info');
        const state = participant || {};
        const credits = Number(state.credits || 0);
        const rcredits = Number(state.rcredits || 0);
        const reservedRcredits = Number(state.reserved_rcredits || 0);
        const monthlyReceived = Number(state.monthly_received_help_count || 0);
        const monthlyLimit = Number(state.monthly_received_limit || 0);
        const monthlyLine = monthlyLimit > 0
            ? `本月已收到: ${monthlyReceived} / ${monthlyLimit}${state.monthly_cap_reached ? '（已封顶）' : ''}`
            : '';
        const helperHoldLine = state.helper_credit_hold_active
            ? `当前额度留存上限: ${Number(state.helper_credit_hold_limit || 0)}（本月暂停接新任务）`
            : '';
        const helperDispatchPauseLine = state.helper_dispatch_credit_paused
            ? `当前接任务额度上限: ${Number(state.helper_dispatch_credit_limit || 0)}（已暂停接新任务）`
            : '';
        const rewardLine = state.rcredit_reward_active
            ? '本月已封顶：继续助力将赚取 rcredit'
            : '';
        const consumerLine = currentUserState && !isCurrentUserHelper()
            ? '消费用户可提交目标和充值 credit；开通 Helper 后才能助力他人并赚取奖励。'
            : '';
        const noticeText = getParticipantNoticeText(state);
        updateWalletControls(state);
        if (infoEl && !isHelperRunning) {
            infoEl.style.display = 'block';
            infoEl.innerText = `剩余可被互助额度: ${credits}\nrcredit: ${rcredits}${reservedRcredits > 0 ? `（兑换冻结 ${reservedRcredits}）` : ''}${monthlyLine ? `\n${monthlyLine}` : ''}${rewardLine ? `\n${rewardLine}` : ''}${helperHoldLine ? `\n${helperHoldLine}` : ''}${helperDispatchPauseLine ? `\n${helperDispatchPauseLine}` : ''}${consumerLine ? `\n${consumerLine}` : ''}${noticeText ? `\n${noticeText}` : ''}`;
        }
    }

    function updateWalletControls(participant) {
        const actions = document.getElementById('wallet-actions');
        const summary = document.getElementById('wallet-summary');
        const topupButton = document.getElementById('credit-topup-btn');
        const redeemButton = document.getElementById('rcredit-redeem-btn');
        if (!actions || !summary || !topupButton || !redeemButton) return;
        const topupEnabled = !!(economyState && economyState.topup && economyState.topup.enabled);
        const redemptionEnabled = !!(economyState && economyState.redemption && economyState.redemption.enabled);
        const rcredits = Number(participant && participant.rcredits || 0);
        const canRedeem = isCurrentUserHelper() && redemptionEnabled;
        actions.style.display = (topupEnabled || canRedeem || rcredits > 0) ? 'block' : 'none';
        topupButton.style.display = topupEnabled ? 'block' : 'none';
        redeemButton.style.display = canRedeem ? 'block' : 'none';
        const credits = Number(participant && participant.credits || 0);
        const reserved = Number(participant && participant.reserved_rcredits || 0);
        summary.innerHTML = `
            <div class="helper-balance-card"><span>credit</span><strong>${credits}</strong><small>用于获得互助</small></div>
            <div class="helper-balance-card"><span>rcredit</span><strong>${rcredits}</strong><small>${reserved > 0 ? `冻结 ${reserved}` : '可兑换 LDC'}</small></div>
        `;
    }

    function updateMerchantCredentialControls() {
        const section = document.getElementById('merchant-credential-section');
        const summary = document.getElementById('merchant-credential-summary');
        const form = document.getElementById('merchant-credential-form');
        if (!section || !summary || !form) return;
        const visible = isCurrentUserHelper()
            && !!(economyState && economyState.redemption && economyState.redemption.enabled);
        section.style.display = visible ? 'block' : 'none';
        if (!visible) return;
        if (currentMerchantCredential && currentMerchantCredential.bound) {
            summary.innerText = `EasyPay 已绑定\npid: ${currentMerchantCredential.pid}\nkey 指纹: ${currentMerchantCredential.keyFingerprint}`;
            summary.style.whiteSpace = 'pre-line';
            form.style.display = 'none';
        } else {
            summary.innerText = '绑定用于接收兑换 LDC 的 EasyPay 应用';
            summary.style.whiteSpace = 'normal';
            form.style.display = 'flex';
        }
    }

    async function bindMerchantCredential() {
        const pidInput = document.getElementById('merchant-pid-input');
        const keyInput = document.getElementById('merchant-key-input');
        const button = document.getElementById('merchant-bind-btn');
        const pid = String(pidInput && pidInput.value || '').trim();
        const key = String(keyInput && keyInput.value || '').trim();
        if (!pid || !key) return alert('请输入 EasyPay pid 和 key。');
        if (!window.confirm('绑定后不能自行修改。确认使用这组 EasyPay 应用接收兑换 LDC？')) return;
        button.disabled = true;
        const result = await callAPI('POST', '/wallet/merchant-credential', { pid, key });
        button.disabled = false;
        if (!result || isApiErrorPayload(result)) {
            return alert(getPayloadErrorText(result, 'invalid_merchant_credential'));
        }
        if (keyInput) keyInput.value = '';
        currentMerchantCredential = result.credential || { bound: false };
        updateMerchantCredentialControls();
        alert('EasyPay 收款应用已绑定。');
    }

    async function startCreditTopup() {
        const config = economyState && economyState.topup;
        if (!config || !config.enabled) return alert(getErrorText('credit_topup_disabled'));
        const amountLdc = window.prompt(
            `输入充值金额（${config.minAmountLdc}-${config.maxAmountLdc} LDC）\n当前比例：1 LDC = ${config.creditsPerLdc} credit`,
            config.minAmountLdc,
        );
        if (amountLdc === null) return;
        const amount = Number(amountLdc);
        if (!Number.isFinite(amount) || amount <= 0) return alert(getErrorText('invalid_topup_amount'));
        const estimatedCredits = Math.floor(amount * Number(config.creditsPerLdc || 0) * (10000 - Number(config.feeBps || 0)) / 10000);
        if (!window.confirm(`支付 ${amountLdc} LDC，预计到账 ${estimatedCredits} credit。继续吗？`)) return;
        const result = await callAPI('POST', '/wallet/topups', { amountLdc: String(amountLdc) });
        if (!result || isApiErrorPayload(result)) {
            return alert(getPayloadErrorText(result, 'payment_create_failed'));
        }
        if (!result.paymentUrl) return alert('订单已创建，但支付链接暂不可用，请稍后重试。');
        window.location.href = result.paymentUrl;
    }

    async function startRcreditRedemption() {
        const config = economyState && economyState.redemption;
        if (!config || !config.enabled) return alert(getErrorText('rcredit_redemption_disabled'));
        if (!currentMerchantCredential || !currentMerchantCredential.bound) {
            activateHelperTab('wallet');
            updateMerchantCredentialControls();
            return alert(getErrorText('merchant_credential_required'));
        }
        const rcredits = window.prompt(
            `输入兑换数量（最低 ${config.minRcredits} rcredit）\n当前比例：${config.rcreditsPerLdc} rcredit = 1 LDC`,
            String(config.minRcredits || ''),
        );
        if (rcredits === null) return;
        const amount = Math.floor(Number(rcredits));
        if (!Number.isSafeInteger(amount) || amount <= 0) return alert(getErrorText('redemption_amount_too_small'));
        const gross = amount / Number(config.rcreditsPerLdc || 1);
        const fee = gross * Number(config.feeBps || 0) / 10000 + Number(config.fixedFeeLdc || 0);
        const net = Math.floor(Math.max(0, gross - fee) * 100) / 100;
        if (!window.confirm(`将冻结 ${amount} rcredit，预计实收 ${net.toFixed(2)} LDC。提交后由管理员创建付款订单并完成支付，确认提交吗？`)) return;
        const result = await callAPI('POST', '/wallet/redemptions', { rcredits: amount });
        if (!result || isApiErrorPayload(result)) {
            return alert(getPayloadErrorText(result, 'rcredit_redemption_failed'));
        }
        alert(`兑换申请已进入管理员付款队列，已冻结 ${result.redemption.rcreditAmount} rcredit，预计收款 ${result.redemption.netAmountLdc} LDC。`);
        await refreshMe();
    }

    async function refreshReturnedTopup(orderNo) {
        if (!orderNo) return;
        if (!GM_getValue(TOKEN_KEY, '')) {
            cleanLoginParams();
            alert('支付已返回，请登录后查看 credit 到账状态。');
            return;
        }
        let result = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            result = await callAPI('GET', `/wallet/topups/${encodeURIComponent(orderNo)}`);
            if (result && result.order && result.order.status !== 'pending') break;
            await wait(2000);
        }
        cleanLoginParams();
        if (result && result.order && result.order.status === 'paid') {
            alert(`充值成功，${result.order.creditAmount} credit 已到账。`);
            await refreshMe();
        } else if (result && result.order) {
            alert(`充值订单当前状态：${result.order.status}。稍后可重新打开面板刷新。`);
        }
    }

    async function toggleHelper() {
        if (upgradeRequired) return;
        if (!currentUserState) {
            await refreshMe();
            if (!currentUserState) return;
        }
        const mid = document.getElementById('my-music-id').value.trim();
        const mtp = document.getElementById('my-music-type').value;
        if(!mid) return;
        GM_setValue('myMusicId', mid); GM_setValue('myMusicType', mtp);
        if (!isCurrentUserHelper()) {
            await submitConsumerTarget(mid, mtp);
            return;
        }
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
            toggleButton.innerText = isCurrentUserHelper() ? '开启互助' : '提交互助目标';
            toggleButton.style.background = '';
        }
        if (helperInfo) {
            helperInfo.innerText = '已停止本机互助播放；已保存的 ID 仍会按剩余额度被其他人互助。';
        }
    }

    async function submitConsumerTarget(mid, mtp) {
        const toggleButton = document.getElementById('toggle-helper');
        const infoEl = document.getElementById('helper-info');
        if (toggleButton) toggleButton.disabled = true;
        if (infoEl) {
            infoEl.style.display = 'block';
            infoEl.innerText = '正在提交互助目标...';
        }
        try {
            const joined = await joinSelf({ mid, mtp, musicMeta: null, musicMetaFetchedAt: 0 });
            if (!joined) {
                if (infoEl) infoEl.innerText = '服务器连接失败，未能提交互助目标。';
                return;
            }
            if (!joined.ok) {
                if (infoEl && isApiErrorPayload(joined) && !isServicePauseError(joined.error)) {
                    infoEl.innerText = getPayloadErrorText(joined, 'join_failed');
                }
                return;
            }
            if (infoEl) {
                const credits = Number(joined.participant && joined.participant.credits || 0);
                infoEl.innerText = `互助目标已保存。当前可被互助额度：${credits}。\n消费用户不会接收助力任务，也不会赚取 credit/rcredit。`;
            }
        } finally {
            if (toggleButton) toggleButton.disabled = false;
            updatePrimaryAction();
        }
    }

    async function startHelper(mid, mtp) {
        isHelperRunning = true;
        activeJoinState = { mid, mtp, musicMeta: null, musicMetaFetchedAt: 0 };
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
            if (!activeJoinState) return;
            joinSelf(activeJoinState).then((joined) => {
                if (joined && isApiErrorPayload(joined) && isJoinBlockingError(joined.error)) {
                    stopHelper();
                    document.getElementById('helper-info').innerText = getPayloadErrorText(joined, joined.error);
                }
            }).catch(() => {});
        }, JOIN_REFRESH_INTERVAL_MS);
        playNext();
    }

    async function joinSelf(state) {
        if (!state) return false;
        const shouldRefreshMusicMeta = !state.musicMeta
            || !Number.isFinite(Number(state.musicMetaFetchedAt || 0))
            || (Date.now() - Number(state.musicMetaFetchedAt || 0)) >= JOIN_REFRESH_INTERVAL_MS;
        if (shouldRefreshMusicMeta) {
            state.musicMeta = await resolveMusicMeta(state.mid, state.mtp);
            state.musicMetaFetchedAt = Date.now();
        }
        const payload = { musicId: `${state.mtp}:${state.mid}` };
        if (state.musicMeta) payload.musicMeta = state.musicMeta;
        if (state.musicMeta && state.musicMeta.issue) payload.musicIssue = state.musicMeta.issue;
        const d = await callAPI('POST', '/join', payload);
        if (d && d.user) {
            currentUserState = d.user;
            updatePrimaryAction();
        }
        if(d && d.loginUser) {
            document.getElementById('login-status').innerText = `已登录: ${d.loginUser} · ${isCurrentUserHelper() ? 'Helper' : '消费用户'}`;
        }
        if(d && d.participant) updateParticipantInfo(d.participant);
        return d;
    }

    async function reportPlayIssue(jobId, sourceMusicId, targetMusicId, reason, observedTitle = '') {
        if (!jobId) return null;
        return callAPI('POST', '/play/report-issue', {
            jobId,
            sourceMusicId,
            targetMusicId,
            reason,
            observedTitle,
        });
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
            if (data.participant) updateParticipantInfo(data.participant);
            if (data.error === 'helper_credit_held') {
                const retryAfterSeconds = Math.max(300, Number(data.retryAfterSeconds || 1800));
                infoEl.innerText = `${getPayloadErrorText(data, 'helper_credit_held')}\n${Math.ceil(retryAfterSeconds / 60)} 分钟后自动重试`;
                setTimeout(() => {
                    if (isHelperRunning) playNext();
                }, retryAfterSeconds * 1000);
                return;
            }
            if (data.error === 'helper_credit_overflow') {
                const retryAfterSeconds = Math.max(300, Number(data.retryAfterSeconds || 1800));
                infoEl.innerText = `${getPayloadErrorText(data, 'helper_credit_overflow')}\n${Math.ceil(retryAfterSeconds / 60)} 分钟后自动重试`;
                setTimeout(() => {
                    if (isHelperRunning) playNext();
                }, retryAfterSeconds * 1000);
                return;
            }
            if (isJoinBlockingError(data.error)) {
                stopHelper();
                infoEl.innerText = getPayloadErrorText(data, data.error);
                return;
            }
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
            const earnsRcredit = !!(data.participant && data.participant.rcredit_reward_active);
            const rcreditRate = Number(economyState && economyState.rewards && economyState.rewards.rcreditsPerCredit || 1);
            const rewardAmount = earnsRcredit ? Math.floor(creditCost * rcreditRate) : creditCost;
            const rewardLabel = earnsRcredit ? 'rcredit' : 'credit';
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
            await clearPlayQueueBestEffort(expectedSongId);
            const forcePlayed = await forcePlayTargetSong(expectedSongId);
            if (!forcePlayed || !forcePlayed.ok) {
                const issueReason = forcePlayed && forcePlayed.reason ? forcePlayed.reason : 'play_timeout';
                const issueTitle = forcePlayed && forcePlayed.title ? forcePlayed.title : '';
                if (issueReason === 'page_unplayable' || issueReason === 'page_not_found') {
                    const issueText = issueReason === 'page_not_found'
                        ? '目标歌曲页面无效，已上报服务器核查...'
                        : '目标歌曲当前不可播放，已上报服务器核查...';
                    infoEl.innerText = `${issueText}\n目标歌曲: ${expectedSongId}`;
                    const report = await reportPlayIssue(jobId, sourceMusicId, `song:${expectedSongId}`, issueReason, issueTitle);
                    if (report && report.participant) updateParticipantInfo(report.participant);
                    setTimeout(playNext, 1500);
                    return;
                }
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
                        if ((!corrected || !corrected.ok) && mismatchTicks >= 6) {
                            if (corrected && (corrected.reason === 'page_unplayable' || corrected.reason === 'page_not_found')) {
                                const correctedText = corrected.reason === 'page_not_found'
                                    ? '目标歌曲页面无效，已上报服务器核查...'
                                    : '目标歌曲当前不可播放，已上报服务器核查...';
                                infoEl.innerText = `${correctedText}\n目标歌曲: ${expectedSongId}`;
                                const report = await reportPlayIssue(jobId, sourceMusicId, `song:${expectedSongId}`, corrected.reason, corrected.title || '');
                                if (report && report.participant) updateParticipantInfo(report.participant);
                            }
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
                    infoEl.innerText = `正在互助 [${isAlbumSource ? '专辑随机单曲' : '单曲'}]\n歌曲时长: ${formatTime(displayDurationMs)}\n当前进度: ${formatTime(cur)}\n有效播放: ${formatTime(displayListenedMs)} / ${formatTime(requiredListenMs)}\n本次完成可得: ${rewardAmount} ${rewardLabel}${speedWarning}`;

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
            const noTaskText = data.message || getErrorText(data.reason || 'targets_temporarily_unavailable') || '暂无可互助目标';
            infoEl.innerText = `${noTaskText}\n30s 后重试`;
            setTimeout(playNext, 30000);
        }
    }

    function cleanLoginParams() {
        const url = new URL(window.location.href);
        url.searchParams.delete('music_helper_ticket');
        url.searchParams.delete('music_helper_error');
        url.searchParams.delete('music_helper_topup_order');
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
        const topupOrder = params.get('music_helper_topup_order');
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
        } else if (topupOrder) {
            await refreshReturnedTopup(topupOrder);
        }
    }, 1500);
})();
