/* ======================================================
   Sasella Trading Journal — Application Logic
   ====================================================== */

(function () {
    'use strict';

    // ===== Storage =====
    const STORAGE_KEY = 'sasella_trades';

    function loadTrades() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    function saveTrades(trades) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // ===== State =====
    let trades = loadTrades();
    let currentView = 'journal';
    let calendarYear = new Date().getFullYear();
    let closingTradeId = null;

    // Temp image data for open/close
    let openImageData = null;
    let closeImageData = null;

    // ===== DOM Refs =====
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // Nav
    const tabJournal = $('#tab-journal');
    const tabCalendar = $('#tab-calendar');
    const viewJournal = $('#view-journal');
    const viewCalendar = $('#view-calendar');
    const btnNewTrade = $('#btn-new-trade');

    // Stats
    const statTotal = $('#stat-total');
    const statOpen = $('#stat-open');
    const statWinrate = $('#stat-winrate');
    const statAvgRR = $('#stat-avg-rr');

    // Trade list
    const tradeList = $('#trade-list');
    const emptyState = $('#empty-state');

    // New trade modal
    const modalNew = $('#modal-new-trade');
    const btnLong = $('#btn-long');
    const btnShort = $('#btn-short');
    const inputEntry = $('#input-entry');
    const inputTP = $('#input-tp');
    const inputSL = $('#input-sl');
    const rrDisplayOpen = $('#rr-display-open');
    const inputReason = $('#input-reason');
    const btnConfirmNew = $('#btn-confirm-new');
    const btnCancelNew = $('#btn-cancel-new');
    const modalCloseNew = $('#modal-close-new');
    const pasteAreaOpen = $('#paste-area-open');
    const previewOpen = $('#preview-open');
    const placeholderOpen = $('#paste-placeholder-open');
    const fileInputOpen = $('#file-input-open');

    // Close trade modal
    const modalClose = $('#modal-close-trade');
    const btnWin = $('#btn-win');
    const btnBreakeven = $('#btn-breakeven');
    const btnLoss = $('#btn-loss');
    const closeTpGroup = $('#close-tp-group');
    const inputClosePrice = $('#input-close-price');
    const rrDisplayClose = $('#rr-display-close');
    const inputCloseNotes = $('#input-close-notes');
    const btnConfirmClose = $('#btn-confirm-close');
    const btnCancelClose = $('#btn-cancel-close');
    const modalCloseClose = $('#modal-close-close');
    const pasteAreaClose = $('#paste-area-close');
    const previewClose = $('#preview-close');
    const placeholderClose = $('#paste-placeholder-close');
    const fileInputClose = $('#file-input-close');

    // Detail modal
    const modalDetail = $('#modal-detail');
    const detailTitle = $('#detail-title');
    const detailBody = $('#detail-body');
    const btnDeleteTrade = $('#btn-delete-trade');
    const btnCloseDetail = $('#btn-close-detail');
    const modalCloseDetail = $('#modal-close-detail');

    // Calendar
    const calYear = $('#cal-year');
    const calPrev = $('#cal-prev-year');
    const calNext = $('#cal-next-year');
    const calendarGrid = $('#calendar-grid');

    // ===== Utilities =====
    function formatDateTime(ts) {
        const d = new Date(ts);
        const pad = (n) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatDate(ts) {
        const d = new Date(ts);
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    }

    function calcRR(entry, tp, sl, direction) {
        const e = parseFloat(entry);
        const t = parseFloat(tp);
        const s = parseFloat(sl);
        if (isNaN(e) || isNaN(t) || isNaN(s)) return null;

        let risk, reward;
        if (direction === 'long') {
            risk = e - s;
            reward = t - e;
        } else {
            risk = s - e;
            reward = e - t;
        }

        if (risk <= 0) return null;
        return reward / risk;
    }

    function calcCloseRR(trade, closePrice) {
        const e = parseFloat(trade.entry);
        const c = parseFloat(closePrice);
        const s = parseFloat(trade.sl);
        if (isNaN(e) || isNaN(c) || isNaN(s)) return null;

        let risk, reward;
        if (trade.direction === 'long') {
            risk = e - s;
            reward = c - e;
        } else {
            risk = s - e;
            reward = e - c;
        }

        if (risk <= 0) return null;
        return reward / risk;
    }

    function formatRR(rr) {
        if (rr === null || rr === undefined) return '—';
        const sign = rr >= 0 ? '+' : '';
        return sign + rr.toFixed(2) + 'R';
    }

    // ===== Navigation =====
    function switchView(view) {
        currentView = view;
        $$('.nav-tab').forEach(t => t.classList.remove('active'));
        $$('.view').forEach(v => v.classList.remove('active'));

        if (view === 'journal') {
            tabJournal.classList.add('active');
            viewJournal.classList.add('active');
        } else {
            tabCalendar.classList.add('active');
            viewCalendar.classList.add('active');
            renderCalendar();
        }
    }

    tabJournal.addEventListener('click', () => switchView('journal'));
    tabCalendar.addEventListener('click', () => switchView('calendar'));

    // ===== Stats =====
    function updateStats() {
        const total = trades.length;
        const open = trades.filter(t => t.status === 'open').length;
        const closed = trades.filter(t => t.status === 'closed');
        const wins = closed.filter(t => t.closeResult === 'win');
        const winrate = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(0) + '%' : '—';
        const rrs = closed.map(t => t.closeRR).filter(r => r !== null && r !== undefined);
        const avgRR = rrs.length > 0 ? formatRR(rrs.reduce((a, b) => a + b, 0) / rrs.length) : '—';

        statTotal.textContent = total;
        statOpen.textContent = open;
        statWinrate.textContent = winrate;
        statAvgRR.textContent = avgRR;
    }

    // ===== Trade List Rendering =====
    function renderTradeList() {
        // Clear existing cards (keep empty state)
        tradeList.querySelectorAll('.trade-card').forEach(c => c.remove());

        if (trades.length === 0) {
            emptyState.style.display = 'flex';
            return;
        }
        emptyState.style.display = 'none';

        // Sort by openTime descending (newest first)
        const sorted = [...trades].sort((a, b) => b.openTime - a.openTime);

        sorted.forEach(trade => {
            const card = document.createElement('div');
            card.className = `trade-card direction-${trade.direction}`;
            card.dataset.id = trade.id;

            // Thumbnail
            let thumbHTML;
            if (trade.openImage) {
                thumbHTML = `<img class="trade-card-thumb" src="${trade.openImage}" alt="trade screenshot"/>`;
            } else {
                thumbHTML = `<div class="trade-card-thumb-placeholder">${trade.direction === 'long' ? '📈' : '📉'}</div>`;
            }

            // RR badge
            let rrClass, rrText;
            if (trade.status === 'open') {
                rrClass = 'open';
                rrText = formatRR(trade.plannedRR);
            } else {
                if (trade.closeResult === 'win') {
                    rrClass = 'win';
                } else if (trade.closeResult === 'loss') {
                    rrClass = 'loss';
                } else {
                    rrClass = 'breakeven';
                }
                rrText = formatRR(trade.closeRR);
            }

            // Status
            const statusClass = trade.status === 'open' ? 'status-open' : 'status-closed';
            const statusText = trade.status === 'open' ? '持倉中' : '已平倉';

            // Close button (only for open)
            const closeBtnHTML = trade.status === 'open'
                ? `<button class="trade-card-close-btn" data-close-id="${trade.id}">⚡ 結倉</button>`
                : '';

            card.innerHTML = `
                ${thumbHTML}
                <div class="trade-card-info">
                    <div class="trade-card-top">
                        <span class="trade-direction-badge ${trade.direction}">${trade.direction === 'long' ? '多 LONG' : '空 SHORT'}</span>
                        <span class="trade-card-time">${formatDateTime(trade.openTime)}</span>
                    </div>
                    <div class="trade-card-prices">
                        <span><span class="label">Entry</span> ${parseFloat(trade.entry).toFixed(2)}</span>
                        <span><span class="label">TP</span> ${parseFloat(trade.tp).toFixed(2)}</span>
                        <span><span class="label">SL</span> ${parseFloat(trade.sl).toFixed(2)}</span>
                    </div>
                </div>
                <div class="trade-card-right">
                    <span class="trade-rr-badge ${rrClass}">${rrText}</span>
                    <span class="trade-status ${statusClass}">${statusText}</span>
                    ${closeBtnHTML}
                </div>
            `;

            // Click card -> detail (but not close btn)
            card.addEventListener('click', (e) => {
                if (e.target.closest('.trade-card-close-btn')) return;
                showDetailModal(trade.id);
            });

            tradeList.appendChild(card);
        });

        // Attach close buttons
        tradeList.querySelectorAll('.trade-card-close-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openCloseModal(btn.dataset.closeId);
            });
        });
    }

    // ===== Image Handling =====
    function setupPasteArea(pasteArea, preview, placeholder, fileInput, setData) {
        // Click to upload
        pasteArea.addEventListener('click', (e) => {
            if (e.target === preview) return;
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            readImageFile(file, preview, placeholder, pasteArea, setData);
        });

        // Paste
        pasteArea.addEventListener('paste', handlePaste);

        function handlePaste(e) {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    readImageFile(file, preview, placeholder, pasteArea, setData);
                    return;
                }
            }
        }
    }

    // Global paste handler (works when modal is open)
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                // Check which modal is open
                if (modalNew.classList.contains('show')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    readImageFile(file, previewOpen, placeholderOpen, pasteAreaOpen, (data) => { openImageData = data; });
                    return;
                }
                if (modalClose.classList.contains('show')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    readImageFile(file, previewClose, placeholderClose, pasteAreaClose, (data) => { closeImageData = data; });
                    return;
                }
            }
        }
    });

    function readImageFile(file, preview, placeholder, area, setData) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            preview.src = dataUrl;
            preview.style.display = 'block';
            placeholder.style.display = 'none';
            area.classList.add('has-image');
            setData(dataUrl);
        };
        reader.readAsDataURL(file);
    }

    setupPasteArea(pasteAreaOpen, previewOpen, placeholderOpen, fileInputOpen, (data) => { openImageData = data; });
    setupPasteArea(pasteAreaClose, previewClose, placeholderClose, fileInputClose, (data) => { closeImageData = data; });

    // ===== New Trade Modal =====
    let selectedDirection = 'long';

    btnNewTrade.addEventListener('click', () => {
        resetNewModal();
        modalNew.classList.add('show');
    });

    function resetNewModal() {
        selectedDirection = 'long';
        btnLong.classList.add('active');
        btnShort.classList.remove('active');
        inputEntry.value = '';
        inputTP.value = '';
        inputSL.value = '';
        inputReason.value = '';
        rrDisplayOpen.textContent = '—';
        rrDisplayOpen.className = 'rr-display';
        openImageData = null;
        previewOpen.style.display = 'none';
        previewOpen.src = '';
        placeholderOpen.style.display = 'flex';
        pasteAreaOpen.classList.remove('has-image');
        fileInputOpen.value = '';
    }

    btnLong.addEventListener('click', () => {
        selectedDirection = 'long';
        btnLong.classList.add('active');
        btnShort.classList.remove('active');
        updateOpenRR();
    });
    btnShort.addEventListener('click', () => {
        selectedDirection = 'short';
        btnShort.classList.add('active');
        btnLong.classList.remove('active');
        updateOpenRR();
    });

    function updateOpenRR() {
        const rr = calcRR(inputEntry.value, inputTP.value, inputSL.value, selectedDirection);
        if (rr !== null) {
            rrDisplayOpen.textContent = formatRR(rr);
            rrDisplayOpen.className = 'rr-display ' + (rr >= 0 ? 'positive' : 'negative');
        } else {
            rrDisplayOpen.textContent = '—';
            rrDisplayOpen.className = 'rr-display';
        }
    }

    inputEntry.addEventListener('input', updateOpenRR);
    inputTP.addEventListener('input', updateOpenRR);
    inputSL.addEventListener('input', updateOpenRR);

    btnConfirmNew.addEventListener('click', () => {
        const entry = inputEntry.value.trim();
        const tp = inputTP.value.trim();
        const sl = inputSL.value.trim();

        if (!entry || !tp || !sl) {
            shakeElement(btnConfirmNew);
            return;
        }

        const rr = calcRR(entry, tp, sl, selectedDirection);

        const trade = {
            id: generateId(),
            direction: selectedDirection,
            entry,
            tp,
            sl,
            plannedRR: rr,
            reason: inputReason.value.trim(),
            openTime: Date.now(),
            openImage: openImageData,
            status: 'open',
            closeTime: null,
            closeResult: null,
            closePrice: null,
            closeRR: null,
            closeImage: null,
            closeNotes: null,
        };

        trades.push(trade);
        saveTrades(trades);
        closeModal(modalNew);
        renderTradeList();
        updateStats();
    });

    btnCancelNew.addEventListener('click', () => closeModal(modalNew));
    modalCloseNew.addEventListener('click', () => closeModal(modalNew));

    // ===== Close Trade Modal =====
    let selectedResult = null;

    function openCloseModal(tradeId) {
        closingTradeId = tradeId;
        resetCloseModal();
        modalClose.classList.add('show');
    }

    function resetCloseModal() {
        selectedResult = null;
        $$('.result-btn').forEach(b => b.classList.remove('active'));
        closeTpGroup.style.display = 'none';
        inputClosePrice.value = '';
        inputCloseNotes.value = '';
        rrDisplayClose.textContent = '—';
        rrDisplayClose.className = 'rr-display';
        closeImageData = null;
        previewClose.style.display = 'none';
        previewClose.src = '';
        placeholderClose.style.display = 'flex';
        pasteAreaClose.classList.remove('has-image');
        fileInputClose.value = '';
    }

    btnWin.addEventListener('click', () => selectResult('win'));
    btnBreakeven.addEventListener('click', () => selectResult('breakeven'));
    btnLoss.addEventListener('click', () => selectResult('loss'));

    function selectResult(result) {
        selectedResult = result;
        $$('.result-btn').forEach(b => b.classList.remove('active'));
        $(`[data-result="${result}"]`).classList.add('active');

        if (result === 'win') {
            closeTpGroup.style.display = 'block';
            updateCloseRR();
        } else {
            closeTpGroup.style.display = 'none';
            if (result === 'loss') {
                rrDisplayClose.textContent = '-1.00R';
                rrDisplayClose.className = 'rr-display negative';
            } else {
                rrDisplayClose.textContent = '0.00R';
                rrDisplayClose.className = 'rr-display';
            }
        }
    }

    function updateCloseRR() {
        if (selectedResult !== 'win' || !closingTradeId) return;
        const trade = trades.find(t => t.id === closingTradeId);
        if (!trade) return;

        const rr = calcCloseRR(trade, inputClosePrice.value);
        if (rr !== null) {
            rrDisplayClose.textContent = formatRR(rr);
            rrDisplayClose.className = 'rr-display ' + (rr >= 0 ? 'positive' : 'negative');
        } else {
            rrDisplayClose.textContent = '—';
            rrDisplayClose.className = 'rr-display';
        }
    }

    inputClosePrice.addEventListener('input', updateCloseRR);

    btnConfirmClose.addEventListener('click', () => {
        if (!selectedResult) {
            shakeElement(btnConfirmClose);
            return;
        }

        if (selectedResult === 'win' && !inputClosePrice.value.trim()) {
            shakeElement(inputClosePrice);
            return;
        }

        const trade = trades.find(t => t.id === closingTradeId);
        if (!trade) return;

        trade.status = 'closed';
        trade.closeTime = Date.now();
        trade.closeResult = selectedResult;
        trade.closeImage = closeImageData;
        trade.closeNotes = inputCloseNotes.value.trim();

        if (selectedResult === 'loss') {
            trade.closeRR = -1;
            trade.closePrice = trade.sl;
        } else if (selectedResult === 'breakeven') {
            trade.closeRR = 0;
            trade.closePrice = trade.entry;
        } else {
            trade.closePrice = inputClosePrice.value.trim();
            trade.closeRR = calcCloseRR(trade, trade.closePrice);
        }

        saveTrades(trades);
        closeModal(modalClose);
        renderTradeList();
        updateStats();

        if (currentView === 'calendar') {
            renderCalendar();
        }
    });

    btnCancelClose.addEventListener('click', () => closeModal(modalClose));
    modalCloseClose.addEventListener('click', () => closeModal(modalClose));

    // ===== Detail Modal =====
    let detailTradeId = null;

    function showDetailModal(tradeId) {
        detailTradeId = tradeId;
        const trade = trades.find(t => t.id === tradeId);
        if (!trade) return;

        const dir = trade.direction === 'long' ? '📈 多 (Long)' : '📉 空 (Short)';
        detailTitle.textContent = `${dir} — ${formatDateTime(trade.openTime)}`;

        let html = '';

        // Open section
        html += `<div class="detail-section">`;
        html += `<h3>開倉資訊</h3>`;
        if (trade.openImage) {
            html += `<img class="detail-screenshot" src="${trade.openImage}" alt="開倉截圖" onclick="window.open(this.src)"/>`;
        }
        html += `<div class="detail-grid" style="margin-top:12px;">`;
        html += `<div class="detail-field"><span class="label">方向</span><span class="value">${trade.direction === 'long' ? '多 Long' : '空 Short'}</span></div>`;
        html += `<div class="detail-field"><span class="label">開倉時間</span><span class="value">${formatDateTime(trade.openTime)}</span></div>`;
        html += `<div class="detail-field"><span class="label">開倉價格</span><span class="value">${parseFloat(trade.entry).toFixed(2)}</span></div>`;
        html += `<div class="detail-field"><span class="label">TP 價格</span><span class="value">${parseFloat(trade.tp).toFixed(2)}</span></div>`;
        html += `<div class="detail-field"><span class="label">SL 價格</span><span class="value">${parseFloat(trade.sl).toFixed(2)}</span></div>`;
        html += `<div class="detail-field"><span class="label">預計盈虧比</span><span class="value">${formatRR(trade.plannedRR)}</span></div>`;
        html += `</div>`;

        if (trade.reason) {
            html += `<div style="margin-top:12px;"><span class="label" style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:6px;">開倉原因</span>`;
            html += `<div class="detail-reason">${escapeHTML(trade.reason)}</div></div>`;
        }
        html += `</div>`;

        // Close section (if closed)
        if (trade.status === 'closed') {
            html += `<div class="detail-section">`;
            html += `<h3>結倉資訊</h3>`;
            if (trade.closeImage) {
                html += `<img class="detail-screenshot" src="${trade.closeImage}" alt="結倉截圖" onclick="window.open(this.src)"/>`;
            }

            const resultText = trade.closeResult === 'win' ? '🟢 盈利' : trade.closeResult === 'loss' ? '🔴 虧損' : '⚪ 保本';
            html += `<div class="detail-grid" style="margin-top:12px;">`;
            html += `<div class="detail-field"><span class="label">結果</span><span class="value">${resultText}</span></div>`;
            html += `<div class="detail-field"><span class="label">平倉時間</span><span class="value">${formatDateTime(trade.closeTime)}</span></div>`;
            if (trade.closePrice) {
                html += `<div class="detail-field"><span class="label">平倉價格</span><span class="value">${parseFloat(trade.closePrice).toFixed(2)}</span></div>`;
            }
            html += `<div class="detail-field"><span class="label">最終盈虧比</span><span class="value" style="color:${trade.closeRR > 0 ? 'var(--color-win)' : trade.closeRR < 0 ? 'var(--color-loss)' : 'var(--text-secondary)'}">${formatRR(trade.closeRR)}</span></div>`;
            html += `</div>`;

            if (trade.closeNotes) {
                html += `<div style="margin-top:12px;"><span class="label" style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:6px;">結倉備註</span>`;
                html += `<div class="detail-reason">${escapeHTML(trade.closeNotes)}</div></div>`;
            }
            html += `</div>`;
        }

        detailBody.innerHTML = html;
        modalDetail.classList.add('show');
    }

    btnCloseDetail.addEventListener('click', () => closeModal(modalDetail));
    modalCloseDetail.addEventListener('click', () => closeModal(modalDetail));

    btnDeleteTrade.addEventListener('click', () => {
        if (!detailTradeId) return;
        if (!confirm('確定要刪除這筆交易記錄？此操作不可撤銷。')) return;

        trades = trades.filter(t => t.id !== detailTradeId);
        saveTrades(trades);
        closeModal(modalDetail);
        renderTradeList();
        updateStats();
        if (currentView === 'calendar') renderCalendar();
    });

    // ===== Modal Helpers =====
    function closeModal(modal) {
        modal.classList.remove('show');
    }

    // Close on overlay click
    [modalNew, modalClose, modalDetail].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(modal);
        });
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            [modalNew, modalClose, modalDetail].forEach(m => closeModal(m));
        }
    });

    function shakeElement(el) {
        el.style.animation = 'none';
        el.offsetHeight; // trigger reflow
        el.style.animation = 'shake 0.4s ease';
        setTimeout(() => { el.style.animation = 'none'; }, 400);
    }

    // Add shake keyframes
    const shakeStyle = document.createElement('style');
    shakeStyle.textContent = `
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20% { transform: translateX(-6px); }
            40% { transform: translateX(6px); }
            60% { transform: translateX(-4px); }
            80% { transform: translateX(4px); }
        }
    `;
    document.head.appendChild(shakeStyle);

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ===== Calendar =====
    const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

    function renderCalendar() {
        calYear.textContent = calendarYear;
        calendarGrid.innerHTML = '';

        // Build a map: dateKey -> aggregated RR for closed trades
        const dateRRMap = {}; // 'YYYY-MM-DD' -> { totalRR, count }

        trades.forEach(trade => {
            if (trade.status !== 'closed') return;
            const rr = trade.closeRR;
            if (rr === null || rr === undefined) return;

            const closeDate = new Date(trade.closeTime);
            const key = `${closeDate.getFullYear()}-${(closeDate.getMonth() + 1).toString().padStart(2, '0')}-${closeDate.getDate().toString().padStart(2, '0')}`;

            if (!dateRRMap[key]) {
                dateRRMap[key] = { totalRR: 0, count: 0 };
            }
            dateRRMap[key].totalRR += rr;
            dateRRMap[key].count += 1;
        });

        const today = new Date();
        const todayKey = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;

        for (let month = 0; month < 12; month++) {
            const monthDiv = document.createElement('div');
            monthDiv.className = 'cal-month';

            // Compute monthly avg RR
            let monthRRTotal = 0;
            let monthRRCount = 0;

            const daysInMonth = new Date(calendarYear, month + 1, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
                const key = `${calendarYear}-${(month + 1).toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
                if (dateRRMap[key]) {
                    monthRRTotal += dateRRMap[key].totalRR;
                    monthRRCount += dateRRMap[key].count;
                }
            }

            let monthRRText = '—';
            let monthRRClass = 'neutral';
            if (monthRRCount > 0) {
                const avg = monthRRTotal / monthRRCount;
                monthRRText = formatRR(avg);
                monthRRClass = avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral';
            }

            // Header
            const headerDiv = document.createElement('div');
            headerDiv.className = 'cal-month-header';
            headerDiv.innerHTML = `
                <span class="cal-month-name">${MONTH_NAMES[month]}</span>
                <span class="cal-month-rr ${monthRRClass}">${monthRRText}</span>
            `;
            monthDiv.appendChild(headerDiv);

            // Weekday headers
            const weekdaysDiv = document.createElement('div');
            weekdaysDiv.className = 'cal-weekdays';
            WEEKDAY_NAMES.forEach(wd => {
                const span = document.createElement('span');
                span.className = 'cal-weekday';
                span.textContent = wd;
                weekdaysDiv.appendChild(span);
            });
            monthDiv.appendChild(weekdaysDiv);

            // Days grid
            const daysDiv = document.createElement('div');
            daysDiv.className = 'cal-days';

            const firstDay = new Date(calendarYear, month, 1).getDay(); // 0=Sun

            // Empty cells before 1st
            for (let i = 0; i < firstDay; i++) {
                const empty = document.createElement('div');
                empty.className = 'cal-day empty';
                daysDiv.appendChild(empty);
            }

            for (let d = 1; d <= daysInMonth; d++) {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'cal-day';
                dayDiv.textContent = d;

                const key = `${calendarYear}-${(month + 1).toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;

                if (key === todayKey) {
                    dayDiv.classList.add('today');
                }

                if (dateRRMap[key]) {
                    dayDiv.classList.add('has-trade');
                    const dayRR = dateRRMap[key].totalRR / dateRRMap[key].count;

                    if (dayRR > 0) {
                        dayDiv.classList.add('rr-positive');
                    } else if (dayRR < 0) {
                        dayDiv.classList.add('rr-negative');
                    } else {
                        dayDiv.classList.add('rr-zero');
                    }

                    dayDiv.title = `${dateRRMap[key].count} 筆交易 | 平均 ${formatRR(dayRR)}`;
                }

                daysDiv.appendChild(dayDiv);
            }

            monthDiv.appendChild(daysDiv);
            calendarGrid.appendChild(monthDiv);
        }
    }

    calPrev.addEventListener('click', () => {
        calendarYear--;
        renderCalendar();
    });
    calNext.addEventListener('click', () => {
        calendarYear++;
        renderCalendar();
    });

    // ===== Export / Import (via console for now) =====
    window.exportTrades = function () {
        const json = JSON.stringify(trades, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `trading-journal-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    window.importTrades = function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    if (Array.isArray(imported)) {
                        trades = imported;
                        saveTrades(trades);
                        renderTradeList();
                        updateStats();
                        if (currentView === 'calendar') renderCalendar();
                        alert('匯入成功！共 ' + trades.length + ' 筆交易');
                    }
                } catch {
                    alert('匯入失敗：JSON 格式錯誤');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    // ===== Init =====
    renderTradeList();
    updateStats();

})();
