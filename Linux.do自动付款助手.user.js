// ==UserScript==
// @name         Linux.do 自动付款助手 (网易云音乐互助管理)
// @namespace    https://roiding.dpdns.org/
// @version      1.0.7
// @description  网易云互助管理员独立脚本：后台同步管理凭据，Credit 页面同源核验登录态、管理本地支付安全码并核验待付订单后付款。
// @author       Netease Music Helper
// @match        https://credit.linux.do/*
// @match        https://roiding.dpdns.org/admin*
// @match        https://netease.ran-ding.gq/admin*
// @connect      roiding.dpdns.org
// @connect      netease.ran-ding.gq
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';
    if (window.self !== window.top) return;

    const STORAGE_KEY_PAY_KEY = 'music_helper_auto_pay_key';
    const STORAGE_KEY_ADMIN_TOKEN = 'music_helper_admin_token';
    const STORAGE_KEY_API_BASE = 'music_helper_admin_api_base';
    const STORAGE_KEY_EXPECTED_UID = 'music_helper_expected_admin_uid';

    const DEFAULT_API_BASE = 'https://roiding.dpdns.org';
    const DEFAULT_ADMIN_UID = '207121';
    const CREDIT_ORIGIN = 'https://credit.linux.do';
    const isCreditPage = location.origin === CREDIT_ORIGIN;
    const SERVICE_ORIGINS = [DEFAULT_API_BASE, 'https://netease.ran-ding.gq'];
    let assistantElements = null;
    let cachedLinuxDoUser = null;
    let pendingTasks = [];
    let isProcessing = false;
    let taskError = '';
    let tasksLoading = false;
    let loginState = { kind: 'idle', message: '' };
    let linuxDoUserRequest = null;
    const unavailablePaymentOrders = new Map();

    function getApiBase() {
        const stored = String(GM_getValue(STORAGE_KEY_API_BASE, '') || DEFAULT_API_BASE).replace(/\/+$/, '');
        if (!SERVICE_ORIGINS.includes(stored)) throw new Error('后台地址不在允许的服务域名中');
        return stored;
    }
    function setApiBase(val) {
        const origin = String(val || '').trim().replace(/\/+$/, '');
        if (!SERVICE_ORIGINS.includes(origin)) throw new Error('后台地址不在允许的服务域名中');
        GM_setValue(STORAGE_KEY_API_BASE, origin);
    }
    function getAdminToken() {
        return GM_getValue(STORAGE_KEY_ADMIN_TOKEN, '');
    }
    function setAdminToken(val) {
        GM_setValue(STORAGE_KEY_ADMIN_TOKEN, String(val || '').trim());
    }
    function getPayKey() {
        return GM_getValue(STORAGE_KEY_PAY_KEY, '');
    }
    function setPayKey(val) {
        GM_setValue(STORAGE_KEY_PAY_KEY, String(val || '').trim());
    }
    function getExpectedAdminUid() {
        return GM_getValue(STORAGE_KEY_EXPECTED_UID, '') || DEFAULT_ADMIN_UID;
    }
    function setExpectedAdminUid(val) {
        GM_setValue(STORAGE_KEY_EXPECTED_UID, String(val || '').trim());
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[character]));
    }

    function amountMilli(value) {
        const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(value ?? ''));
        if (!match) throw new Error('金额格式无效，已停止付款');
        const amount = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 10) throw new Error('金额无效，已停止付款');
        return amount;
    }

    function httpXmlRequest(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: 15000,
                ...options,
                onload: (res) => resolve(res),
                onerror: (err) => reject(new Error('网络请求异常: ' + (err.statusText || 'error'))),
                ontimeout: () => reject(new Error('网络请求超时')),
            });
        });
    }

    async function apiRequest(method, path, body = undefined, headers = {}) {
        const url = `${getApiBase()}/api${path.startsWith('/') ? path : '/' + path}`;
        const token = getAdminToken();
        const reqHeaders = {
            'Content-Type': 'application/json',
            ...headers,
        };
        if (token) {
            reqHeaders.Authorization = `Bearer ${token}`;
        }
        const res = await httpXmlRequest({
            method,
            url,
            headers: reqHeaders,
            data: body !== undefined ? JSON.stringify(body) : undefined,
            withCredentials: true,
        });
        let data;
        try {
            data = JSON.parse(res.responseText);
        } catch {
            throw new Error('后台未返回有效 JSON，请检查登录态或验证页面');
        }
        if (res.status < 200 || res.status >= 300 || !data || data.error) {
            const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            err.payload = data;
            throw err;
        }
        return data;
    }

    async function creditRequest(method, path, body = undefined) {
        if (!isCreditPage) throw new Error('请在 credit.linux.do 页面打开助手后核验登录并付款');
        const target = new URL(path, CREDIT_ORIGIN);
        const allowed = method === 'GET'
            ? ['/api/v1/oauth/user-info', '/api/v1/merchant/payment/order'].includes(target.pathname)
            : method === 'POST' && target.pathname === '/api/v1/merchant/payment';
        if (target.origin !== CREDIT_ORIGIN || !allowed) throw new Error('不允许的 Credit 请求');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(target.href, {
                method, credentials: 'include', mode: 'same-origin', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: controller.signal,
            });
            return { status: response.status, responseText: await response.text() };
        } catch {
            throw new Error(controller.signal.aborted
                ? 'Credit 同源请求超时，无法确认结果；请刷新状态，勿直接重复付款'
                : 'Credit 同源请求失败或被重定向，不能据此认定未登录；请确认官网可正常访问后刷新');
        } finally {
            clearTimeout(timer);
        }
    }

    function paymentHttpError(response) {
        let data = null;
        try { data = JSON.parse(response.responseText); } catch {}
        const message = typeof data?.error_msg === 'string' ? data.error_msg : '';
        const prefix = `支付接口返回错误: HTTP ${response.status}`;
        if (response.status === 403 && /csrf/i.test(message)) {
            return `${prefix}（CSRF 校验失败，请确认当前页面运行助手 v1.0.7 或更新版本）；未自动重试，请先查原单`;
        }
        if (response.status === 403 && /^\s*(?:<!doctype\s+html|<html)/i.test(response.responseText || '')) {
            return `${prefix}（官网返回验证页面，请在 Credit 官网完成验证后刷新）；未自动重试，请先查原单`;
        }
        if (response.status === 401) return `${prefix}（登录会话失效，请重新登录 Credit）；未自动重试，请先查原单`;
        if (response.status === 403) return `${prefix}（官网拒绝请求，可能涉及权限或风控，不能据此认定未支付）；未自动重试，请先查原单`;
        return `${prefix}；付款结果未确认，未自动重试，请先查原单`;
    }

    const isAdminPage = location.hostname === 'roiding.dpdns.org' || location.hostname === 'netease.ran-ding.gq';

    const adminSessionReady = isAdminPage ? syncAdminSessionOnPage() : Promise.resolve();

    GM_registerMenuCommand('设置 Linux.do 支付安全码（仅本机）', () => {
        promptConfigurePayKey();
    });
    GM_registerMenuCommand('配置网易云后台服务与凭证', () => {
        promptConfigureBackend();
    });
    GM_registerMenuCommand('清除本机支付码与管理凭据', () => {
        GM_deleteValue(STORAGE_KEY_PAY_KEY);
        GM_deleteValue(STORAGE_KEY_ADMIN_TOKEN);
        pendingTasks = [];
        taskError = '本机凭据已清除，请重新登录后台。';
        updateUIState();
    });

    injectAssistantUI();

    async function syncAdminSessionOnPage() {
        try {
            const currentOrigin = location.origin;
            setApiBase(currentOrigin);
            const tokenRes = await fetch(`${currentOrigin}/api/admin/session-token`, {
                credentials: 'include',
            });
            if (tokenRes.ok) {
                const data = await tokenRes.json();
                if (data && data.adminToken) {
                    setAdminToken(data.adminToken);
                    if (data.admin && data.admin.providerUserId) {
                        setExpectedAdminUid(data.admin.providerUserId);
                    }
                    console.log('[自动付款助手] 管理员会话已自动同步至本地存储，有效至:', data.expiresAt);
                }
            }
        } catch (e) {
            console.warn('[自动付款助手] 无法自动同步管理员会话:', e);
        }
    }

    function promptConfigurePayKey() {
        const input = window.prompt(
            '输入 6 位 Linux.do 支付安全码：\n仅存篡改猴存储，付款时仅发给 credit.linux.do，不传互助后台。不要同步或分享此脚本的存储数据。',
            ''
        );
        if (input === null) return;
        const trimmed = String(input || '').trim();
        if (!/^\d{6}$/.test(trimmed)) {
            alert('支付安全码必须严格为 6 位数字，已取消保存。');
            return;
        }
        setPayKey(trimmed);
        alert('支付安全码已安全保存在本机。');
        updateUIState();
    }

    function promptConfigureBackend() {
        const currentBase = getApiBase();
        const base = window.prompt('网易云后台 API 域名：', currentBase) || '';
        if (base.trim()) setApiBase(base.trim());

        const token = window.prompt('管理员 Token (在管理页会自动刷新)：', '') || '';
        if (token.trim()) setAdminToken(token.trim());

        alert('后台连接配置已更新。');
        updateUIState();
    }

    function injectAssistantUI() {
        const style = document.createElement('style');
        style.textContent = `
            #ldc-pay-assistant-bubble {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 16px;
                background: linear-gradient(135deg, #0f766e, #115e59);
                color: #f8fafc;
                border: 1px solid #14b8a6;
                border-radius: 9999px;
                box-shadow: 0 10px 25px -5px rgba(0,0,0,0.35);
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                font-weight: 600;
                user-select: none;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            #ldc-pay-assistant-bubble:hover {
                transform: translateY(-2px);
                box-shadow: 0 14px 28px -5px rgba(0,0,0,0.45);
            }
            #ldc-pay-assistant-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 18px;
                height: 18px;
                padding: 0 6px;
                border-radius: 9999px;
                background: #ef4444;
                color: white;
                font-size: 11px;
                font-weight: 700;
            }
            #ldc-pay-assistant-modal {
                position: fixed;
                bottom: 74px;
                right: 24px;
                width: 440px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 100px);
                z-index: 999999;
                background: #ffffff;
                color: #0f172a;
                border: 1px solid #cbd5e1;
                border-radius: 16px;
                box-shadow: 0 20px 40px -10px rgba(0,0,0,0.25);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                display: none;
                flex-direction: column;
                overflow: hidden;
            }
            #ldc-pay-assistant-modal.open {
                display: flex;
            }
            .ldc-asst-header {
                padding: 14px 18px;
                background: #f8fafc;
                border-bottom: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .ldc-asst-header h3 {
                margin: 0;
                font-size: 15px;
                font-weight: 700;
                display: flex;
                align-items: center;
                gap: 6px;
                color: #0f172a;
            }
            .ldc-asst-close {
                background: none;
                border: none;
                font-size: 18px;
                color: #64748b;
                cursor: pointer;
                padding: 4px;
                line-height: 1;
            }
            .ldc-asst-body {
                padding: 16px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 12px;
                font-size: 13px;
            }
            .ldc-asst-card {
                padding: 12px;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                background: #f8fafc;
            }
            .ldc-asst-card-title {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: #64748b;
                margin-bottom: 6px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .ldc-asst-user-info {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .ldc-asst-avatar {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: #cbd5e1;
            }
            .ldc-asst-task-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                border-radius: 8px;
                background: white;
                border: 1px solid #e2e8f0;
                margin-bottom: 6px;
            }
            .ldc-asst-task-user {
                font-weight: 600;
                color: #0f172a;
            }
            .ldc-asst-task-amt {
                font-weight: 700;
                color: #0f766e;
            }
            .ldc-asst-task-sub {
                font-size: 11px;
                color: #64748b;
            }
            .ldc-asst-log {
                background: #0f172a;
                color: #38bdf8;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 11px;
                padding: 10px;
                border-radius: 8px;
                max-height: 120px;
                overflow-y: auto;
                white-space: pre-wrap;
                word-break: break-all;
            }
            .ldc-asst-footer {
                padding: 12px 16px;
                border-top: 1px solid #e2e8f0;
                background: #f8fafc;
                display: flex;
                gap: 8px;
            }
            .ldc-asst-btn {
                flex: 1;
                padding: 10px 14px;
                border-radius: 8px;
                border: none;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                transition: opacity 0.15s;
            }
            .ldc-asst-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .ldc-asst-btn-primary {
                background: #0f766e;
                color: white;
            }
            .ldc-asst-btn-primary:hover:not(:disabled) {
                background: #115e59;
            }
            .ldc-asst-btn-secondary {
                background: #e2e8f0;
                color: #1e293b;
            }
        `;
        document.head.appendChild(style);

        const bubble = document.createElement('div');
        bubble.id = 'ldc-pay-assistant-bubble';
        bubble.innerHTML = `
            <span>💳 兑换与红包发款助手</span>
            <span id="ldc-pay-assistant-badge" style="display:none;">0</span>
        `;
        document.body.appendChild(bubble);

        const modal = document.createElement('div');
        modal.id = 'ldc-pay-assistant-modal';
        modal.innerHTML = `
            <div class="ldc-asst-header">
                <h3>💳 兑换与红包自动发款助手 v1.0.7</h3>
                <button class="ldc-asst-close" id="ldc-asst-close-btn">&times;</button>
            </div>
            <div class="ldc-asst-body">
                <div class="ldc-asst-card" id="ldc-asst-user-card">
                    <div class="ldc-asst-card-title">
                        <span>Linux.do 登录态</span>
                        <a href="javascript:void(0)" id="ldc-asst-refresh-user-btn" style="color:#0f766e;text-decoration:none;font-weight:600;">刷新</a>
                    </div>
                    <div class="ldc-asst-user-info" id="ldc-asst-user-view">正在读取 Linux.do 登录态…</div>
                </div>

                <div class="ldc-asst-card">
                    <div class="ldc-asst-card-title">
                        <span>支付安全码 (仅存本机)</span>
                        <a href="javascript:void(0)" id="ldc-asst-edit-key-btn" style="color:#0f766e;text-decoration:none;font-weight:600;">修改</a>
                    </div>
                    <div id="ldc-asst-key-view" style="display:flex;justify-content:space-between;align-items:center;">
                        <span id="ldc-asst-key-status">未设置</span>
                    </div>
                </div>

                <div class="ldc-asst-card">
                    <div class="ldc-asst-card-title">
                        <span>待支付兑换 / 红包 (<span id="ldc-asst-task-count">0</span>)</span>
                        <a href="javascript:void(0)" id="ldc-asst-refresh-tasks-btn" style="color:#0f766e;text-decoration:none;font-weight:600;">刷新</a>
                    </div>
                    <div id="ldc-asst-task-list" style="max-height:160px;overflow-y:auto;">
                        <div style="color:#64748b;text-align:center;padding:12px 0;">正在获取订单…</div>
                    </div>
                </div>

                <div class="ldc-asst-card" id="ldc-asst-log-card" style="display:none;">
                    <div class="ldc-asst-card-title">执行进度与日志</div>
                    <div class="ldc-asst-log" id="ldc-asst-log-view"></div>
                </div>
            </div>
            <div class="ldc-asst-footer">
                <button class="ldc-asst-btn ldc-asst-btn-secondary" id="ldc-asst-open-target-btn" type="button">
                    ${isAdminPage ? '前往 Credit 核验并付款' : '打开管理后台'}
                </button>
                <button class="ldc-asst-btn ldc-asst-btn-primary" id="ldc-asst-pay-all-btn" type="button" disabled>一键付清 (0)</button>
            </div>
        `;
        document.body.appendChild(modal);

        assistantElements = {
            bubble,
            badge: document.getElementById('ldc-pay-assistant-badge'),
            modal,
            userView: document.getElementById('ldc-asst-user-view'),
            keyStatus: document.getElementById('ldc-asst-key-status'),
            taskCount: document.getElementById('ldc-asst-task-count'),
            taskList: document.getElementById('ldc-asst-task-list'),
            payAllBtn: document.getElementById('ldc-asst-pay-all-btn'),
            logCard: document.getElementById('ldc-asst-log-card'),
            logView: document.getElementById('ldc-asst-log-view'),
        };

        bubble.onclick = () => {
            modal.classList.toggle('open');
            if (modal.classList.contains('open')) {
                updateUIState();
            }
        };
        document.getElementById('ldc-asst-close-btn').onclick = () => {
            modal.classList.remove('open');
        };
        document.getElementById('ldc-asst-refresh-user-btn').onclick = () => {
            fetchLinuxDoUser();
        };
        document.getElementById('ldc-asst-edit-key-btn').onclick = () => {
            promptConfigurePayKey();
        };
        document.getElementById('ldc-asst-refresh-tasks-btn').onclick = () => {
            refreshBlockedPayments();
        };
        document.getElementById('ldc-asst-open-target-btn').onclick = () => {
            if (isAdminPage) {
                window.open('https://credit.linux.do/', '_blank');
            } else {
                window.open(`${getApiBase()}/admin`, '_blank');
            }
        };
        assistantElements.payAllBtn.onclick = () => {
            startBatchPayment();
        };

        updateUIState();
        fetchLinuxDoUser();
        fetchPendingTasks();
    }

    function log(msg) {
        if (!assistantElements || !assistantElements.logView) return;
        assistantElements.logCard.style.display = 'block';
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        assistantElements.logView.textContent += `[${time}] ${msg}\n`;
        assistantElements.logView.scrollTop = assistantElements.logView.scrollHeight;
    }

    async function fetchLinuxDoUser() {
        if (!isCreditPage) {
            cachedLinuxDoUser = null;
            loginState = { kind: 'credit_page_required', message: '后台页面不跨站判断 Credit 登录态。请点击“前往 Credit 核验并付款”，在官网页面使用同源登录会话。' };
            updateUIState();
            return;
        }
        if (linuxDoUserRequest) return linuxDoUserRequest;
        cachedLinuxDoUser = null;
        loginState = { kind: 'loading', message: '正在通过 Credit 同源接口核验登录态…' };
        updateUIState();
        linuxDoUserRequest = (async () => {
            try {
                const res = await creditRequest('GET', '/api/v1/oauth/user-info');
                if (res.status === 401) throw new Error('Credit 身份接口返回 HTTP 401：当前会话未授权，请在此网站重新登录后刷新');
                if (res.status === 403) throw new Error('Credit 身份接口返回 HTTP 403：访问被拒绝或需要网站验证，不代表你没有登录');
                if (res.status !== 200) throw new Error(`Credit 身份接口返回 HTTP ${res.status}，暂时无法核验登录态`);
                let json;
                try { json = JSON.parse(res.responseText); }
                catch { throw new Error('Credit 身份接口返回非 JSON（可能是登录或验证页面），无法核验身份'); }
                if (!json || json.error_msg !== '' || !/^[1-9]\d*$/.test(String(json.data?.id || ''))) {
                    throw new Error('Credit 身份接口未返回有效用户信息，无法核验身份；已禁用付款');
                }
                cachedLinuxDoUser = json.data;
                loginState = { kind: 'authenticated', message: '' };
            } catch (error) {
                loginState = { kind: 'error', message: error.message };
            } finally {
                linuxDoUserRequest = null;
                updateUIState();
            }
        })();
        return linuxDoUserRequest;
    }

    function updateUIState() {
        if (!assistantElements) return;

        const payKey = getPayKey();
        if (payKey && /^\d{6}$/.test(payKey)) {
            assistantElements.keyStatus.innerHTML = '<span style="color:#0f766e;font-weight:600;">●●●●●● (已安全保存)</span>';
        } else {
            assistantElements.keyStatus.innerHTML = '<span style="color:#ef4444;font-weight:600;">未设置 (点击右上角修改)</span>';
        }

        const expectedUid = getExpectedAdminUid();
        if (!cachedLinuxDoUser) {
            assistantElements.userView.innerHTML = `
                <div style="color:${loginState.kind === 'error' ? '#ef4444' : '#64748b'};font-weight:600;">
                    ${escapeHtml(loginState.message || '等待核验 Credit 登录态…')}
                </div>
            `;
        } else if (String(cachedLinuxDoUser.id) !== expectedUid) {
            assistantElements.userView.innerHTML = `
                <div style="color:#f59e0b;font-weight:600;">
                    ⚠️ 当前登录账号 (${escapeHtml(cachedLinuxDoUser.username)}, UID: ${escapeHtml(cachedLinuxDoUser.id)}) 与预设管理员 UID (${escapeHtml(expectedUid)}) 不一致！已禁用付款。
                </div>
            `;
        } else {
            const avatar = '<div class="ldc-asst-avatar"></div>';
            assistantElements.userView.innerHTML = `
                ${avatar}
                <div>
                    <div style="font-weight:700;color:#0f172a;">${escapeHtml(cachedLinuxDoUser.nickname || cachedLinuxDoUser.username)} (UID: ${escapeHtml(cachedLinuxDoUser.id)})</div>
                    <div style="color:#64748b;font-size:11px;">可用余额: <strong style="color:#0f766e;">${escapeHtml(cachedLinuxDoUser.available_balance || '0.00')} LDC</strong></div>
                </div>
            `;
        }

        renderTaskList();
    }

    async function fetchPendingTasks() {
        if (!assistantElements || isProcessing || tasksLoading) return;
        tasksLoading = true;
        taskError = '';
        pendingTasks = [];
        renderTaskList();
        try {
            await adminSessionReady;
            const data = await apiRequest('GET', '/admin/redemptions/auto-pay-tasks');
            if (!data.ok || !data.admin?.providerUserId || !Array.isArray(data.tasks)) {
                throw new Error('待付订单响应无效，请更新后端');
            }
            data.tasks.forEach((task) => amountMilli(task.amountLdc));
            pendingTasks = Array.isArray(data.tasks) ? data.tasks : [];
            for (const task of pendingTasks) {
                if (task.orderNo && unavailablePaymentOrders.get(taskKey(task)) === task.orderNo) task.autoPayBlocked = true;
            }
            if (data.admin && data.admin.providerUserId) {
                setExpectedAdminUid(data.admin.providerUserId);
            }
        } catch (err) {
            pendingTasks = [];
            if (err.status === 401 || err.status === 403) {
                taskError = '后台管理权限未验证，请登录后台后刷新页面。';
            } else if (err.status === 404) {
                taskError = '后端接口不存在 (404)，请先部署最新后端。';
            } else {
                taskError = '读取订单失败：' + err.message;
            }
        } finally {
            tasksLoading = false;
            updateUIState();
        }
    }

    async function refreshBlockedPayments() {
        if (isProcessing || tasksLoading) return;
        isProcessing = true;
        updateUIState();
        try {
            for (const task of pendingTasks.filter((entry) => entry.autoPayBlocked)) {
                const path = task.kind === 'red_packet'
                    ? `/admin/red-packets/${encodeURIComponent(task.campaignId)}/claims/${encodeURIComponent(task.claimId)}/refresh`
                    : `/admin/redemptions/${encodeURIComponent(task.redemptionId)}/refresh`;
                const result = await apiRequest('POST', path, {});
                if ((result.redemption && !result.redemption.autoPayBlocked) || ['failed', 'paid'].includes(result.paymentState)) unavailablePaymentOrders.delete(taskKey(task));
            }
        } catch (error) {
            log('系统复查未完成：' + error.message);
        } finally {
            isProcessing = false;
            await fetchPendingTasks();
        }
    }

    function taskKey(task) {
        return `${task.kind || 'redemption'}:${task.targetId || task.redemptionId || task.claimId}`;
    }

    function paymentConfirmed(result, task) {
        return task.kind === 'red_packet' ? result.claim?.status === 'succeeded' : result.redemption?.status === 'paid';
    }

    function renderTaskList() {
        if (!assistantElements) return;
        const count = pendingTasks.length;
        assistantElements.taskCount.textContent = String(count);

        if (count > 0) {
            assistantElements.badge.style.display = 'inline-flex';
            assistantElements.badge.textContent = String(count);
        } else {
            assistantElements.badge.style.display = 'none';
        }

        if (tasksLoading || taskError) {
            assistantElements.taskList.textContent = taskError || '正在读取待付订单（不会自动建单）…';
            assistantElements.payAllBtn.disabled = true;
            assistantElements.payAllBtn.textContent = '暂不可付款';
            return;
        }

        if (!count) {
            assistantElements.taskList.innerHTML = '<div style="color:#64748b;text-align:center;padding:12px 0;">当前没有待自动付款的订单 🎉</div>';
            assistantElements.payAllBtn.disabled = true;
            assistantElements.payAllBtn.textContent = '一键付清 (0)';
            return;
        }

        let totalLdc = 0;
        const payableCount = pendingTasks.filter((task) => !task.autoPayBlocked).length;
        assistantElements.taskList.innerHTML = pendingTasks.map((task) => {
            const ldc = parseFloat(task.amountLdc || '0');
            if (!task.autoPayBlocked) totalLdc += ldc;
            return `
                <div class="ldc-asst-task-item">
                    <div>
                        <div class="ldc-asst-task-user">${escapeHtml(task.displayName || '用户')} (UID: ${escapeHtml(task.currentProviderUserId || '-')})</div>
                        <div class="ldc-asst-task-sub">${task.kind === 'red_packet' ? `红包 · ${escapeHtml(task.campaignTitle || '')}` : `兑换 · ${escapeHtml(task.rcredits || 0)} rcredit`} · ${task.autoPayBlocked ? '链接不可用，等待系统查单；点刷新可复查' : task.paymentState === 'pending' ? '未确认成功，链接需核验' : escapeHtml(task.paymentState)} · 单号 ${escapeHtml(task.orderNo || task.targetId || task.redemptionId)}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="ldc-asst-task-amt">${escapeHtml(task.amountLdc)} LDC</div>
                    </div>
                </div>
            `;
        }).join('');

        const canPay = !!(
            payableCount > 0 &&
            isCreditPage &&
            loginState.kind === 'authenticated' &&
            !isProcessing &&
            cachedLinuxDoUser &&
            String(cachedLinuxDoUser.id) === getExpectedAdminUid() &&
            /^\d{6}$/.test(getPayKey())
        );

        assistantElements.payAllBtn.disabled = !canPay;
        assistantElements.payAllBtn.textContent = payableCount
            ? `核验并支付 (${payableCount} 笔 / ${totalLdc.toFixed(2)} LDC)` : '原付款链接待核对，不能批付';
    }

    async function startBatchPayment() {
        if (isProcessing || tasksLoading || taskError) return;
        if (!isCreditPage) {
            alert('请点击“前往 Credit 核验并付款”，付款只在 credit.linux.do 页面执行。');
            return;
        }
        const payKey = getPayKey();
        if (!/^\d{6}$/.test(payKey)) {
            alert('请先配置 6 位 Linux.do 支付安全码。');
            return;
        }
        if (!cachedLinuxDoUser || String(cachedLinuxDoUser.id) !== getExpectedAdminUid()) {
            alert('当前 Linux.do 登录状态异常或账号不匹配，已拒绝执行付款。');
            return;
        }
        if (!pendingTasks.length) {
            alert('当前没有待付款订单。');
            return;
        }

        const selectedTasks = pendingTasks.filter((task) => !task.autoPayBlocked).map((task) => ({ ...task }));
        if (!selectedTasks.length) {
            alert('付款链接已停用。点击订单刷新可由系统复查；当前网关结果不足以允许重付，无需人工确认。');
            return;
        }
        const totalLdc = selectedTasks.reduce((total, task) => total + amountMilli(task.amountLdc), 0) / 1000;

        if (!window.confirm(`确认向当前 ${selectedTasks.length} 笔订单自动付款，共计支付 ${totalLdc.toFixed(2)} LDC？\n\n付款将由当前 Linux.do 账号 (${cachedLinuxDoUser.username}) 执行。`)) {
            return;
        }

        isProcessing = true;
        assistantElements.payAllBtn.disabled = true;
        assistantElements.payAllBtn.textContent = '正在自动处理中…';
        log(`=== 开始批量付款流程，共 ${selectedTasks.length} 笔（助手 v1.0.7）===`);

        let successCount = 0;
        let failCount = 0;

        for (let index = 0; index < selectedTasks.length; index++) {
            const task = selectedTasks[index];
            log(`[${index + 1}/${selectedTasks.length}] 处理${task.kind === 'red_packet' ? '红包' : '兑换'}单 ${task.targetId || task.redemptionId || task.claimId} (${task.amountLdc} LDC)...`);

            try {
                await executeSinglePayment(task, payKey);
                successCount++;
                log(`[${index + 1}/${selectedTasks.length}] ✅ 后端已确认到账`);
            } catch (err) {
                failCount++;
                log(`已暂停：${err.message}。请先核对原单，勿重复支付。`);
                break;
            }
        }

        log(`=== 批量付款完成：成功 ${successCount} 笔，失败 ${failCount} 笔 ===`);
        isProcessing = false;
        await fetchLinuxDoUser();
        await fetchPendingTasks();
        alert(`批量发款完成！\n成功: ${successCount} 笔\n失败: ${failCount} 笔`);
    }

    async function executeSinglePayment(task, payKey, replacementCount = 0) {
        if (!isCreditPage) throw new Error('付款只允许在 credit.linux.do 页面执行');
        if (task.autoPayBlocked) throw new Error('该付款链接已停用，等待系统复查结果');
        await fetchLinuxDoUser();
        if (!cachedLinuxDoUser || String(cachedLinuxDoUser.id) !== getExpectedAdminUid()) {
            throw new Error(loginState.message || '付款账号已失效或变化');
        }
        const batch = await apiRequest('POST', '/admin/redemptions/auto-pay-batch', {
            targets: [{ kind: task.kind || 'redemption', id: task.targetId || task.redemptionId || task.claimId }],
        });
        const fresh = batch.tasks?.find((entry) => taskKey(entry) === taskKey(task));
        if (!fresh?.taskToken) throw new Error(batch.errors?.[0]?.message || '后端未授权付款，请刷新订单状态');
        if (amountMilli(fresh.amountLdc) !== amountMilli(task.amountLdc)) throw new Error('金额已变化，请重新确认');
        task = { ...task, ...fresh };

        log('  → [安全核查 1/4] 服务端任务 Token 校验...');
        const claim = await apiRequest('POST', '/merchant-auto-pay/claim', {
            taskToken: task.taskToken,
        });
        if (!claim || !claim.ok) {
            throw new Error('服务端签名校验未通过');
        }
        task.merchantOrderNo = claim.merchantOrderNo;
        if (String(claim.payerUserId) !== String(cachedLinuxDoUser.id)
            || amountMilli(claim.expectedAmount) !== amountMilli(task.amountLdc)) {
            throw new Error('任务付款人或金额不匹配');
        }

        log(`  → [安全核查 2/4] 核验官方付款链接（业务单号 ${claim.merchantOrderNo}）...`);
        const queryRes = await creditRequest('GET', `/api/v1/merchant/payment/order?order_no=${encodeURIComponent(claim.orderNo)}`);
        if (queryRes.status === 404) {
            return handleUnavailablePaymentLink(task, 'http_404', payKey, replacementCount);
        }
        if (queryRes.status !== 200) {
            throw new Error(`Linux.do 订单查询失败: HTTP ${queryRes.status}`);
        }
        let orderJson;
        try {
            orderJson = JSON.parse(queryRes.responseText);
        } catch {
            throw new Error('Linux.do 订单查询返回格式无效');
        }
        const officialOrder = orderJson && orderJson.data && orderJson.data.order;
        if (orderJson.error_msg || !officialOrder) {
            throw new Error('未在 Linux.do 查到该订单');
        }

        if (!claim.payeeUserId || !claim.merchantPid || !claim.merchantOrderNo
            || String(officialOrder.payee_user_id) !== String(claim.payeeUserId)
            || String(officialOrder.client_id) !== String(claim.merchantPid)
            || String(officialOrder.merchant_order_no) !== String(claim.merchantOrderNo)) {
            throw new Error('收款人、商户或业务订单号不一致，已拦截');
        }
        if (String(officialOrder.payer_user_id) !== String(cachedLinuxDoUser.id)) {
            throw new Error(`付款人 UID 不匹配 (预期 ${cachedLinuxDoUser.id}, 订单为 ${officialOrder.payer_user_id})`);
        }
        if (amountMilli(officialOrder.amount) !== amountMilli(claim.expectedAmount)) {
            throw new Error('订单金额与系统记录不一致');
        }
        if (officialOrder.status !== 'pending') return handleUnavailablePaymentLink(task, 'order_not_pending', payKey, replacementCount);
        const expiresAt = Date.parse(officialOrder.expires_at);
        if (!Number.isFinite(expiresAt)) throw new Error('官方付款页未返回有效的链接到期时间；支付结果需查单核实');
        await apiRequest('POST', '/merchant-auto-pay/observe', {
            taskToken: task.taskToken,
            order: { id: officialOrder.id, client_id: officialOrder.client_id, merchant_order_no: officialOrder.merchant_order_no,
                payee_user_id: officialOrder.payee_user_id, payer_user_id: officialOrder.payer_user_id, amount: officialOrder.amount,
                status: officialOrder.status, created_at: officialOrder.created_at, expires_at: officialOrder.expires_at },
        });
        if (expiresAt <= Date.now()) return handleUnavailablePaymentLink(task, 'link_expired', payKey, replacementCount);

        log('  → [执行 3/4] 安全核查全部通过，向 Linux.do 提交支付...');
        const payRes = await creditRequest('POST', '/api/v1/merchant/payment', {
            order_no: claim.orderNo,
            pay_key: payKey,
        });
        if (payRes.status !== 200) {
            throw new Error(paymentHttpError(payRes));
        }
        let payJson;
        try {
            payJson = JSON.parse(payRes.responseText);
        } catch {
            throw new Error('支付返回非 JSON 格式');
        }
        if (!payJson || payJson.error_msg !== '') {
            throw new Error('Linux.do 未明确确认支付，请核对原单');
        }

        log('  → [确认 4/4] 支付提交成功，上报系统确认入账...');
        const confirmation = await apiRequest('POST', '/merchant-auto-pay/confirm', {
            taskToken: task.taskToken,
            paid: true,
        });
        if (!paymentConfirmed(confirmation, task)) {
            throw new Error('付款已提交，但尚未确认到账');
        }
    }

    async function handleUnavailablePaymentLink(task, reasonCode, payKey, replacementCount) {
        task.autoPayBlocked = true;
        unavailablePaymentOrders.set(taskKey(task), task.merchantOrderNo);
        for (const pending of pendingTasks) {
            if (taskKey(pending) === taskKey(task)) pending.autoPayBlocked = true;
        }
        updateUIState();
        log('  → 付款链接不可用；未提交支付，正在通知后台停用旧链接并使用创建方凭据复查原单…');
        let result;
        try {
            result = await apiRequest('POST', '/merchant-auto-pay/link-unavailable', {
                taskToken: task.taskToken, reasonCode,
            });
        } catch {
            throw new Error('付款链接不可用且后台登记未完成；本次未提交付款，请到管理后台停用该链接并核对原单');
        }
        if (paymentConfirmed(result, task)) {
            log('  → 创建方查单确认原单已付，未再次提交付款');
            return;
        }
        if (result.canReprepare && replacementCount < 1) {
            unavailablePaymentOrders.delete(taskKey(task));
            log('  → 后端确认旧单已过期未成功或明确不存在，自动生成新付款单并重新核验（本次最多一次）');
            return executeSinglePayment({ ...task, autoPayBlocked: false }, payKey, replacementCount + 1);
        }
        throw new Error('旧付款链接已停用并移出批付；系统已复查，网关尚未提供可安全重付的明确结果。无需人工确认，点击订单刷新可再次查单');
    }

})();
