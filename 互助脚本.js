// ==UserScript==
// @name         网易云音乐互助播放脚本
// @namespace    http://tampermonkey.net/
// @version      3.2.0
// @description  V3.2.0：按歌曲时长预扣互助额度，专辑由后端随机选歌，增加月度封顶控制。
// @author       roiding
// @homepageURL  https://github.com/roiding/netease-music-assistant-userscript
// @supportURL   https://github.com/roiding/netease-music-assistant-userscript/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/互助脚本.js
// @updateURL    https://cdn.jsdelivr.net/gh/roiding/netease-music-assistant-userscript@main/互助脚本.js
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
    const CURRENT_VERSION = '3.2.0';
    const TOKEN_KEY = 'musicHelperToken';
    const LEGACY_TOKEN_KEY = 'linuxDoToken';
    const ERROR_KEY = 'musicHelperLastError';

    let isHelperRunning = false;
    let monitorTimer = null;
    let joinTimer = null;
    let authConfig = null;
    let isDragging = false;
    let activeJoinState = null;

    function safeJSON(text) { try { return JSON.parse(text); } catch (e) { return null; } }
    function getUnsafeWindow() { try { return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; } catch(e) { return window; } }
    function getSafePlayer() { try { const uw = getUnsafeWindow(); return window.player || uw.player || null; } catch(e) { return null; } }

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

    function formatTime(ms) { if (isNaN(ms) || ms <= 0) return "00:00"; const s = Math.floor(ms / 1000); return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getErrorText(code) {
        if (code === 'banned') return '当前账号已被管理员封禁，互助与登录态已失效。';
        if (code === 'registration_required') return '当前账号尚未完成注册，请先完成开通流程。';
        if (code === 'invalid_or_expired_token') return '登录态已失效，请重新登录。';
        return code ? `发生错误：${code}` : '';
    }

    function handleAccessError(code) {
        const text = getErrorText(code);
        stopHelper();
        GM_setValue(TOKEN_KEY, '');
        GM_setValue(LEGACY_TOKEN_KEY, '');
        GM_setValue(ERROR_KEY, code || 'unknown');
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
                    <div id="online-count" style="font-size:10px; color:#999; margin-top:8px; text-align:right;">在线人数: 0</div>
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
            if(!authConfig) await fetchConfig();
            if(authConfig && authConfig.loginUrl) window.location.href = authConfig.loginUrl;
        };
        document.getElementById('logout-link').onclick = async () => {
            await callAPI('POST', '/auth/logout');
            GM_setValue(TOKEN_KEY, '');
            GM_setValue(LEGACY_TOKEN_KEY, '');
            location.reload();
        };
        document.getElementById('toggle-helper').onclick = toggleHelper;
        document.getElementById('manual-btn').onclick = () => { triggerIframePlay(); document.getElementById('manual-btn').style.display='none'; };
        document.getElementById('min-btn').onclick = () => { document.getElementById('music-helper-panel').style.display='none'; document.getElementById('helper-toggle-btn').style.display='flex'; };
        document.getElementById('helper-toggle-btn').onclick = () => { if(!isDragging){ document.getElementById('music-helper-panel').style.display='block'; document.getElementById('helper-toggle-btn').style.display='none'; } };

        fetchConfig();
        if (token) refreshMe();
        const lastError = GM_getValue(ERROR_KEY, '');
        if (lastError) {
            handleAccessError(lastError);
        }
    }

    async function fetchConfig() {
        return new Promise(r => GM_xmlhttpRequest({
            method:'GET',
            url:`${API_BASE}/auth-config`,
            onload:res=>{
                const d = safeJSON(res.responseText);
                if(d && d.latestVersion && d.latestVersion !== CURRENT_VERSION) {
                    const up = document.createElement('div');
                    up.innerHTML = `<div style="background:#fffbe6; border:1px solid #ffe58f; padding:8px; border-radius:4px; margin-bottom:8px; font-size:11px; color:#856404;">发现新版本 v${d.latestVersion}</div>`;
                    document.getElementById('helper-body').prepend(up);
                }
                authConfig = d; r(d);
            },
            onerror:()=>r(null),
            ontimeout:()=>r(null)
        }));
    }

    async function callAPI(method, path, body = null) {
        const token = GM_getValue(TOKEN_KEY, '');
        return new Promise(r => GM_xmlhttpRequest({
            method, url:`${API_BASE}${path}`, headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
            data: body?JSON.stringify(body):null,
            onload: res=>{
                const payload = safeJSON(res.responseText);
                if(res.status===401){
                    GM_setValue(TOKEN_KEY,'');
                    GM_setValue(LEGACY_TOKEN_KEY,'');
                    GM_setValue(ERROR_KEY, payload && payload.error ? payload.error : 'invalid_or_expired_token');
                    location.reload();
                    return;
                }
                if(res.status===403){
                    handleAccessError(payload && payload.error ? payload.error : 'forbidden');
                    r(payload);
                    return;
                }
                GM_setValue(ERROR_KEY, '');
                r(payload);
            },
            onerror:()=>r(null),
            ontimeout:()=>r(null)
        }));
    }

    async function claimTicket(ticket) {
        return new Promise(r => GM_xmlhttpRequest({
            method:'POST',
            url:`${API_BASE}/auth/claim`,
            headers:{'Content-Type':'application/json'},
            data: JSON.stringify({ ticket }),
            onload: res => {
                const d = safeJSON(res.responseText);
                if(d && d.access_token){
                    GM_setValue(TOKEN_KEY,d.access_token);
                    GM_setValue(LEGACY_TOKEN_KEY,'');
                    r(true);
                } else {
                    r(false);
                }
            },
            onerror:()=>r(false),
            ontimeout:()=>r(false)
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
            infoEl.innerText = `剩余可被互助额度: ${credits}\n已帮别人: ${participant.completed_help_count || 0} 次\n累计收到互助: ${participant.received_help_count || 0} 次${monthlyLine ? `\n${monthlyLine}` : ''}`;
        }
    }

    async function toggleHelper() {
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
        document.getElementById('toggle-helper').innerText = '开启互助';
        document.getElementById('toggle-helper').style.background = '#d33';
        document.getElementById('helper-info').innerText = '已停止本机互助播放；已保存的 ID 仍会按剩余额度被其他人互助。';
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

        joinTimer = setInterval(() => {
            if (activeJoinState) joinSelf(activeJoinState);
        }, 60000);
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
        return !!(d && d.ok);
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
        document.getElementById('online-count').innerText = `在线人数: ${data.count || 0}`;
        if (data.participant) updateParticipantInfo(data.participant);

        if (data.musicId) {
            const sourceMusicId = data.sourceMusicId || data.musicId;
            let [type, id] = data.musicId.includes(':') ? data.musicId.split(':') : ['song', data.musicId];
            const jobId = data.jobId;
            const creditCost = Number(data.creditCost || 1);
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

            setTimeout(() => { window.location.hash = `#/song?id=${id}`; }, 200);
            let startTime = Date.now(), hasTriggered = false, finished = false;
            let prevCur = 0, prevDur = 0, prevTickAt = 0, localListenedMs = 0, suspiciousJumps = 0;
            monitorTimer = setInterval(async () => {
                if (!isHelperRunning || finished) return;
                const { cur, dur, state } = getProgress();
                const now = Date.now();
                const elapsed = now - startTime;

                if (prevTickAt > 0) {
                    const wallDelta = Math.max(0, now - prevTickAt);
                    const allowedProgress = wallDelta * 1.5 + 3000;
                    if (cur >= prevCur) {
                        const progressDelta = cur - prevCur;
                        if (progressDelta > allowedProgress) {
                            suspiciousJumps += 1;
                        }
                        localListenedMs += Math.max(0, Math.min(progressDelta, wallDelta + 3000));
                    } else if (prevCur - cur > 15000) {
                        suspiciousJumps += 1;
                    }
                }

                const playbackRate = getPlaybackRate();
                const playbackRateInvalid = state === 'play' && playbackRate > 1.05;

                if (!hasTriggered && elapsed > 5000 && state !== 'play') hasTriggered = triggerIframePlay();
                if (dur > 0) {
                    document.getElementById('manual-btn').style.display = 'none';
                    const requiredListenMs = Math.max(Number(data.requiredListenMs || 0), Math.max(20000, Math.floor(dur * 0.75)));
                    const isAlbumSource = String(sourceMusicId).startsWith('album:');
                    const speedWarning = playbackRateInvalid ? '\n检测到倍速播放，请恢复 1x 后继续' : '';
                    infoEl.innerText = `正在互助 [${isAlbumSource ? '专辑随机单曲' : '单曲'}]\n进度: ${formatTime(cur)} / ${formatTime(dur)}\n有效播放: ${formatTime(localListenedMs)} / ${formatTime(requiredListenMs)}\n本次消耗额度: ${creditCost}${speedWarning}`;

                    const enoughSongListen = localListenedMs >= requiredListenMs;
                    const songFinished = (cur >= dur - 2000 || (state === 'stop' && cur > 0))
                        && enoughSongListen
                        && suspiciousJumps <= 1
                        && !playbackRateInvalid;
                    if (songFinished) {
                        finished = true;
                        clearInterval(monitorTimer);
                        const result = await finishCurrentJob(jobId, localListenedMs, cur, dur);
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
        const params = new URLSearchParams(window.location.search);
        const ticket = params.get('music_helper_ticket');
        const loginError = params.get('music_helper_error');
        if (ticket) {
            await claimTicket(ticket);
            cleanLoginParams();
        } else if (loginError) {
            GM_setValue(ERROR_KEY, loginError);
            cleanLoginParams();
        }
        initUI();
    }, 1500);
})();
