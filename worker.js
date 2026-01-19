// Jewelry Studio Pro - Web Worker
// Handles API calls off the main thread for better stability

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
let isAborted = false;

self.onmessage = async function(e) {
    const { type, data } = e.data;

    if (type === 'shutdown') {
        isAborted = true;
        return;
    }

    if (type === 'processBatch') {
        isAborted = false;
        self.postMessage({
            type: 'log',
            data: { message: 'Worker received batch with ' + data.items.length + ' items', level: 'info' }
        });
        await processBatch(data);
    } else if (type === 'createZip') {
        await createZip(data);
    }
};

async function processBatch({ items, apiKey, config, batchSize }) {
    let completed = 0;
    const BATCH_SIZE = Math.max(1, Math.min(50, batchSize || 5));

    self.postMessage({
        type: 'log',
        data: { message: `Starting batch of ${items.length} items (processing ${BATCH_SIZE} at a time)...`, level: 'info' }
    });

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        if (isAborted) {
            self.postMessage({
                type: 'log',
                data: { message: 'Batch processing stopped. Finishing current batch...', level: 'info' }
            });
            break;
        }

        const batch = items.slice(i, i + BATCH_SIZE);

        batch.forEach(item => {
            self.postMessage({
                type: 'processing',
                data: { itemId: item.id }
            });
        });

        const results = await Promise.allSettled(
            batch.map(item => processWithRetry(item, apiKey, config))
        );

        if (isAborted) {
            self.postMessage({
                type: 'log',
                data: { message: 'Batch stopped. Results from current batch saved.', level: 'info' }
            });
        }

        results.forEach((result, index) => {
            const item = batch[index];

            if (result.status === 'fulfilled' && result.value.success) {
                self.postMessage({
                    type: 'success',
                    data: {
                        itemId: item.id,
                        imageUrl: result.value.imageUrl,
                        description: result.value.description
                    }
                });
            } else {
                const error = result.status === 'rejected' ? result.reason.message : (result.value?.error || 'Unknown error');
                self.postMessage({
                    type: 'failed',
                    data: {
                        itemId: item.id,
                        name: item.name,
                        error: error
                    }
                });
            }
        });

        completed += batch.length;
        self.postMessage({
            type: 'progress',
            data: { current: completed, total: items.length }
        });

        if (i + BATCH_SIZE < items.length && !isAborted) {
            await delay(300);
        }
    }

    if (isAborted) {
        self.postMessage({ type: 'stopped', data: { completed: completed, total: items.length } });
    } else {
        self.postMessage({ type: 'complete', data: null });
    }
}

async function processWithRetry(item, apiKey, config) {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
        if (isAborted) {
            throw new Error('Aborted');
        }

        attempt++;

        if (attempt > 1) {
            self.postMessage({
                type: 'retry',
                data: {
                    itemId: item.id,
                    name: item.name,
                    attempt: attempt
                }
            });
            await delay(RETRY_DELAY);
        }

        try {
            const result = await performApiCall(item, apiKey, config);
            return { success: true, ...result };
        } catch (error) {
            self.postMessage({
                type: 'log',
                data: {
                    message: `Error on ${item.name}: ${error.message}`,
                    level: 'error'
                }
            });

            if (attempt >= MAX_RETRIES) {
                return { success: false, error: error.message };
            }
        }
    }

    return { success: false, error: 'Max retries exceeded' };
}

async function performApiCall(item, apiKey, config) {
    self.postMessage({
        type: 'log',
        data: { message: 'Preparing API call for: ' + item.name, level: 'info' }
    });
    
    const payload = {
        contents: [{
            parts: [
                {
                    text: `TASK: Model this jewelry. If feminine, use a woman. If masculine, a man. Keep jewelry identical to input. Style: ${config.style}`
                },
                { inline_data: { mime_type: item.mime, data: item.data } }
            ]
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                image_size: config.resolution,
                ...(config.aspectRatio !== 'auto' && { aspectRatio: config.aspectRatio })
            }
        }
    };

    self.postMessage({
        type: 'log',
        data: {
            message: `📡 Requesting: ${item.name}`,
            level: 'info'
        }
    });

        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 90000);

    let response;
    try {
        response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: timeoutController.signal
            }
        );
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Aborted');
        }
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            throw new Error('Network error - check connection');
        }
        throw error;
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.error?.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
        }
        throw new Error(errorMessage);
    }

    const json = await response.json();

    self.postMessage({
        type: 'log',
        data: {
            message: 'API response received: ' + JSON.stringify(json).substring(0, 200) + '...',
            level: 'info'
        }
    });

    if (!json.candidates || !json.candidates[0]?.content) {
        throw new Error('Empty response from AI');
    }

    const parts = json.candidates[0].content.parts;
    const imgPart = parts.find(p => p.inlineData || p.inline_data);
    const textPart = parts.find(p => p.text);

    self.postMessage({
        type: 'log',
        data: {
            message: 'Parts found: ' + parts.length + ', Image part: ' + (imgPart ? 'yes' : 'no'),
            level: 'info'
        }
    });

    if (!imgPart) {
        throw new Error('AI did not generate an image (Safety Filter?)');
    }

    const raw = imgPart.inlineData || imgPart.inline_data;
    if (!raw || !raw.data) {
        throw new Error('Invalid image data from API - missing data');
    }
    const mimeType = raw.mimeType || raw.mime_type;
    if (!mimeType) {
        throw new Error('Invalid image data from API - missing mime_type');
    }

    try {
        atob(raw.data);
    } catch (e) {
        throw new Error('Corrupted base64 data from API');
    }

    const imageUrl = `data:${mimeType};base64,${raw.data}`;
    const description = textPart && textPart.text ? textPart.text.substring(0, 40) + '...' : 'Generated';

    return { imageUrl, description };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function createZip({ items }) {
    self.postMessage({
        type: 'log',
        data: { message: 'Compressing images into ZIP...', level: 'info' }
    });

    try {
        const usedNames = new Set();
        const files = items.map((item, index) => {
            let name = `gen_${item.name}`;

            name = name
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/\.{2,}/g, '.')
                .replace(/^\.+/, '')
                .substring(0, 255);

            let counter = 1;
            while (usedNames.has(name)) {
                const ext = item.name.includes('.') ? '.' + item.name.split('.').pop() : '';
                const base = item.name.replace(/\.[^/.]+$/, '');
                name = `gen_${base}_${counter}${ext}`;
                counter++;
            }

            usedNames.add(name);
            return {
                name,
                data: item.result.split(',')[1]
            };
        });

        const zip = await buildZip(files);

        self.postMessage({
            type: 'zipReady',
            data: { zipBlob: zip }
        });
    } catch (error) {
        self.postMessage({
            type: 'log',
            data: { message: `ZIP error: ${error.message}`, level: 'error' }
        });
    }
}

