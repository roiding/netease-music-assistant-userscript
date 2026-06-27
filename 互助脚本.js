// ==UserScript==
// @name         网易云音乐互助播放脚本
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  V3.0.0：使用自建 Cloudflare Worker + D1，Linux.do 仅用于首次身份绑定，互助次数可离线结算。
// @author       YourName
// @match        *://music.163.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function() {
    'use strict';
    if (window.self !== window.top) return;

    // 部署 Worker 后，把这里改成自己的 Worker API 地址，例如：
    // https://netease-music-helper.your-name.workers.dev/api
    const API_BASE = 'https://netease-music-helper.example.workers.dev/api';
    const CURRENT_VERSION = '3.0.0';
    const TOKEN_KEY = 'musicHelperToken';
    const LEGACY_TOKEN_KEY = 'linuxDoToken';

    let isHelperRunning = false;
    let monitorTimer = null;
    let joinTimer = null;
    let authConfig = null;
    let isDragging = false;

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

    function formatTime(ms) { if (isNaN(ms) || ms <= 0) return "00:00"; const s = Math.floor(ms / 1000); return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }

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
                if(res.status===401){
                    GM_setValue(TOKEN_KEY,'');
                    GM_setValue(LEGACY_TOKEN_KEY,'');
                    location.reload();
                    return;
                }
                r(safeJSON(res.responseText));
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
        if (!isHelperRunning) {
            infoEl.style.display = 'block';
            infoEl.innerText = `剩余可被互助次数: ${credits}\n已帮别人: ${participant.completed_help_count || 0} 次\n已收到互助: ${participant.received_help_count || 0} 次`;
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
        clearInterval(monitorTimer);
        clearInterval(joinTimer);
        document.getElementById('toggle-helper').innerText = '开启互助';
        document.getElementById('toggle-helper').style.background = '#d33';
        document.getElementById('helper-info').innerText = '已停止本机互助播放；已保存的 ID 仍会按剩余次数被其他人互助。';
    }

    async function startHelper(mid, mtp) {
        isHelperRunning = true;
        document.getElementById('toggle-helper').innerText = '停止互助';
        document.getElementById('toggle-helper').style.background = '#666';
        document.getElementById('helper-info').style.display = 'block';
        document.getElementById('helper-info').innerText = '正在加入互助队列...';

        const joined = await joinSelf(mid, mtp);
        if (!joined) {
            stopHelper();
            document.getElementById('helper-info').innerText = '服务器连接失败，未能加入互助队列';
            return;
        }

        joinTimer = setInterval(() => joinSelf(mid, mtp), 60000);
        playNext();
    }

    async function joinSelf(mid, mtp) {
        const d = await callAPI('POST', '/join', { musicId: `${mtp}:${mid}` });
        if(d && d.loginUser) document.getElementById('login-status').innerText = `已登录: ${d.loginUser}`;
        if(d && d.participant) updateParticipantInfo(d.participant);
        return !!(d && d.ok);
    }

    async function finishCurrentJob(jobId, playedMs) {
        if (!jobId) return null;
        return callAPI('POST', '/play/finish', { jobId, playedMs });
    }

    async function reportProgress(jobId, cur, dur, state) {
        if (!jobId || dur <= 0) return null;
        return callAPI('POST', '/play/progress', {
            jobId,
            positionMs: cur,
            durationMs: dur,
            state
        });
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
            let [type, id] = data.musicId.includes(':') ? data.musicId.split(':') : ['song', data.musicId];
            const jobId = data.jobId;
            infoEl.innerText = `正在跳转...\n目标: ${data.owner && data.owner.displayName ? data.owner.displayName : '互助用户'}`;
            try { const p = getSafePlayer(); if(p && p.stop) p.stop(); } catch(e) {}
            setTimeout(() => { window.location.hash = `#/${type}?id=${id}`; }, 200);
            let startTime = Date.now(), hasTriggered = false, finished = false;
            let lastReportedAt = 0, prevCur = 0, prevDur = 0, albumTrackSwitches = 0;
            monitorTimer = setInterval(async () => {
                if (!isHelperRunning || finished) return;
                const { cur, dur, state } = getProgress();
                const elapsed = Date.now() - startTime;
                const looksLikeTrackSwitch = type === 'album'
                    && prevDur > 0
                    && prevCur >= Math.max(prevDur - 5000, prevDur * 0.85)
                    && cur <= Math.min(15000, dur > 0 ? dur * 0.25 : 15000)
                    && state === 'play';

                if (looksLikeTrackSwitch) {
                    albumTrackSwitches += 1;
                }

                if (!hasTriggered && elapsed > 5000 && state !== 'play') hasTriggered = triggerIframePlay();
                if (dur > 0) {
                    document.getElementById('manual-btn').style.display = 'none';
                    if (Date.now() - lastReportedAt >= 5000 || looksLikeTrackSwitch) {
                        lastReportedAt = Date.now();
                        await reportProgress(jobId, cur, dur, state);
                    }

                    if (type === 'album') {
                        infoEl.innerText = `正在互助 [专辑]\n进度: ${formatTime(cur)} / ${formatTime(dur)}\n已切到下一首: ${albumTrackSwitches} 次`;
                    } else {
                        infoEl.innerText = `正在互助 [单曲]\n进度: ${formatTime(cur)} / ${formatTime(dur)}`;
                    }

                    const songFinished = cur >= dur - 2000 || (state === 'stop' && cur > 0);
                    const albumFinished = type === 'album' && albumTrackSwitches >= 1;
                    if ((type === 'song' && songFinished) || albumFinished) {
                        finished = true;
                        clearInterval(monitorTimer);
                        await reportProgress(jobId, cur, dur, state);
                        const result = await finishCurrentJob(jobId, cur);
                        if (result && result.participant) updateParticipantInfo(result.participant);
                        setTimeout(playNext, 2000);
                    }
                } else {
                    infoEl.innerText = `正在努力加载...`;
                    if (elapsed > 20000) document.getElementById('manual-btn').style.display = 'block';
                }
                prevCur = cur;
                prevDur = dur;
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
            cleanLoginParams();
        }
        initUI();
    }, 1500);
})();
