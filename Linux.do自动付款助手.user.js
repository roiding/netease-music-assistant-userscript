// ==UserScript==
// @name         Linux.do 自动付款助手 (网易云音乐互助管理)
// @namespace    https://roiding.dpdns.org/
// @version      1.0.1
// @description  网易云互助管理员专属独立脚本：在管理后台与 credit.linux.do 双端核验登录态、管理本地支付安全码、防越权自动拉取待付订单与零信任交叉核验一键付款。
// @author       Netease Music Helper
// @match        *://credit.linux.do/*
// @match        https://roiding.dpdns.org/admin*
// @match        https://netease.ran-ding.gq/admin*
// @connect      credit.linux.do
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

    const STORAGE_KEY_PAY_KEY = 'music_helper_auto_pay_key';
    const STORAGE_KEY_ADMIN_TOKEN = 'music_helper_admin_token';
    const STORAGE_KEY_API_BASE = 'music_helper_admin_api_base';
    const STORAGE_KEY_EXPECTED_UID = 'music_helper_expected_admin_uid';

    const DEFAULT_API_BASE = 'https://roiding.dpdns.org';
    const DEFAULT_ADMIN_UID = '207121';

    function getApiBase() {
        return (GM_getValue(STORAGE_KEY_API_BASE, '') || DEFAULT_API_BASE).replace(/\/+$/, '');
    }
    function setApiBase(val) {
        GM_setValue(STORAGE_KEY_API_BASE, String(val || '').trim().replace(/\/+$/, ''));
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
            data = { error: 'invalid_json', raw: res.responseText };
        }
        if (res.status >= 400) {
            const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            err.payload = data;
            throw err;
        }
        return data;
    }

    const isAdminPage = location.hostname === 'roiding.dpdns.org' || location.hostname === 'netease.ran-ding.gq';

    if (isAdminPage) {
        syncAdminSessionOnPage();
    }

    GM_registerMenuCommand('设置 Linux.do 支付安全码（仅本机）', () => {
        promptConfigurePayKey();
    });
    GM_registerMenuCommand('配置网易云后台服务与凭证', () => {
        promptConfigureBackend();
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
        const current = getPayKey();
        const input = window.prompt(
            '输入 6 位 Linux.do 支付安全码：\n（它只保存在本机脚本存储中，绝不上传到任何服务器）',
            current || ''
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

        const currentToken = getAdminToken();
        const token = window.prompt('管理员 Token (在管理页会自动刷新)：', currentToken) || '';
        if (token.trim()) setAdminToken(token.trim());

        alert('后台连接配置已更新。');
        updateUIState();
    }

    let assistantElements = null;
    let cachedLinuxDoUser = null;
    let pendingTasks = [];
    let isProcessing = false;

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
            <span>💳 兑换发款助手</span>
            <span id="ldc-pay-assistant-badge" style="display:none;">0</span>
        `;
        document.body.appendChild(bubble);

        const modal = document.createElement('div');
        modal.id = 'ldc-pay-assistant-modal';
        modal.innerHTML = `
            <div class="ldc-asst-header">
                <h3>💳 网易云兑换自动发款助手</h3>
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
                        <span>待支付兑换单 (<span id="ldc-asst-task-count">0</span>)</span>
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
                    ${isAdminPage ? '打开 Linux.do' : '打开管理后台'}
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
            fetchPendingTasks();
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
        if (assistantElements) {
            assistantElements.userView.innerHTML = '<div style="color:#64748b;">正在读取 Linux.do 登录态…</div>';
        }
        try {
            const res = await httpXmlRequest({
                method: 'GET',
                url: 'https://credit.linux.do/api/v1/oauth/user-info',
                withCredentials: true,
            });
            if (res.status === 200) {
                const json = JSON.parse(res.responseText);
                if (json && json.data && json.data.id) {
                    cachedLinuxDoUser = json.data;
                } else {
                    cachedLinuxDoUser = null;
                }
            } else {
                cachedLinuxDoUser = null;
            }
        } catch (e) {
            cachedLinuxDoUser = null;
            console.warn('[自动付款助手] 无法获取 Linux.do 用户信息:', e);
        }
        updateUIState();
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
                <div style="color:#ef4444;font-weight:600;">
                    🔴 未检测到 Linux.do 登录态。请在当前浏览器登录 <a href="https://credit.linux.do" target="_blank" style="color:#0f766e;">credit.linux.do</a> 后点击刷新。
                </div>
            `;
        } else if (String(cachedLinuxDoUser.id) !== expectedUid) {
            assistantElements.userView.innerHTML = `
                <div style="color:#f59e0b;font-weight:600;">
                    ⚠️ 当前登录账号 (${cachedLinuxDoUser.username}, UID: ${cachedLinuxDoUser.id}) 与预设管理员 UID (${expectedUid}) 不一致！已禁用付款。
                </div>
            `;
        } else {
            const avatar = cachedLinuxDoUser.avatar_url ? `<img class="ldc-asst-avatar" src="${cachedLinuxDoUser.avatar_url}" alt="avatar">` : '<div class="ldc-asst-avatar"></div>';
            assistantElements.userView.innerHTML = `
                ${avatar}
                <div>
                    <div style="font-weight:700;color:#0f172a;">${cachedLinuxDoUser.nickname || cachedLinuxDoUser.username} (UID: ${cachedLinuxDoUser.id})</div>
                    <div style="color:#64748b;font-size:11px;">可用余额: <strong style="color:#0f766e;">${cachedLinuxDoUser.available_balance || '0.00'} LDC</strong></div>
                </div>
            `;
        }

        renderTaskList();
    }

    async function fetchPendingTasks() {
        if (!assistantElements) return;
        assistantElements.taskList.innerHTML = '<div style="color:#64748b;text-align:center;padding:12px 0;">正在拉取待支付任务…</div>';
        try {
            const data = await apiRequest('GET', '/admin/redemptions/auto-pay-tasks');
            pendingTasks = Array.isArray(data.tasks) ? data.tasks : [];
            if (data.admin && data.admin.providerUserId) {
                setExpectedAdminUid(data.admin.providerUserId);
            }
        } catch (err) {
            pendingTasks = [];
            if (err.status === 401 || err.status === 403) {
                assistantElements.taskList.innerHTML = `
                    <div style="color:#ef4444;text-align:center;padding:12px 0;">
                        后台管理权限未验证。请先在管理后台登录，或刷新页面自动同步凭据。
                    </div>
                `;
                return;
            }
            if (err.status === 404) {
                assistantElements.taskList.innerHTML = `
                    <div style="color:#ef4444;text-align:center;padding:12px 0;">
                        后端尚未部署最新代码 (接口 404)。请先执行 wrangler deploy。
                    </div>
                `;
                return;
            }
            assistantElements.taskList.innerHTML = `
                <div style="color:#ef4444;text-align:center;padding:12px 0;">
                    拉取待支付任务失败: ${err.message || '网络异常'}
                </div>
            `;
            return;
        }
        updateUIState();
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

        if (!count) {
            assistantElements.taskList.innerHTML = '<div style="color:#64748b;text-align:center;padding:12px 0;">当前没有待自动付款的订单 🎉</div>';
            assistantElements.payAllBtn.disabled = true;
            assistantElements.payAllBtn.textContent = '一键付清 (0)';
            return;
        }

        let totalLdc = 0;
        assistantElements.taskList.innerHTML = pendingTasks.map((task) => {
            const ldc = parseFloat(task.amountLdc || '0');
            totalLdc += ldc;
            return `
                <div class="ldc-asst-task-item">
                    <div>
                        <div class="ldc-asst-task-user">${task.displayName || '用户'} (UID: ${task.currentProviderUserId || '-'})</div>
                        <div class="ldc-asst-task-sub">${task.rcredits || 0} rcredit · 单号 ${task.orderNo || task.redemptionId}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="ldc-asst-task-amt">${task.amountLdc} LDC</div>
                    </div>
                </div>
            `;
        }).join('');

        const canPay = !!(
            !isProcessing &&
            cachedLinuxDoUser &&
            String(cachedLinuxDoUser.id) === getExpectedAdminUid() &&
            /^\d{6}$/.test(getPayKey())
        );

        assistantElements.payAllBtn.disabled = !canPay;
        assistantElements.payAllBtn.textContent = `一键付清 (${count} 笔 / ${totalLdc.toFixed(2)} LDC)`;
    }

    async function startBatchPayment() {
        if (isProcessing) return;
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

        let totalLdc = 0;
        pendingTasks.forEach((t) => totalLdc += parseFloat(t.amountLdc || '0'));

        if (!window.confirm(`确认向当前 ${pendingTasks.length} 笔订单自动付款，共计支付 ${totalLdc.toFixed(2)} LDC？\n\n付款将由当前 Linux.do 账号 (${cachedLinuxDoUser.username}) 执行。`)) {
            return;
        }

        isProcessing = true;
        assistantElements.payAllBtn.disabled = true;
        assistantElements.payAllBtn.textContent = '正在自动处理中…';
        log(`=== 开始批量付款流程，共 ${pendingTasks.length} 笔 ===`);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < pendingTasks.length; i++) {
            const task = pendingTasks[i];
            log(`[${i + 1}/${pendingTasks.length}] 处理兑换单 ${task.redemptionId} (${task.amountLdc} LDC)...`);

            try {
                await executeSinglePayment(task, payKey);
                successCount++;
                log(`[${i + 1}/${pendingTasks.length}] ✅ 成功完成发款并由系统确认！`);
            } catch (err) {
                failCount++;
                log(`[${i + 1}/${pendingTasks.length}] ❌ 失败: ${err.message}`);
            }
        }

        log(`=== 批量付款完成：成功 ${successCount} 笔，失败 ${failCount} 笔 ===`);
        isProcessing = false;
        await fetchLinuxDoUser();
        await fetchPendingTasks();
        alert(`批量发款完成！\n成功: ${successCount} 笔\n失败: ${failCount} 笔`);
    }

    async function executeSinglePayment(task, payKey, isRetry = false) {
        if (!task.taskToken) {
            throw new Error('订单缺少服务端签名任务 Token (防越权拦截)');
        }

        log('  → [安全核查 1/4] 服务端任务 Token 校验...');
        const claim = await apiRequest('POST', '/merchant-auto-pay/claim', {
            taskToken: task.taskToken,
        });
        if (!claim || !claim.ok) {
            throw new Error('服务端签名校验未通过');
        }

        log(`  → [安全核查 2/4] 向 Linux.do 官方核验订单状态与金额 (单号 ${claim.orderNo})...`);
        const queryRes = await httpXmlRequest({
            method: 'GET',
            url: `https://credit.linux.do/api/v1/merchant/payment/order?order_no=${encodeURIComponent(claim.orderNo)}`,
            withCredentials: true,
        });
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
        if (!officialOrder) {
            throw new Error('未在 Linux.do 查到该订单');
        }

        if (officialOrder.status !== 'pending') {
            if (!isRetry && (officialOrder.status === 'expired' || officialOrder.status === 'timeout')) {
                log(`  ⚠️ Linux.do 订单已超时失效 (${officialOrder.status})，正在自动换发新支付链接...`);
                const reissued = await apiRequest('POST', `/admin/redemptions/${encodeURIComponent(task.redemptionId)}/reissue`);
                if (reissued && reissued.redemption && reissued.redemption.latestPaymentUrl) {
                    log('  → 新付款单号已生成，正在重新核验并付款...');
                    const batch = await apiRequest('POST', '/admin/redemptions/auto-pay-batch', {
                        redemptionIds: [task.redemptionId],
                    });
                    if (batch && batch.tasks && batch.tasks.length > 0) {
                        return await executeSinglePayment(batch.tasks[0], payKey, true);
                    }
                }
            }
            throw new Error(`Linux.do 订单状态不是 pending (当前为: ${officialOrder.status})，拒绝重复付款`);
        }
        if (String(officialOrder.payer_user_id) !== String(cachedLinuxDoUser.id)) {
            throw new Error(`付款人 UID 不匹配 (预期 ${cachedLinuxDoUser.id}, 订单为 ${officialOrder.payer_user_id})`);
        }
        const officialAmount = parseFloat(officialOrder.amount || '0');
        const expectedAmount = parseFloat(claim.expectedAmount || '0');
        if (Math.abs(officialAmount - expectedAmount) > 0.001) {
            throw new Error(`订单金额与系统记录不一致！(官方 ${officialAmount} LDC, 系统 ${expectedAmount} LDC)`);
        }

        log('  → [执行 3/4] 安全核查全部通过，向 Linux.do 提交支付...');
        const payRes = await httpXmlRequest({
            method: 'POST',
            url: 'https://credit.linux.do/api/v1/merchant/payment',
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({
                order_no: claim.orderNo,
                pay_key: payKey,
            }),
            withCredentials: true,
        });
        if (payRes.status !== 200) {
            throw new Error(`支付接口返回错误: HTTP ${payRes.status}`);
        }
        let payJson;
        try {
            payJson = JSON.parse(payRes.responseText);
        } catch {
            throw new Error('支付返回非 JSON 格式');
        }
        if (payJson && payJson.error_msg) {
            throw new Error(`Linux.do 支付被拒绝: ${payJson.error_msg}`);
        }

        log('  → [确认 4/4] 支付提交成功，上报系统确认入账...');
        await apiRequest('POST', '/merchant-auto-pay/confirm', {
            taskToken: task.taskToken,
            paid: true,
        });
    }

})();