async function buildZip(files) {
    self.postMessage({
        type: 'log',
        data: { message: `Processing ${files.length} files for ZIP...`, level: 'info' }
    });

    // Simple ZIP file builder for base64 content
    const encoder = new TextEncoder();
    const fileHeaders = [];
    const fileData = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));

        if (files.length > 10 && fileHeaders.length % 10 === 0) {
            self.postMessage({
                type: 'log',
                data: { message: `Zipping... ${fileHeaders.length}/${files.length} processed`, level: 'info' }
            });
            await delay(0);
        }

        // Local file header
        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);

        view.setUint32(0, 0x04034b50, true); // Local file header signature
        view.setUint16(4, 20, true); // Version needed
        view.setUint16(6, 0, true); // General purpose bit flag
        view.setUint16(8, 0, true); // Compression method (store)
        view.setUint16(10, 0, true); // File time
        view.setUint16(12, 0, true); // File date
        view.setUint32(14, await crc32(dataBytes), true); // CRC-32
        view.setUint32(18, dataBytes.length, true); // Compressed size
        view.setUint32(22, dataBytes.length, true); // Uncompressed size
        view.setUint16(26, nameBytes.length, true); // File name length
        view.setUint16(28, 0, true); // Extra field length

        header.set(nameBytes, 30);

        // Central directory header
        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);

        centralView.setUint32(0, 0x02014b50, true); // Central directory signature
        centralView.setUint16(4, 20, true); // Version made by
        centralView.setUint16(6, 20, true); // Version needed
        centralView.setUint16(8, 0, true); // General purpose bit flag
        centralView.setUint16(10, 0, true); // Compression method
        centralView.setUint16(12, 0, true); // File time
        centralView.setUint16(14, 0, true); // File date
        centralView.setUint32(16, await crc32(dataBytes), true); // CRC-32
        centralView.setUint32(20, dataBytes.length, true); // Compressed size
        centralView.setUint32(24, dataBytes.length, true); // Uncompressed size
        centralView.setUint16(28, nameBytes.length, true); // File name length
        centralView.setUint16(30, 0, true); // Extra field length
        centralView.setUint16(32, 0, true); // File comment length
        centralView.setUint16(34, 0, true); // Disk number start
        centralView.setUint16(36, 0, true); // Internal file attributes
        centralView.setUint32(38, 0, true); // External file attributes
        centralView.setUint32(42, offset, true); // Relative offset

        central.set(nameBytes, 46);

        fileHeaders.push({ header, central, nameBytes, dataBytes });
        fileData.push(dataBytes);
        offset += header.length + dataBytes.length;
    }

    // End of central directory
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    const centralDirSize = fileHeaders.reduce((sum, f) => sum + f.central.length, 0);
    const centralDirOffset = offset;

    eocdView.setUint32(0, 0x06054b50, true); // End of central directory signature
    eocdView.setUint16(4, 0, true); // Disk number
    eocdView.setUint16(6, 0, true); // Disk with central directory
    eocdView.setUint16(8, files.length, true); // Number of entries on this disk
    eocdView.setUint16(10, files.length, true); // Total number of entries
    eocdView.setUint32(12, centralDirSize, true); // Size of central directory
    eocdView.setUint32(16, centralDirOffset, true); // Offset of central directory
    eocdView.setUint16(20, 0, true); // Comment length

    // Combine all parts
    const totalSize = offset + centralDirSize + 22;
    const zipData = new Uint8Array(totalSize);
    let pos = 0;

    for (const f of fileHeaders) {
        zipData.set(f.header, pos);
        pos += f.header.length;
        zipData.set(f.dataBytes, pos);
        pos += f.dataBytes.length;
    }

    for (const f of fileHeaders) {
        zipData.set(f.central, pos);
        pos += f.central.length;
    }

    zipData.set(eocd, pos);

    return new Blob([zipData], { type: 'application/zip' });
}

async function crc32(data) {
    // Simple CRC32 implementation
    let crc = 0xFFFFFFFF;
    const table = getCrc32Table();

    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getCrc32Table() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }
    return table;
}
