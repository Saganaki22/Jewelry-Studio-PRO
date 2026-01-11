// Jewelry Studio Pro - Main Application
(function() {
    'use strict';

    // ============================================
    // POLYFILLS & BROWSER DETECTION
    // ============================================
    function getSafariVersion() {
        const ua = navigator.userAgent;
        const match = ua.match(/Version\/(\d+\.\d+)/);
        return match ? parseFloat(match[1]) : null;
    }

    const safariVersion = getSafariVersion();
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Promise.allSettled polyfill for Safari < 14
    if (isSafari && (safariVersion === null || safariVersion < 14) && !Promise.allSettled) {
        Promise.allSettled = function(promises) {
            return Promise.all(
                Array.from(promises).map(p => {
                    return Promise.resolve(p).then(
                        value => ({ status: 'fulfilled', value }),
                        reason => ({ status: 'rejected', reason })
                    );
                })
            );
        };
    }

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
        pasteBtn: document.getElementById('pasteBtn'),
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('fileInput'),
        resultsGrid: document.getElementById('resultsGrid'),
        startBtn: document.getElementById('startBtn'),
        stopBtn: document.getElementById('stopBtn'),
        deleteAllBtn: document.getElementById('deleteAllBtn'),
        deleteConfirmModal: document.getElementById('deleteConfirmModal'),
        cancelDelete: document.getElementById('cancelDelete'),
        confirmDelete: document.getElementById('confirmDelete'),
        deleteCount: document.getElementById('deleteCount'),
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
    function playDingSound() {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();

            const frequencies = [523.25, 659.25, 783.99, 1046.50];
            const gainNode = audioContext.createGain();

            frequencies.forEach((freq, index) => {
                const oscillator = audioContext.createOscillator();
                oscillator.frequency.value = freq;
                oscillator.type = 'sine';

                const oscGain = audioContext.createGain();
                oscGain.gain.setValueAtTime(0, audioContext.currentTime);
                oscGain.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.01);
                oscGain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1.5);

                oscillator.connect(oscGain);
                oscGain.connect(gainNode);
                gainNode.connect(audioContext.destination);

                oscillator.start(audioContext.currentTime);
                oscillator.stop(audioContext.currentTime + 1.5);
            });
        } catch (e) {
            console.error('Could not play sound:', e);
        }
    }

    function showToast(message, type = 'success') {
        const container = document.querySelector('.toast-container');
        if (!container) {
            const toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;

        const currentContainer = document.querySelector('.toast-container');
        currentContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

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
        
        // Also update modal if open
        const modalConsole = document.getElementById('debugConsoleClone');
        if (modalConsole) {
            const modalDiv = document.createElement('div');
            if (type === 'error') modalDiv.className = 'log-error';
            if (type === 'warn') modalDiv.className = 'log-warn';
            modalDiv.innerHTML = `[${time}] ${message}`;
            modalConsole.appendChild(modalDiv);
            modalConsole.scrollTop = modalConsole.scrollHeight;
            
            while (modalConsole.children.length > 100) {
                modalConsole.removeChild(modalConsole.firstChild);
            }
        }
        
        while (elements.debugConsole.children.length > 100) {
            elements.debugConsole.removeChild(elements.debugConsole.firstChild);
        }
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
        elements.fileInput.onchange = (e) => {
            handleFiles(e.target.files);
            e.target.value = '';
        };
    }

    async function handleFiles(files) {
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        const MAX_QUEUE_SIZE = 50;

        if (state.queue.length + files.length > MAX_QUEUE_SIZE) {
            log(`Error: Would exceed maximum queue size (${MAX_QUEUE_SIZE})`, 'error');
            return;
        }

        const fileArray = Array.from(files);

        const results = await Promise.allSettled(fileArray.map(async (file) => {
            try {
                if (file.size > MAX_FILE_SIZE) {
                    return null;
                }

                if (file.name.endsWith('.zip')) {
                    await handleZipFile(file);
                    return null;
                } else if (file.type.startsWith('image/')) {
                    await addImageToQueue(file);
                    return file.name;
                } else {
                    return null;
                }
            } catch (error) {
                return null;
            }
        }));

        const addedCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
        const failedCount = results.filter(r => r.status === 'rejected').length;
        
        if (failedCount > 0) {
            log(`${failedCount} file(s) skipped`, 'warn');
        }
        
        updateStats();
        log(`Added ${addedCount} images to queue`);
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

            let successCount = 0;
            let failCount = 0;

            for (const imgEntry of imgFiles) {
                try {
                    log(`Processing: ${imgEntry.name}`);
                    const blob = await imgEntry.async('blob');
                    const proxyFile = new File([blob], imgEntry.name, { type: 'image/png' });
                    await addImageToQueue(proxyFile);
                    successCount++;
                    log(`Successfully added: ${imgEntry.name}`);
                } catch (e) {
                    log(`Error extracting ${imgEntry.name}: ${e.message}`, 'error');
                    failCount++;
                }
            }

            log(`ZIP extraction complete: ${successCount} succeeded, ${failCount} failed`);
        } catch (e) {
            log(`Error reading ZIP file: ${e.message}`, 'error');
        }
    }

    function addImageToQueue(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = () => {
                try {
                    if (!reader.result || !reader.result.includes(',')) {
                        reject(new Error(`Invalid data URL for ${file.name}`));
                        return;
                    }

                    const item = {
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
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
                } catch (error) {
                    reject(error);
                }
            };

            reader.onerror = (e) => {
                reject(e);
            };

            try {
                reader.readAsDataURL(file);
            } catch (error) {
                reject(error);
            }
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
            <button class="remove-btn" id="remove-${item.id}" title="1 sec press to remove">
                <i data-lucide="x"></i>
            </button>
            <div class="image-wrapper" id="wrapper-${item.id}">
                <img src="${item.preview}" id="img-${item.id}" alt="${item.name}">
                <div class="loading-overlay" id="loading-${item.id}" style="display:none">
                    <div class="spinner"></div>
                </div>
            </div>
            <div class="card-meta">
                <div class="card-text">
                    <div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.name}</div>
                    <div id="desc-${item.id}">Waiting...</div>
                </div>
                <div class="card-actions">
                    <button class="regen-btn" id="regen-${item.id}" style="display:none" title="Regenerate">
                        <i data-lucide="refresh-cw"></i>
                    </button>
                    <button class="btn btn-icon btn-icon-only" id="dl-${item.id}" onclick="downloadSingle('${item.id}')" style="display:none">
                        <i data-lucide="download"></i>
                    </button>
                </div>
            </div>
        `;
        elements.resultsGrid.appendChild(div);
        lucide.createIcons();

        const wrapper = document.getElementById(`wrapper-${item.id}`);
        if (wrapper) {
            wrapper.addEventListener('click', () => openImageModal(item.id));
        }

        const removeBtn = document.getElementById(`remove-${item.id}`);
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => e.stopPropagation());
            initLongPress(`remove-${item.id}`, item.id);
        }

        const regenBtn = document.getElementById(`regen-${item.id}`);
        if (regenBtn) {
            regenBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                regenerateItem(item.id);
            });
        }

        const dlBtn = document.getElementById(`dl-${item.id}`);
        if (dlBtn) {
            dlBtn.addEventListener('click', (e) => e.stopPropagation());
        }
    }

    function initLongPress(btnId, itemId) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        let pressTimer = null;
        let isRemoved = false;

        const startPress = (e) => {
            e.preventDefault();
            e.stopPropagation();
            isRemoved = false;
            btn.classList.add('pressing');
            btn.style.animation = 'pulse 0.5s ease-in-out infinite';

            pressTimer = setTimeout(() => {
                isRemoved = true;
                btn.classList.remove('pressing');
                btn.style.animation = '';
                removeItem(itemId);
            }, 1000);
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
        const regenBtn = document.getElementById(`regen-${itemId}`);
        const loadingEl = document.getElementById(`loading-${itemId}`);
        const card = document.getElementById(`card-${itemId}`);

        if (statusEl) statusEl.innerText = status;
        if (descEl && description) descEl.innerText = description;
        if (loadingEl) {
            loadingEl.style.display = (status === 'Processing' || status === 'Retry') ? 'flex' : 'none';
        }
        if (card) {
            if (status === 'Processing' || status === 'Retry') {
                card.classList.add('processing');
            } else {
                card.classList.remove('processing');
            }
        }
        if (regenBtn) {
            if (status === 'Completed') {
                regenBtn.style.display = 'flex';
            } else {
                regenBtn.style.display = 'none';
            }
        }
    }

    function updateCardResult(itemId, imageUrl) {
        const imgEl = document.getElementById(`img-${itemId}`);
        const dlBtn = document.getElementById(`dl-${itemId}`);
        const loadingEl = document.getElementById(`loading-${itemId}`);

        if (imgEl) imgEl.src = imageUrl;
        if (dlBtn) dlBtn.style.display = 'flex';
        if (loadingEl) loadingEl.style.display = 'none';

        const modalImg = document.querySelector('.image-modal-content img');
        if (modalImg && itemId === modalImg.dataset.itemId) {
            modalImg.src = imageUrl;
        }
    }

    function regenerateItem(itemId) {
        const item = state.queue.find(i => i.id === itemId);
        if (!item) return;

        item.status = 'pending';
        item.result = null;

        const imgEl = document.getElementById(`img-${itemId}`);
        const dlBtn = document.getElementById(`dl-${itemId}`);
        const regenBtn = document.getElementById(`regen-${itemId}`);

        if (imgEl) imgEl.src = item.preview;
        if (dlBtn) dlBtn.style.display = 'none';
        if (regenBtn) regenBtn.style.display = 'none';

        updateCardStatus(itemId, 'Pending', 'Waiting...');

        log(`Regenerating: ${item.name}`);

        if (state.isProcessing) {
            log(`Already processing - item queued for next batch`);
            showToast(`Queued: ${item.name}`, 'warn');
            updateStats();
        } else {
            showToast(`Regenerating ${item.name}`, 'warn');

            const itemToSend = {
                id: item.id,
                name: item.name,
                mime: item.mime,
                data: item.data
            };

            sendToWorker('processBatch', {
                items: [itemToSend],
                apiKey: elements.apiKey.value.trim(),
                config: {
                    style: elements.stylePrompt.value,
                    resolution: elements.resolution.value,
                    aspectRatio: elements.aspectRatio.value
                }
            });
        }
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
        log(`Worker message: ${type}`);
        
        switch (type) {
            case 'log':
                log(data.message, data.level);
                break;

            case 'processing':
                const processingItem = state.queue.find(i => i.id === data.itemId);
                if (processingItem) {
                    processingItem.status = 'pending';
                }
                updateCardStatus(data.itemId, 'Processing', 'Processing...');
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
                showToast(`Error: ${data.name}`, 'error');
                break;

            case 'progress':
                if (data.total > 0) {
                    const pct = (data.current / data.total) * 100;
                    elements.progressFill.style.width = `${pct}%`;
                }
                break;

            case 'complete':
                log('Batch processing complete.');
                state.isProcessing = false;
                state.abortController = null;
                updateBatchButton('idle');
                elements.stopBtn.style.display = 'none';

                const pendingCount = state.queue.filter(i => i.status !== 'done').length;
                if (pendingCount > 0) {
                    log(`${pendingCount} items failed or pending. Click START BATCH to retry.`, 'warn');
                } else {
                    playDingSound();
                    showToast('Batch finished successfully', 'success');
                }

                const maxCompleted = 50;
                const completedItems = state.queue.filter(i => i.status === 'done');
                if (completedItems.length > maxCompleted) {
                    const toRemove = completedItems.slice(0, completedItems.length - maxCompleted);
                    toRemove.forEach(item => removeItem(item.id));
                    log(`Auto-removed ${toRemove.length} old completed items`, 'info');
                }
                break;

            case 'zipReady':
                downloadZipBlob(data.zipBlob);
                break;

            default:
                log(`Unknown message type from worker: ${type}`, 'warn');
                break;
        }

        updateStats();
    }

    function sendToWorker(type, data) {
        if (state.worker) {
            log(`Sending to worker: ${type}`);
            state.worker.postMessage({ type, data });
        } else {
            log('Worker not initialized!', 'error');
        }
    }

    // ============================================
    // BATCH PROCESSING
    // ============================================
    function updateBatchButton(state) {
        if (state === 'running') {
            elements.startBtn.innerHTML = '<i data-lucide="play-circle"></i> RUNNING';
            lucide.createIcons();
        } else if (state === 'queued') {
            elements.startBtn.innerHTML = '<i data-lucide="clock"></i> QUEUED';
            lucide.createIcons();
        } else {
            elements.startBtn.innerHTML = '<i data-lucide="play-circle"></i> RUN BATCH ENGINE';
            lucide.createIcons();
        }
    }

    function startBatch() {
        if (state.isProcessing) {
            log('Error: Batch already running', 'error');
            return;
        }

        const apiKey = elements.apiKey.value.trim();

        if (!apiKey) {
            log('Error: API Key missing', 'error');
            elements.apiKey.focus();
            return;
        }

        if (apiKey.length < 20) {
            log('Error: API Key appears invalid (too short)', 'error');
            elements.apiKey.focus();
            return;
        }

        if (state.queue.length === 0) {
            log('Error: Queue empty', 'error');
            return;
        }

        saveApiKey();

        state.isProcessing = true;
        state.abortController = new AbortController();

        updateBatchButton('running');
        elements.stopBtn.style.display = 'flex';

        const pendingItems = state.queue
            .filter(item => item.status !== 'done')
            .map(item => ({
                id: item.id,
                name: item.name,
                mime: item.mime,
                data: item.data
            }));

        log(`Starting batch for ${pendingItems.length} pending/failed items (skipping ${state.queue.length - pendingItems.length} completed)...`);
        showToast(`Running batch engine`, 'success');

        sendToWorker('processBatch', {
            items: pendingItems,
            apiKey,
            config: {
                style: elements.stylePrompt.value,
                resolution: elements.resolution.value,
                aspectRatio: elements.aspectRatio.value
            }
        });
    }

    function stopBatch() {
        state.isProcessing = false;

        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }

        if (state.worker) {
            state.worker.postMessage({ type: 'shutdown' });

            setTimeout(() => {
                state.worker.terminate();
                initWorker();
            }, 100);
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
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

        a.download = `Jewelry-studio-pro_${dateStr}_${timeStr}.zip`;
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 5000);
        log('ZIP Downloaded successfully.');
        showToast('Exporting ZIP download', 'success');
    }

    // ============================================
    // DELETE ALL FUNCTIONALITY
    // ============================================
    const DELETE_HOLD_TIME = 4000;

    function initDeleteAllButton() {
        const btn = elements.deleteAllBtn;
        if (!btn) return;

        let pressTimer = null;
        let startTime = 0;
        let animationFrame = null;

        const startPress = (e) => {
            e.preventDefault();
            if (state.queue.length === 0) {
                log('Queue is already empty', 'info');
                return;
            }

            startTime = Date.now();

            const progressRing = btn.querySelector('.delete-progress-ring');
            progressRing.classList.add('active');

            btn.classList.add('pressing');
            btn.style.background = 'var(--danger)';

            pressTimer = setTimeout(() => {
                cancelAnimationFrame(animationFrame);
                showDeleteConfirm();
            }, DELETE_HOLD_TIME);

            const updateTimer = () => {
                const elapsed = Date.now() - startTime;
                const remaining = Math.max(0, DELETE_HOLD_TIME - elapsed);
                if (remaining > 0) {
                    const secs = (remaining / 1000).toFixed(1);
                    const span = btn.querySelector('span');
                    span.textContent = `${secs}s`;
                    animationFrame = requestAnimationFrame(updateTimer);
                }
            };
            animationFrame = requestAnimationFrame(updateTimer);
        };

        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
                animationFrame = null;
            }

            const progressRing = btn.querySelector('.delete-progress-ring');
            progressRing.classList.remove('active');

            btn.classList.remove('pressing');
            btn.style.background = '';
            btn.querySelector('span').textContent = 'DELETE ALL';
        };

        btn.addEventListener('mousedown', startPress);
        btn.addEventListener('mouseup', cancelPress);
        btn.addEventListener('mouseleave', cancelPress);
        btn.addEventListener('touchstart', startPress);
        btn.addEventListener('touchend', cancelPress);
        btn.addEventListener('touchcancel', cancelPress);
    }

    function showDeleteConfirm() {
        const progressRing = elements.deleteAllBtn.querySelector('.delete-progress-ring');
        progressRing.classList.remove('active');
        elements.deleteAllBtn.querySelector('span').textContent = 'DELETE ALL';
        elements.deleteAllBtn.classList.remove('pressing');

        elements.deleteCount.textContent = state.queue.length;
        elements.deleteConfirmModal.style.display = 'flex';
        lucide.createIcons();
    }

    function deleteAllImages() {
        const cards = elements.resultsGrid.querySelectorAll('.result-card');
        cards.forEach((card, index) => {
            setTimeout(() => {
                card.style.transform = 'scale(0.8)';
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 200);
            }, index * 30);
        });

        setTimeout(() => {
            state.queue = [];
            log(`Deleted ${cards.length} images from queue.`);
            updateStats();
        }, cards.length * 30 + 200);

        elements.deleteConfirmModal.style.display = 'none';
    }

    function cancelDelete() {
        elements.deleteConfirmModal.style.display = 'none';
    }

    // ============================================
    // IMAGE VIEW MODAL
    // ============================================
    function openImageModal(itemId) {
        const item = state.queue.find(i => i.id === itemId);
        if (!item) return;

        const overlay = document.createElement('div');
        overlay.className = 'image-modal-overlay';
        overlay.id = 'imageModalOverlay';

        const modal = document.createElement('div');
        modal.className = 'image-modal';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'image-modal-close';
        closeBtn.innerHTML = '<i data-lucide="x" size="24"></i>';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            overlay.remove();
        });

        const imgContainer = document.createElement('div');
        imgContainer.className = 'image-modal-content';

        const img = document.createElement('img');
        img.src = item.result || item.preview;
        img.alt = item.name;
        img.dataset.itemId = item.id;

        const info = document.createElement('div');
        info.className = 'image-modal-info';
        info.innerHTML = `
            <h3>${item.name}</h3>
            <p>${item.status === 'done' ? 'Generated' : 'Pending'}</p>
        `;

        imgContainer.appendChild(img);
        modal.appendChild(closeBtn);
        modal.appendChild(imgContainer);
        modal.appendChild(info);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        lucide.createIcons();

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
            }
        }, { once: true });
    }

    // ============================================
    // CONSOLE MODAL
    // ============================================
    function initConsoleModal() {
        const consoleContainer = document.querySelector('.console-container');

        if (!consoleContainer) return;

        consoleContainer.style.cursor = 'pointer';
        consoleContainer.title = 'Click to expand';

        const createModal = () => {
            const overlay = document.createElement('div');
            overlay.className = 'console-modal-overlay';
            overlay.id = 'consoleModalOverlay';

            const modal = document.createElement('div');
            modal.className = 'console-modal';

            const header = document.createElement('div');
            header.className = 'console-modal-header';

            const title = document.createElement('div');
            title.className = 'console-header';
            title.textContent = 'LIVE REQUEST CONSOLE - EXPANDED';

            const modalControls = document.createElement('div');
            modalControls.className = 'modal-controls';

            const fontSizeControl = document.createElement('div');
            fontSizeControl.className = 'font-size-control';

            const smallA = document.createElement('span');
            smallA.className = 'font-size-small';
            smallA.textContent = 'A';

            const sliderContainer = document.createElement('div');
            sliderContainer.className = 'font-size-slider-container';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '3';
            slider.value = '0';
            slider.step = '1';
            slider.className = 'font-size-slider';

            sliderContainer.appendChild(slider);

            const largeA = document.createElement('span');
            largeA.className = 'font-size-large';
            largeA.textContent = 'A';

            fontSizeControl.appendChild(smallA);
            fontSizeControl.appendChild(sliderContainer);
            fontSizeControl.appendChild(largeA);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-console-btn';
            copyBtn.innerHTML = '<i data-lucide="copy" size="14"></i> Copy';
            copyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    const text = consoleClone.innerText;
                    await navigator.clipboard.writeText(text);
                    copyBtn.innerHTML = '<i data-lucide="check" size="14"></i> Copied!';
                    setTimeout(() => {
                        copyBtn.innerHTML = '<i data-lucide="copy" size="14"></i> Copy';
                        lucide.createIcons();
                    }, 2000);
                } catch (error) {
                    showToast('Failed to copy', 'error');
                }
                lucide.createIcons();
            });

            modalControls.appendChild(fontSizeControl);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'console-modal-close-btn';
            closeBtn.innerHTML = '<i data-lucide="x" size="18"></i>';

            header.appendChild(title);
            header.appendChild(modalControls);

            const spacer = document.createElement('div');
            spacer.style.marginRight = 'auto';
            header.appendChild(spacer);

            header.appendChild(copyBtn);
            header.appendChild(closeBtn);
            modal.appendChild(header);

            const consoleClone = document.createElement('div');
            consoleClone.id = 'debugConsoleClone';
            consoleClone.className = 'console-content';

            const consoleContent = elements.debugConsole.innerHTML;
            consoleClone.innerHTML = consoleContent;
            
            const sizes = ['0.7rem', '0.85rem', '1rem', '1.2rem'];
            const savedFontSizeIndex = localStorage.getItem('console_font_size') || '0';
            slider.value = savedFontSizeIndex;
            consoleClone.style.fontSize = sizes[parseInt(savedFontSizeIndex)];

            slider.addEventListener('input', () => {
                const index = parseInt(slider.value);
                consoleClone.style.fontSize = sizes[index];
                localStorage.setItem('console_font_size', index);
            });

            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                overlay.remove();
            });

            modal.appendChild(consoleClone);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            lucide.createIcons();
        };

        consoleContainer.addEventListener('click', () => {
            if (!document.getElementById('consoleModalOverlay')) {
                createModal();
            }
        });

        document.addEventListener('click', (e) => {
            if (e.target.id === 'consoleModalOverlay') {
                const overlay = document.getElementById('consoleModalOverlay');
                if (overlay) {
                    overlay.remove();
                }
            }
        });
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    function initPasteButton() {
        if (!elements.pasteBtn) {
            console.error('Paste button not found');
            return;
        }

        console.log('Initializing paste button');

        elements.pasteBtn.addEventListener('click', async () => {
            console.log('Paste button clicked');
            try {
                if (!navigator.clipboard || !navigator.clipboard.readText) {
                    showToast('Clipboard not supported', 'error');
                    return;
                }

                const text = await navigator.clipboard.readText();
                console.log('Clipboard text:', text ? text.substring(0, 20) : 'empty');

                if (text && text.trim()) {
                    elements.apiKey.value = text.trim();
                    saveApiKey();
                    showToast('API key pasted');
                } else {
                    showToast('Clipboard is empty', 'warn');
                }
            } catch (error) {
                console.error('Paste error:', error);
                showToast('Failed to paste - check permissions', 'error');
            }
        });
    }

    function init() {
        lucide.createIcons();
        loadApiKey();
        initFileHandling();
        initWorker();
        initDeleteAllButton();
        initConsoleModal();
        initPasteButton();

        elements.apiKey.addEventListener('input', saveApiKey);
        elements.cancelDelete.addEventListener('click', cancelDelete);
        elements.confirmDelete.addEventListener('click', deleteAllImages);

        setTimeout(() => lucide.createIcons(), 100);
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
    window.regenerateItem = regenerateItem;
    window.openImageModal = openImageModal;

})();
