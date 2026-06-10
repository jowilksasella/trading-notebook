(function () {
    'use strict';

    // ==================== CONFIG ====================
    const REPO_OWNER = 'jowilksasella';
    const REPO_NAME = 'trading-notebook';
    const DATA_BRANCH = 'data';
    const TRADES_FILE = 'trades.json';
    const IMG_DIR = 'img';
    const LS = {
        CONFIGURED: 'tj_ok',
        SALT: 'tj_salt',
        PW_HASH: 'tj_pwh',
        ENC_PAT: 'tj_ep',
    };

    // ==================== CRYPTO ====================
    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        return bytes;
    }
    function bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function generateSalt() {
        return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    }
    async function deriveKey(password, saltHex) {
        const enc = new TextEncoder();
        const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
            km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }
    async function hashPw(password, saltHex) {
        const enc = new TextEncoder();
        const data = new Uint8Array([...hexToBytes(saltHex), ...enc.encode(password)]);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return bytesToHex(new Uint8Array(hash));
    }
    async function encryptStr(plaintext, password, saltHex) {
        const key = await deriveKey(password, saltHex);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
        const combined = new Uint8Array(iv.length + ct.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(ct), iv.length);
        return bytesToHex(combined);
    }
    async function decryptStr(cipherHex, password, saltHex) {
        const key = await deriveKey(password, saltHex);
        const combined = hexToBytes(cipherHex);
        const iv = combined.slice(0, 12);
        const ct = combined.slice(12);
        const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(dec);
    }

    // ==================== BASE64 (Unicode safe) ====================
    function toB64(str) { return btoa(unescape(encodeURIComponent(str))); }
    function fromB64(b64) { return decodeURIComponent(escape(atob(b64))); }

    // ==================== DATA ENCRYPTION ====================
    // Fixed salt so same password = same key on any device
    const DATA_SALT = 'sasella-trading-notebook-2026';

    async function deriveDataKey(password) {
        const enc = new TextEncoder();
        const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: enc.encode(DATA_SALT), iterations: 100000, hash: 'SHA-256' },
            km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }
    async function encryptBytes(data, password) {
        const key = await deriveDataKey(password);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
        const out = new Uint8Array(12 + ct.byteLength);
        out.set(iv); out.set(new Uint8Array(ct), 12);
        return out;
    }
    async function decryptBytes(data, password) {
        const key = await deriveDataKey(password);
        const iv = data.slice(0, 12);
        const ct = data.slice(12);
        const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new Uint8Array(dec);
    }
    function u8ToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
    function b64ToU8(b64) { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }

    // ==================== GITHUB API ====================
    class GitHub {
        constructor(token) {
            this.token = token;
            this.base = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
        }
        async api(path, opts = {}) {
            const url = path.startsWith('http') ? path : this.base + path;
            const res = await fetch(url, {
                ...opts,
                headers: {
                    Authorization: `token ${this.token}`,
                    Accept: 'application/vnd.github.v3+json',
                    ...(opts.headers || {}),
                },
            });
            return res;
        }
        async apiJson(path, opts = {}) {
            const res = await this.api(path, opts);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `API error ${res.status}`);
            }
            return res.json();
        }

        // Ensure data branch exists (orphan)
        async ensureDataBranch() {
            const res = await this.api(`/git/refs/heads/${DATA_BRANCH}`);
            if (res.ok) return;
            // Create orphan branch with encrypted empty trades
            const emptyBytes = new TextEncoder().encode('[]');
            const encrypted = await encryptBytes(emptyBytes, currentPassword);
            const encB64 = u8ToB64(encrypted);
            const blob = await this.apiJson('/git/blobs', {
                method: 'POST',
                body: JSON.stringify({ content: encB64, encoding: 'base64' }),
            });
            const tree = await this.apiJson('/git/trees', {
                method: 'POST',
                body: JSON.stringify({ tree: [{ path: TRADES_FILE, mode: '100644', type: 'blob', sha: blob.sha }] }),
            });
            const commit = await this.apiJson('/git/commits', {
                method: 'POST',
                body: JSON.stringify({ message: 'Init data branch', tree: tree.sha, parents: [] }),
            });
            await this.apiJson('/git/refs', {
                method: 'POST',
                body: JSON.stringify({ ref: `refs/heads/${DATA_BRANCH}`, sha: commit.sha }),
            });
        }

        // Get file from data branch
        async getFile(path) {
            const res = await this.api(`/contents/${path}?ref=${DATA_BRANCH}`);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error('Failed to get file');
            return res.json();
        }

        // Put file to data branch
        async putFile(path, contentB64, sha, message) {
            const body = { message, content: contentB64, branch: DATA_BRANCH };
            if (sha) body.sha = sha;
            const res = await this.api(`/contents/${path}`, {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            if (res.status === 409) {
                // SHA conflict — refetch and retry once
                const fresh = await this.getFile(path);
                body.sha = fresh ? fresh.sha : undefined;
                const retry = await this.api(`/contents/${path}`, {
                    method: 'PUT',
                    body: JSON.stringify(body),
                });
                if (!retry.ok) throw new Error('Save conflict');
                return (await retry.json()).content.sha;
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || 'Failed to save');
            }
            return (await res.json()).content.sha;
        }

        // Trades (encrypted)
        async loadTrades() {
            const file = await this.getFile(TRADES_FILE);
            if (!file) return { trades: [], sha: null };
            const encrypted = b64ToU8(file.content.replace(/\n/g, ''));
            const decrypted = await decryptBytes(encrypted, currentPassword);
            const json = new TextDecoder().decode(decrypted);
            return { trades: JSON.parse(json), sha: file.sha };
        }
        async saveTrades(trades, sha) {
            const json = JSON.stringify(trades, null, 2);
            const bytes = new TextEncoder().encode(json);
            const encrypted = await encryptBytes(bytes, currentPassword);
            const b64 = u8ToB64(encrypted);
            return this.putFile(TRADES_FILE, b64, sha, `Update: ${trades.length} trades`);
        }

        // Images (encrypted)
        async uploadImage(tradeId, type, dataUrl) {
            const rawB64 = dataUrl.split(',')[1];
            const rawBytes = b64ToU8(rawB64);
            const encrypted = await encryptBytes(rawBytes, currentPassword);
            const encB64 = u8ToB64(encrypted);
            const path = `${IMG_DIR}/${tradeId}_${type}.enc`;
            await this.putFile(path, encB64, null, `Screenshot: ${tradeId} ${type}`);
            return path;
        }
        async getImage(path) {
            const file = await this.getFile(path);
            if (!file) return null;
            const encrypted = b64ToU8(file.content.replace(/\n/g, ''));
            const decrypted = await decryptBytes(encrypted, currentPassword);
            const imgB64 = u8ToB64(decrypted);
            return `data:image/png;base64,${imgB64}`;
        }

        async test() {
            const res = await this.api('');
            return res.ok;
        }
    }

    // ==================== STATE ====================
    let gh = null;
    let trades = [];
    let tradesSha = null;
    let currentView = 'journal';
    let calendarYear = new Date().getFullYear();
    let closingTradeId = null;
    let detailTradeId = null;
    let selectedDirection = 'long';
    let selectedResult = null;
    let openImageData = null;
    let closeImageData = null;
    let currentPassword = null; // kept in memory for session

    // ==================== DOM ====================
    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);

    // ==================== UI HELPERS ====================
    function showLoading(text) {
        $('#loading-text').textContent = text || '載入中...';
        $('#loading-overlay').style.display = 'flex';
    }
    function hideLoading() {
        $('#loading-overlay').style.display = 'none';
    }
    function toast(msg, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        $('#toast-container').appendChild(el);
        setTimeout(() => { el.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => el.remove(), 300); }, 3000);
    }
    function shake(el) {
        el.style.animation = 'none'; el.offsetHeight; el.style.animation = 'shake .4s ease';
        setTimeout(() => el.style.animation = 'none', 400);
    }
    function escHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function fmtDT(ts) {
        const d = new Date(ts), p = n => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function calcRR(entry, tp, sl, dir) {
        const e = +entry, t = +tp, s = +sl;
        if (!e || !t || !s) return null;
        const risk = dir === 'long' ? e - s : s - e;
        const reward = dir === 'long' ? t - e : e - t;
        return risk > 0 ? reward / risk : null;
    }
    function calcCloseRR(trade, closePrice) {
        const e = +trade.entry, c = +closePrice, s = +trade.sl;
        if (!e || !c || !s) return null;
        const risk = trade.direction === 'long' ? e - s : s - e;
        const reward = trade.direction === 'long' ? c - e : e - c;
        return risk > 0 ? reward / risk : null;
    }
    function fmtRR(rr) {
        if (rr == null) return '—';
        return (rr >= 0 ? '+' : '') + rr.toFixed(2) + 'R';
    }

    // ==================== AUTH ====================
    function isConfigured() { return localStorage.getItem(LS.CONFIGURED) === '1'; }

    function showAuth() {
        $('#view-auth').style.display = 'flex';
        $('#top-nav').style.display = 'none';
        $('#main-content').style.display = 'none';
        if (isConfigured()) {
            $('#auth-setup').style.display = 'none';
            $('#auth-login').style.display = 'block';
            $('#login-pass').focus();
        } else {
            $('#auth-setup').style.display = 'block';
            $('#auth-login').style.display = 'none';
        }
    }

    function showApp() {
        $('#view-auth').style.display = 'none';
        $('#top-nav').style.display = 'flex';
        $('#main-content').style.display = 'block';
    }

    // Setup
    $('#btn-setup').addEventListener('click', async () => {
        const pass = $('#setup-pass').value;
        const pat = $('#setup-pat').value.trim();
        if (!pass || !pat) { shake($('#btn-setup')); return; }
        if (pass.length < 4) { toast('密碼至少 4 個字元', 'error'); return; }

        showLoading('設定中...');
        try {
            // Test PAT
            const testGh = new GitHub(pat);
            if (!(await testGh.test())) throw new Error('Token 無效或沒有 repo 權限');

            // Crypto
            const salt = generateSalt();
            const pwh = await hashPw(pass, salt);
            const ep = await encryptStr(pat, pass, salt);

            // Store
            localStorage.setItem(LS.SALT, salt);
            localStorage.setItem(LS.PW_HASH, pwh);
            localStorage.setItem(LS.ENC_PAT, ep);
            localStorage.setItem(LS.CONFIGURED, '1');

            // Init GitHub
            gh = testGh;
            currentPassword = pass;
            await gh.ensureDataBranch();
            const data = await gh.loadTrades();
            trades = data.trades;
            tradesSha = data.sha;

            hideLoading();
            showApp();
            renderTradeList();
            updateStats();
            toast('✅ 設定完成！歡迎使用', 'success');
        } catch (err) {
            hideLoading();
            toast('❌ ' + err.message, 'error');
        }
    });

    // Login
    $('#btn-login').addEventListener('click', doLogin);
    $('#login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    async function doLogin() {
        const pass = $('#login-pass').value;
        if (!pass) { shake($('#btn-login')); return; }

        showLoading('登入中...');
        try {
            const salt = localStorage.getItem(LS.SALT);
            const stored = localStorage.getItem(LS.PW_HASH);
            const h = await hashPw(pass, salt);
            if (h !== stored) throw new Error('密碼錯誤');

            const pat = await decryptStr(localStorage.getItem(LS.ENC_PAT), pass, salt);
            gh = new GitHub(pat);
            currentPassword = pass;

            const data = await gh.loadTrades();
            trades = data.trades;
            tradesSha = data.sha;

            hideLoading();
            showApp();
            renderTradeList();
            updateStats();
        } catch (err) {
            hideLoading();
            toast('❌ ' + err.message, 'error');
            $('#login-pass').value = '';
            $('#login-pass').focus();
        }
    }

    // Logout
    $('#btn-logout').addEventListener('click', () => {
        gh = null;
        currentPassword = null;
        trades = [];
        tradesSha = null;
        $('#login-pass').value = '';
        showAuth();
    });

    // Reset
    $('#btn-reset').addEventListener('click', () => {
        if (!confirm('確定要重置？需要重新輸入 Token。')) return;
        Object.values(LS).forEach(k => localStorage.removeItem(k));
        showAuth();
    });

    // ==================== SAVE HELPER ====================
    async function persistTrades() {
        showLoading('同步中...');
        try {
            tradesSha = await gh.saveTrades(trades, tradesSha);
            hideLoading();
        } catch (err) {
            hideLoading();
            toast('❌ 同步失敗：' + err.message, 'error');
            throw err;
        }
    }

    // ==================== NAV ====================
    function switchView(v) {
        currentView = v;
        $$('.nav-tab').forEach(t => t.classList.remove('active'));
        $$('.view').forEach(el => el.classList.remove('active'));
        if (v === 'journal') {
            $('#tab-journal').classList.add('active');
            $('#view-journal').classList.add('active');
        } else {
            $('#tab-calendar').classList.add('active');
            $('#view-calendar').classList.add('active');
            renderCalendar();
        }
    }
    $('#tab-journal').addEventListener('click', () => switchView('journal'));
    $('#tab-calendar').addEventListener('click', () => switchView('calendar'));

    // ==================== STATS ====================
    function updateStats() {
        const total = trades.length;
        const openCount = trades.filter(t => t.status === 'open').length;
        const closed = trades.filter(t => t.status === 'closed');
        const wins = closed.filter(t => t.closeResult === 'win');
        const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(0) + '%' : '—';
        const rrs = closed.map(t => t.closeRR).filter(r => r != null);
        const avg = rrs.length > 0 ? fmtRR(rrs.reduce((a, b) => a + b, 0) / rrs.length) : '—';
        $('#stat-total').textContent = total;
        $('#stat-open').textContent = openCount;
        $('#stat-winrate').textContent = wr;
        $('#stat-avg-rr').textContent = avg;
    }

    // ==================== TRADE LIST ====================
    function renderTradeList() {
        const list = $('#trade-list');
        list.querySelectorAll('.trade-card').forEach(c => c.remove());
        if (!trades.length) { $('#empty-state').style.display = 'flex'; return; }
        $('#empty-state').style.display = 'none';

        const sorted = [...trades].sort((a, b) => b.openTime - a.openTime);
        sorted.forEach(t => {
            const card = document.createElement('div');
            card.className = `trade-card direction-${t.direction}`;
            const emoji = t.direction === 'long' ? '📈' : '📉';
            const dirLabel = t.direction === 'long' ? '多 LONG' : '空 SHORT';

            let rrClass, rrText;
            if (t.status === 'open') { rrClass = 'open'; rrText = fmtRR(t.plannedRR); }
            else if (t.closeResult === 'win') { rrClass = 'win'; rrText = fmtRR(t.closeRR); }
            else if (t.closeResult === 'loss') { rrClass = 'loss'; rrText = fmtRR(t.closeRR); }
            else { rrClass = 'be'; rrText = fmtRR(t.closeRR); }

            const statusCls = t.status === 'open' ? 'open' : 'closed';
            const statusTxt = t.status === 'open' ? '持倉中' : '已平倉';
            const closeBtn = t.status === 'open' ? `<button class="close-btn" data-cid="${t.id}">⚡ 結倉</button>` : '';

            card.innerHTML = `
                <div class="trade-card-thumb">${emoji}</div>
                <div class="trade-card-info">
                    <div class="trade-card-top">
                        <span class="badge ${t.direction}">${dirLabel}</span>
                        <span class="trade-card-time">${fmtDT(t.openTime)}</span>
                    </div>
                    <div class="trade-card-prices">
                        <span><span class="lbl">Entry</span>${(+t.entry).toFixed(2)}</span>
                        <span><span class="lbl">TP</span>${(+t.tp).toFixed(2)}</span>
                        <span><span class="lbl">SL</span>${(+t.sl).toFixed(2)}</span>
                    </div>
                </div>
                <div class="trade-card-right">
                    <span class="rr-badge ${rrClass}">${rrText}</span>
                    <span class="status-badge ${statusCls}">${statusTxt}</span>
                    ${closeBtn}
                </div>`;
            card.addEventListener('click', e => {
                if (e.target.closest('.close-btn')) return;
                showDetail(t.id);
            });
            list.appendChild(card);
        });

        list.querySelectorAll('.close-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); openCloseModal(btn.dataset.cid); });
        });
    }

    // ==================== IMAGE HANDLING ====================
    function setupPaste(area, preview, placeholder, fileInput, setter) {
        area.addEventListener('click', e => { if (e.target !== preview) fileInput.click(); });
        fileInput.addEventListener('change', e => {
            if (e.target.files[0]) readImg(e.target.files[0], preview, placeholder, area, setter);
        });
    }
    function readImg(file, preview, placeholder, area, setter) {
        const r = new FileReader();
        r.onload = ev => {
            preview.src = ev.target.result; preview.style.display = 'block';
            placeholder.style.display = 'none'; area.classList.add('has-image');
            setter(ev.target.result);
        };
        r.readAsDataURL(file);
    }
    document.addEventListener('paste', e => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (!item.type.startsWith('image/')) continue;
            const file = item.getAsFile();
            if ($('#modal-new-trade').classList.contains('show')) {
                e.preventDefault();
                readImg(file, $('#preview-open'), $('#paste-placeholder-open'), $('#paste-area-open'), d => { openImageData = d; });
            } else if ($('#modal-close-trade').classList.contains('show')) {
                e.preventDefault();
                readImg(file, $('#preview-close'), $('#paste-placeholder-close'), $('#paste-area-close'), d => { closeImageData = d; });
            }
            return;
        }
    });
    setupPaste($('#paste-area-open'), $('#preview-open'), $('#paste-placeholder-open'), $('#file-input-open'), d => { openImageData = d; });
    setupPaste($('#paste-area-close'), $('#preview-close'), $('#paste-placeholder-close'), $('#file-input-close'), d => { closeImageData = d; });

    // ==================== MODALS ====================
    function openModal(id) { $(id).classList.add('show'); }
    function closeModal(id) { $(id).classList.remove('show'); }
    ['#modal-new-trade', '#modal-close-trade', '#modal-detail'].forEach(id => {
        $(id).addEventListener('click', e => { if (e.target === $(id)) closeModal(id); });
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') ['#modal-new-trade', '#modal-close-trade', '#modal-detail'].forEach(closeModal);
    });

    // ==================== NEW TRADE ====================
    function resetNewModal() {
        selectedDirection = 'long';
        $('#btn-long').classList.add('active'); $('#btn-short').classList.remove('active');
        $('#input-entry').value = ''; $('#input-tp').value = ''; $('#input-sl').value = '';
        $('#input-reason').value = '';
        $('#rr-display-open').textContent = '—'; $('#rr-display-open').className = 'rr-display';
        openImageData = null;
        $('#preview-open').style.display = 'none'; $('#preview-open').src = '';
        $('#paste-placeholder-open').style.display = 'flex';
        $('#paste-area-open').classList.remove('has-image');
        $('#file-input-open').value = '';
    }

    $('#btn-new-trade').addEventListener('click', () => { resetNewModal(); openModal('#modal-new-trade'); });
    $('#btn-long').addEventListener('click', () => { selectedDirection = 'long'; $('#btn-long').classList.add('active'); $('#btn-short').classList.remove('active'); updateOpenRR(); });
    $('#btn-short').addEventListener('click', () => { selectedDirection = 'short'; $('#btn-short').classList.add('active'); $('#btn-long').classList.remove('active'); updateOpenRR(); });

    function updateOpenRR() {
        const rr = calcRR($('#input-entry').value, $('#input-tp').value, $('#input-sl').value, selectedDirection);
        const el = $('#rr-display-open');
        if (rr != null) { el.textContent = fmtRR(rr); el.className = 'rr-display ' + (rr >= 0 ? 'positive' : 'negative'); }
        else { el.textContent = '—'; el.className = 'rr-display'; }
    }
    $('#input-entry').addEventListener('input', updateOpenRR);
    $('#input-tp').addEventListener('input', updateOpenRR);
    $('#input-sl').addEventListener('input', updateOpenRR);

    $('#btn-confirm-new').addEventListener('click', async () => {
        const entry = $('#input-entry').value.trim();
        const tp = $('#input-tp').value.trim();
        const sl = $('#input-sl').value.trim();
        if (!entry || !tp || !sl) { shake($('#btn-confirm-new')); return; }

        const id = genId();
        const rr = calcRR(entry, tp, sl, selectedDirection);

        closeModal('#modal-new-trade');
        showLoading('記錄中...');
        try {
            let imgPath = null;
            if (openImageData) {
                imgPath = await gh.uploadImage(id, 'open', openImageData);
            }
            trades.push({
                id, direction: selectedDirection, entry, tp, sl, plannedRR: rr,
                reason: $('#input-reason').value.trim(),
                openTime: Date.now(), openImagePath: imgPath, status: 'open',
                closeTime: null, closeResult: null, closePrice: null, closeRR: null,
                closeImagePath: null, closeNotes: null,
            });
            await persistTrades();
            renderTradeList(); updateStats();
            toast('✅ 交易已記錄', 'success');
        } catch (err) {
            toast('❌ 記錄失敗：' + err.message, 'error');
        }
    });
    $('#btn-cancel-new').addEventListener('click', () => closeModal('#modal-new-trade'));
    $('#modal-close-new').addEventListener('click', () => closeModal('#modal-new-trade'));

    // ==================== CLOSE TRADE ====================
    function resetCloseModal() {
        selectedResult = null;
        $$('.result-btn').forEach(b => b.classList.remove('active'));
        $('#close-tp-group').style.display = 'none';
        $('#input-close-price').value = ''; $('#input-close-notes').value = '';
        const rd = $('#rr-display-close'); rd.textContent = '—'; rd.className = 'rr-display';
        closeImageData = null;
        $('#preview-close').style.display = 'none'; $('#preview-close').src = '';
        $('#paste-placeholder-close').style.display = 'flex';
        $('#paste-area-close').classList.remove('has-image');
        $('#file-input-close').value = '';
    }
    function openCloseModal(id) { closingTradeId = id; resetCloseModal(); openModal('#modal-close-trade'); }

    function selectResult(r) {
        selectedResult = r;
        $$('.result-btn').forEach(b => b.classList.remove('active'));
        $(`[data-result="${r}"]`).classList.add('active');
        const rd = $('#rr-display-close');
        if (r === 'win') { $('#close-tp-group').style.display = 'block'; updateCloseRR(); }
        else { $('#close-tp-group').style.display = 'none'; }
        if (r === 'loss') { rd.textContent = '-1.00R'; rd.className = 'rr-display negative'; }
        else if (r === 'breakeven') { rd.textContent = '0.00R'; rd.className = 'rr-display'; }
    }
    $('#btn-win').addEventListener('click', () => selectResult('win'));
    $('#btn-breakeven').addEventListener('click', () => selectResult('breakeven'));
    $('#btn-loss').addEventListener('click', () => selectResult('loss'));

    function updateCloseRR() {
        if (selectedResult !== 'win' || !closingTradeId) return;
        const trade = trades.find(t => t.id === closingTradeId);
        if (!trade) return;
        const rr = calcCloseRR(trade, $('#input-close-price').value);
        const rd = $('#rr-display-close');
        if (rr != null) { rd.textContent = fmtRR(rr); rd.className = 'rr-display ' + (rr >= 0 ? 'positive' : 'negative'); }
        else { rd.textContent = '—'; rd.className = 'rr-display'; }
    }
    $('#input-close-price').addEventListener('input', updateCloseRR);

    $('#btn-confirm-close').addEventListener('click', async () => {
        if (!selectedResult) { shake($('#btn-confirm-close')); return; }
        if (selectedResult === 'win' && !$('#input-close-price').value.trim()) { shake($('#input-close-price')); return; }
        const trade = trades.find(t => t.id === closingTradeId);
        if (!trade) return;

        closeModal('#modal-close-trade');
        showLoading('結倉中...');
        try {
            let imgPath = null;
            if (closeImageData) {
                imgPath = await gh.uploadImage(trade.id, 'close', closeImageData);
            }
            trade.status = 'closed';
            trade.closeTime = Date.now();
            trade.closeResult = selectedResult;
            trade.closeImagePath = imgPath;
            trade.closeNotes = $('#input-close-notes').value.trim();
            if (selectedResult === 'loss') { trade.closeRR = -1; trade.closePrice = trade.sl; }
            else if (selectedResult === 'breakeven') { trade.closeRR = 0; trade.closePrice = trade.entry; }
            else { trade.closePrice = $('#input-close-price').value.trim(); trade.closeRR = calcCloseRR(trade, trade.closePrice); }

            await persistTrades();
            renderTradeList(); updateStats();
            if (currentView === 'calendar') renderCalendar();
            toast('✅ 已結倉', 'success');
        } catch (err) {
            toast('❌ 結倉失敗：' + err.message, 'error');
        }
    });
    $('#btn-cancel-close').addEventListener('click', () => closeModal('#modal-close-trade'));
    $('#modal-close-close').addEventListener('click', () => closeModal('#modal-close-trade'));

    // ==================== DETAIL ====================
    async function showDetail(id) {
        detailTradeId = id;
        const t = trades.find(x => x.id === id);
        if (!t) return;

        const dir = t.direction === 'long' ? '📈 多' : '📉 空';
        $('#detail-title').textContent = `${dir} — ${fmtDT(t.openTime)}`;

        let html = `<div class="detail-section"><h3>開倉資訊</h3>`;
        if (t.openImagePath) {
            html += `<div class="detail-img-loading" id="img-open-wrap">載入截圖中...</div>`;
        }
        html += `<div class="detail-grid" style="margin-top:10px">
            <div class="detail-field"><span class="lbl">方向</span><span class="val">${t.direction === 'long' ? '多 Long' : '空 Short'}</span></div>
            <div class="detail-field"><span class="lbl">時間</span><span class="val">${fmtDT(t.openTime)}</span></div>
            <div class="detail-field"><span class="lbl">Entry</span><span class="val">${(+t.entry).toFixed(2)}</span></div>
            <div class="detail-field"><span class="lbl">TP</span><span class="val">${(+t.tp).toFixed(2)}</span></div>
            <div class="detail-field"><span class="lbl">SL</span><span class="val">${(+t.sl).toFixed(2)}</span></div>
            <div class="detail-field"><span class="lbl">預計 R:R</span><span class="val">${fmtRR(t.plannedRR)}</span></div>
        </div>`;
        if (t.reason) html += `<div style="margin-top:10px"><span class="lbl" style="font-size:.72rem;color:var(--text-muted);display:block;margin-bottom:4px">開倉原因</span><div class="detail-reason">${escHTML(t.reason)}</div></div>`;
        html += `</div>`;

        if (t.status === 'closed') {
            const resTxt = t.closeResult === 'win' ? '🟢 盈利' : t.closeResult === 'loss' ? '🔴 虧損' : '⚪ 保本';
            const rrColor = t.closeRR > 0 ? 'var(--color-win)' : t.closeRR < 0 ? 'var(--color-loss)' : '';
            html += `<div class="detail-section"><h3>結倉資訊</h3>`;
            if (t.closeImagePath) html += `<div class="detail-img-loading" id="img-close-wrap">載入截圖中...</div>`;
            html += `<div class="detail-grid" style="margin-top:10px">
                <div class="detail-field"><span class="lbl">結果</span><span class="val">${resTxt}</span></div>
                <div class="detail-field"><span class="lbl">時間</span><span class="val">${fmtDT(t.closeTime)}</span></div>
                ${t.closePrice ? `<div class="detail-field"><span class="lbl">平倉價</span><span class="val">${(+t.closePrice).toFixed(2)}</span></div>` : ''}
                <div class="detail-field"><span class="lbl">最終 R:R</span><span class="val" style="color:${rrColor}">${fmtRR(t.closeRR)}</span></div>
            </div>`;
            if (t.closeNotes) html += `<div style="margin-top:10px"><span class="lbl" style="font-size:.72rem;color:var(--text-muted);display:block;margin-bottom:4px">結倉備註</span><div class="detail-reason">${escHTML(t.closeNotes)}</div></div>`;
            html += `</div>`;
        }

        $('#detail-body').innerHTML = html;
        openModal('#modal-detail');

        // Lazy load images
        if (t.openImagePath) loadDetailImg(t.openImagePath, 'img-open-wrap');
        if (t.closeImagePath) loadDetailImg(t.closeImagePath, 'img-close-wrap');
    }

    async function loadDetailImg(path, wrapperId) {
        try {
            const dataUrl = await gh.getImage(path);
            const wrap = document.getElementById(wrapperId);
            if (wrap && dataUrl) {
                wrap.innerHTML = `<img class="detail-screenshot" src="${dataUrl}" onclick="window.open(this.src)"/>`;
            } else if (wrap) {
                wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem">截圖未找到</p>';
            }
        } catch {
            const wrap = document.getElementById(wrapperId);
            if (wrap) wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem">截圖載入失敗</p>';
        }
    }

    $('#btn-delete-trade').addEventListener('click', async () => {
        if (!detailTradeId) return;
        if (!confirm('確定要刪除這筆交易？')) return;
        trades = trades.filter(t => t.id !== detailTradeId);
        closeModal('#modal-detail');
        try {
            await persistTrades();
            renderTradeList(); updateStats();
            if (currentView === 'calendar') renderCalendar();
            toast('✅ 已刪除', 'success');
        } catch (err) {
            toast('❌ 刪除失敗：' + err.message, 'error');
        }
    });
    $('#btn-close-detail').addEventListener('click', () => closeModal('#modal-detail'));
    $('#modal-close-detail').addEventListener('click', () => closeModal('#modal-detail'));

    // ==================== CALENDAR ====================
    const MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const WDAYS = ['日','一','二','三','四','五','六'];

    function renderCalendar() {
        $('#cal-year').textContent = calendarYear;
        const grid = $('#calendar-grid');
        grid.innerHTML = '';

        const dateMap = {};
        trades.forEach(t => {
            if (t.status !== 'closed' || t.closeRR == null) return;
            const d = new Date(t.closeTime);
            const k = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
            if (!dateMap[k]) dateMap[k] = { total: 0, count: 0 };
            dateMap[k].total += t.closeRR; dateMap[k].count++;
        });

        const today = new Date();
        const todayK = `${today.getFullYear()}-${(today.getMonth()+1).toString().padStart(2,'0')}-${today.getDate().toString().padStart(2,'0')}`;

        for (let m = 0; m < 12; m++) {
            const mDiv = document.createElement('div'); mDiv.className = 'cal-month';
            const dim = new Date(calendarYear, m + 1, 0).getDate();

            let mTotal = 0, mCount = 0;
            for (let d = 1; d <= dim; d++) {
                const k = `${calendarYear}-${(m+1).toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
                if (dateMap[k]) { mTotal += dateMap[k].total; mCount += dateMap[k].count; }
            }
            let mrrText = '—', mrrCls = 'zero';
            if (mCount > 0) { const avg = mTotal / mCount; mrrText = fmtRR(avg); mrrCls = avg > 0 ? 'pos' : avg < 0 ? 'neg' : 'zero'; }

            mDiv.innerHTML = `<div class="cal-month-header"><span class="cal-month-name">${MONTHS[m]}</span><span class="cal-month-rr ${mrrCls}">${mrrText}</span></div>`;

            const wdDiv = document.createElement('div'); wdDiv.className = 'cal-weekdays';
            WDAYS.forEach(w => { const s = document.createElement('span'); s.className = 'cal-weekday'; s.textContent = w; wdDiv.appendChild(s); });
            mDiv.appendChild(wdDiv);

            const daysDiv = document.createElement('div'); daysDiv.className = 'cal-days';
            const fd = new Date(calendarYear, m, 1).getDay();
            for (let i = 0; i < fd; i++) { const e = document.createElement('div'); e.className = 'cal-day empty'; daysDiv.appendChild(e); }
            for (let d = 1; d <= dim; d++) {
                const dayEl = document.createElement('div'); dayEl.className = 'cal-day'; dayEl.textContent = d;
                const k = `${calendarYear}-${(m+1).toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
                if (k === todayK) dayEl.classList.add('today');
                if (dateMap[k]) {
                    dayEl.classList.add('has-trade');
                    const avg = dateMap[k].total / dateMap[k].count;
                    dayEl.classList.add(avg > 0 ? 'rr-pos' : avg < 0 ? 'rr-neg' : 'rr-zero');
                    dayEl.title = `${dateMap[k].count} 筆 | ${fmtRR(avg)}`;
                }
                daysDiv.appendChild(dayEl);
            }
            mDiv.appendChild(daysDiv);
            grid.appendChild(mDiv);
        }
    }
    $('#cal-prev-year').addEventListener('click', () => { calendarYear--; renderCalendar(); });
    $('#cal-next-year').addEventListener('click', () => { calendarYear++; renderCalendar(); });

    // ==================== INIT ====================
    showAuth();

})();
