// Jewelry Studio Pro - Web Worker
// Handles API calls off the main thread for better stability

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

self.onmessage = async function(e) {
    const { type, data } = e.data;

    if (type === 'processBatch') {
        await processBatch(data);
    } else if (type === 'createZip') {
        await createZip(data);
    }
};

async function processBatch({ items, apiKey, config }) {
    let completed = 0;

    for (const item of items) {
        try {
            const result = await processWithRetry(item, apiKey, config);

            if (result.success) {
                self.postMessage({
                    type: 'success',
                    data: {
                        itemId: item.id,
                        imageUrl: result.imageUrl,
                        description: result.description
                    }
                });
            } else {
                self.postMessage({
                    type: 'failed',
                    data: {
                        itemId: item.id,
                        name: item.name,
                        error: result.error
                    }
                });
            }
        } catch (error) {
            self.postMessage({
                type: 'failed',
                data: {
                    itemId: item.id,
                    name: item.name,
                    error: error.message
                }
            });
        }

        completed++;
        self.postMessage({
            type: 'progress',
            data: { current: completed, total: items.length }
        });
    }

    self.postMessage({ type: 'complete', data: null });
}

async function processWithRetry(item, apiKey, config) {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
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

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
    }

    const json = await response.json();

    if (!json.candidates || !json.candidates[0]?.content) {
        throw new Error('Empty response from AI');
    }

    const parts = json.candidates[0].content.parts;
    const imgPart = parts.find(p => p.inlineData || p.inline_data);
    const textPart = parts.find(p => p.text);

    if (!imgPart) {
        throw new Error('AI did not generate an image (Safety Filter?)');
    }

    const raw = imgPart.inlineData || imgPart.inline_data;
    const imageUrl = `data:${raw.mime_type};base64,${raw.data}`;
    const description = textPart ? textPart.text.substring(0, 40) + '...' : 'Generated';

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
        // Simple ZIP implementation for base64 data
        const files = items.map(item => ({
            name: `gen_${item.name}`,
            data: item.result.split(',')[1]
        }));

        // Build ZIP structure manually (avoids importing JSZip in worker)
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
    // Simple ZIP file builder for base64 content
    const encoder = new TextEncoder();
    const fileHeaders = [];
    const fileData = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));

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
