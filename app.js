// Jewelry Studio Pro - Main Application
(function() {
    'use strict';

    // ============================================
    // STATE MANAGEMENT
    // ============================================
    const state = {
        queue: [],
        isProcessing: false,
        abortController: null,
        worker: null
    };

    // ============================================
    // DOM ELEMENTS
    // ============================================
    const elements = {
        apiKey: document.getElementById('apiKey'),
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('fileInput'),
        resultsGrid: document.getElementById('resultsGrid'),
        startBtn: document.getElementById('startBtn'),
        stopBtn: document.getElementById('stopBtn'),
        zipDownloadBtn: document.getElementById('zipDownloadBtn'),
        statsLabel: document.getElementById('statsLabel'),
        progressFill: document.getElementById('progressFill'),
        debugConsole: document.getElementById('debugConsole'),
        stylePrompt: document.getElementById('stylePrompt'),
        resolution: document.getElementById('resolution'),
        aspectRatio: document.getElementById('aspectRatio')
    };

    // ============================================
    // UTILITIES
    // ============================================
    function log(message, type = 'info') {
        const time = new Date().toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const div = document.createElement('div');
        if (type === 'error') div.className = 'log-error';
        if (type === 'warn') div.className = 'log-warn';
        div.innerHTML = `[${time}] ${message}`;
        elements.debugConsole.appendChild(div);
        elements.debugConsole.scrollTop = elements.debugConsole.scrollHeight;
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function updateStats() {
        const done = state.queue.filter(item => item.status === 'done').length;
        elements.statsLabel.textContent = `${done} / ${state.queue.length} Images in Batch`;
        elements.zipDownloadBtn.disabled = done === 0;
    }

    // ============================================
    // API KEY STORAGE
    // ============================================
    function loadApiKey() {
        const saved = localStorage.getItem('jewelry_api_key');
        if (saved) elements.apiKey.value = saved;
    }

    function saveApiKey() {
        localStorage.setItem('jewelry_api_key', elements.apiKey.value);
    }

    // ============================================
    // FILE HANDLING
    // ============================================
    function initFileHandling() {
        elements.dropzone.onclick = () => elements.fileInput.click();
        elements.dropzone.ondragover = (e) => {
            e.preventDefault();
            elements.dropzone.classList.add('dragover');
        };
        elements.dropzone.ondragleave = () => elements.dropzone.classList.remove('dragover');
        elements.dropzone.ondrop = (e) => {
            e.preventDefault();
            elements.dropzone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        };
        elements.fileInput.onchange = (e) => handleFiles(e.target.files);
    }

    async function handleFiles(files) {
        log(`Analyzing ${files.length} uploaded items...`);

        for (const file of files) {
            if (file.name.endsWith('.zip')) {
                await handleZipFile(file);
            } else if (file.type.startsWith('image/')) {
                await addImageToQueue(file);
            }
        }
        updateStats();
    }

    async function handleZipFile(file) {
        try {
            log(`Extracting ZIP: ${file.name}`);
            const zip = await JSZip.loadAsync(file);
            const imgFiles = [];

            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && /\.(jpe?g|png|webp|bmp)$/i.test(zipEntry.name)) {
                    imgFiles.push(zipEntry);
                }
            });

            log(`Found ${imgFiles.length} images in ZIP.`);

            for (const imgEntry of imgFiles) {
                const blob = await imgEntry.async('blob');
                const proxyFile = new File([blob], imgEntry.name, { type: 'image/png' });
                await addImageToQueue(proxyFile);
            }
        } catch (e) {
            log(`Error reading ZIP file: ${e.message}`, 'error');
        }
    }

    function addImageToQueue(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);

            reader.onload = () => {
                const item = {
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name,
                    mime: file.type,
                    data: reader.result.split(',')[1],
                    preview: reader.result,
                    status: 'pending',
                    result: null
                };

                state.queue.push(item);
                renderCard(item);
                resolve();
            };
        });
    }

    // ============================================
    // UI RENDERING
    // ============================================
    function renderCard(item) {
        const div = document.createElement('div');
        div.className = 'result-card';
        div.id = `card-${item.id}`;
        div.innerHTML = `
            <div class="status-pill" id="status-${item.id}">Pending</div>
            <button class="remove-btn" id="remove-${item.id}" title="Long press to remove">
                <i data-lucide="x"></i>
            </button>
            <img src="${item.preview}" id="img-${item.id}" alt="${item.name}">
            <div class="card-meta">
                <div class="card-text">
                    <div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.name}</div>
                    <div id="desc-${item.id}">Waiting...</div>
                </div>
                <button class="btn btn-icon" id="dl-${item.id}" onclick="downloadSingle('${item.id}')" style="display:none">
                    <i data-lucide="download"></i>
                </button>
            </div>
        `;
        elements.resultsGrid.appendChild(div);
        lucide.createIcons();

        // Add long press handler
        initLongPress(`remove-${item.id}`, item.id);
    }

    function initLongPress(btnId, itemId) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        let pressTimer = null;
        let isRemoved = false;

        const startPress = (e) => {
            e.preventDefault();
            isRemoved = false;
            btn.classList.add('pressing');
            btn.style.animation = 'pulse 0.5s ease-in-out infinite';

            pressTimer = setTimeout(() => {
                // Long press triggered
                isRemoved = true;
                btn.classList.remove('pressing');
                btn.style.animation = '';
                removeItem(itemId);
            }, 2000);
        };

        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            btn.classList.remove('pressing');
            btn.style.animation = '';
        };

        btn.addEventListener('mousedown', startPress);
        btn.addEventListener('mouseup', cancelPress);
        btn.addEventListener('mouseleave', cancelPress);
        btn.addEventListener('touchstart', startPress);
        btn.addEventListener('touchend', cancelPress);
        btn.addEventListener('touchcancel', cancelPress);
    }

    function removeItem(itemId) {
        const index = state.queue.findIndex(i => i.id === itemId);
        if (index === -1) return;

        const item = state.queue[index];
        state.queue.splice(index, 1);

        const card = document.getElementById(`card-${itemId}`);
        if (card) {
            card.style.transform = 'scale(0.8)';
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 200);
        }

        log(`Removed: ${item.name}`);
        updateStats();
    }

    function updateCardStatus(itemId, status, description = null) {
        const statusEl = document.getElementById(`status-${itemId}`);
        const descEl = document.getElementById(`desc-${itemId}`);

        if (statusEl) statusEl.innerText = status;
        if (descEl && description) descEl.innerText = description;
    }

    function updateCardResult(itemId, imageUrl) {
        const imgEl = document.getElementById(`img-${itemId}`);
        const dlBtn = document.getElementById(`dl-${itemId}`);

        if (imgEl) imgEl.src = imageUrl;
        if (dlBtn) dlBtn.style.display = 'flex';
    }

    // ============================================
    // WORKER COMMUNICATION
    // ============================================
    function initWorker() {
        const cacheBuster = '?t=' + Date.now();
        state.worker = new Worker('worker.js' + cacheBuster);

        state.worker.onmessage = (e) => {
            const { type, data } = e.data;
            handleWorkerMessage(type, data);
        };

        state.worker.onerror = (e) => {
            log(`Worker error: ${e.message}`, 'error');
        };
    }

    function handleWorkerMessage(type, data) {
        switch (type) {
            case 'log':
                log(data.message, data.level);
                break;

            case 'success':
                const item = state.queue.find(i => i.id === data.itemId);
                if (item) {
                    item.result = data.imageUrl;
                    item.status = 'done';
                    updateCardStatus(data.itemId, 'Completed', data.description);
                    updateCardResult(data.itemId, data.imageUrl);
                    log(`Success: ${item.name}`);
                }
                break;

            case 'retry':
                updateCardStatus(data.itemId, `Retry ${data.attempt}/3`);
                log(`Retrying ${data.name} (Attempt ${data.attempt}/3)...`, 'warn');
                break;

            case 'failed':
                updateCardStatus(data.itemId, 'Failed', 'Check logs/API key');
                log(`Failed: ${data.name} - ${data.error}`, 'error');
                break;

            case 'progress':
                const pct = (data.current / data.total) * 100;
                elements.progressFill.style.width = `${pct}%`;
                break;

            case 'complete':
                log('Batch processing complete.');
                break;

            case 'zipReady':
                downloadZipBlob(data.zipBlob);
                break;
        }

        updateStats();
    }

    function sendToWorker(type, data) {
        if (state.worker) {
            state.worker.postMessage({ type, data });
        }
    }

    // ============================================
    // BATCH PROCESSING
    // ============================================
    function startBatch() {
        const apiKey = elements.apiKey.value.trim();

        if (!apiKey) {
            log('Error: API Key missing', 'error');
            return;
        }

        if (state.queue.length === 0) {
            log('Error: Queue empty', 'error');
            return;
        }

        // Save API key
        saveApiKey();

        state.isProcessing = true;
        state.abortController = new AbortController();

        elements.startBtn.style.display = 'none';
        elements.stopBtn.style.display = 'flex';

        log(`Starting production loop for ${state.queue.length} items...`);

        // Send batch to worker
        const pendingItems = state.queue
            .filter(item => item.status !== 'done')
            .map(item => ({
                id: item.id,
                name: item.name,
                mime: item.mime,
                data: item.data
            }));

        sendToWorker('processBatch', {
            items: pendingItems,
            apiKey,
            config: {
                style: elements.stylePrompt.value,
                resolution: elements.resolution.value,
                aspectRatio: elements.aspectRatio.value
            },
            signal: null // Could use transferable AbortSignal
        });
    }

    function stopBatch() {
        state.isProcessing = false;

        if (state.abortController) {
            state.abortController.abort();
        }

        if (state.worker) {
            state.worker.terminate();
            initWorker(); // Reinitialize worker
        }

        elements.startBtn.style.display = 'flex';
        elements.stopBtn.style.display = 'none';
        log('Batch processing stopped.');
    }

    // ============================================
    // DOWNLOAD FUNCTIONS
    // ============================================
    function downloadSingle(id) {
        const item = state.queue.find(i => i.id === id);
        if (!item || !item.result) return;

        const a = document.createElement('a');
        a.href = item.result;
        a.download = `edit_${item.name}`;
        a.click();
    }

    function downloadAsZip() {
        const completedItems = state.queue.filter(item => item.result);

        if (completedItems.length === 0) {
            log('No completed items to zip', 'error');
            return;
        }

        sendToWorker('createZip', { items: completedItems });
    }

    function downloadZipBlob(blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'jewelry_production_batch.zip';
        a.click();
        log('ZIP Downloaded successfully.');
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    function init() {
        lucide.createIcons();
        loadApiKey();
        initFileHandling();
        initWorker();

        // Event listeners
        elements.apiKey.addEventListener('input', saveApiKey);
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose globally for onclick handlers
    window.startBatch = startBatch;
    window.stopBatch = stopBatch;
    window.downloadSingle = downloadSingle;
    window.downloadAsZip = downloadAsZip;

})();
