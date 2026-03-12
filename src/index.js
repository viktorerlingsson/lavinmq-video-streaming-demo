let ws = null;
let frameCount = 0;
let fpsCounter = 0;
let fpsInterval;
let producerStatsInterval;
let videoMetadataInterval;

// Frame display queue and rate limiting
let frameQueue = [];
let displayInterval = 200; // milliseconds between frame displays (5 FPS)
let displayTimer = null;
let unlimitedMode = false;
let isPlaying = false;

// Video metadata
let currentVideoMetadata = null;
let userSetFps = false; // Track if user has manually set FPS

const statusElement = document.getElementById('status');
const frameDisplay = document.getElementById('frameDisplay');
const frameCountElement = document.getElementById('frameCount');
const fpsElement = document.getElementById('fps');
const currentFrameElement = document.getElementById('currentFrame');

// Producer stats elements
const producerStatusElement = document.getElementById('producerStatus');
const producerFramesElement = document.getElementById('producerFrames');
const producerDataElement = document.getElementById('producerData');

// Video metadata elements
const videoResolutionElement = document.getElementById('videoResolution');
const videoFpsElement = document.getElementById('videoFps');
const videoDurationElement = document.getElementById('videoDuration');
const videoCodecElement = document.getElementById('videoCodec');

const displayFpsActualElement = document.getElementById('displayFpsActual');
const totalDataReceivedElement = document.getElementById('totalDataReceived');
const avgProducerFpsElement = document.getElementById('avgProducerFps');
const compressionRatioElement = document.getElementById('compressionRatio');
const avgFrameSizeElement = document.getElementById('avgFrameSize');
const connectionStatusElement = document.getElementById('connectionStatus');
const uptimeElement = document.getElementById('uptime');
const droppedFramesElement = document.getElementById('droppedFrames');


// Stats tracking variables
let sessionStartTime = null;
let totalDataReceived = 0;
let frameReceiveTimes = [];
let frameDisplayTimes = [];
let droppedFrameCount = 0;
let lastFrameNumber = -1;
let uptimeInterval = null;

function updateStatus(message, type) {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
}


let reconnectAttempts = 0;
let reconnectTimer = null;
let manualDisconnect = false;

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        reconnectAttempts = 0;
        updateStatus('Connected - Waiting for frames', 'connected');
        connectionStatusElement.textContent = 'Connected';
        sessionStartTime = Date.now();
        startUptimeCounter();
        console.log('Connected to server');
    };

    ws.onmessage = function(event) {
        try {
            const frameData = JSON.parse(event.data);
            // Handle video metadata from first frame (or updated on re-publish)
            if (frameData.metadata) {
                currentVideoMetadata = frameData.metadata;
                updateVideoMetadataDisplay();
                if (!userSetFps) {
                    setDisplayFpsFromVideo();
                }
            }

            // Use queue system
            displayFrame(frameData);
        } catch (error) {
            console.error('Error parsing frame data:', error);
            console.log('Raw message:', typeof event.data === 'string' ? event.data.substring(0, 100) : 'Binary data');
        }
    };

    ws.onclose = function() {
        stopUptimeCounter();
        console.log('Connection closed');

        if (manualDisconnect) {
            updateStatus('Disconnected', 'error');
            connectionStatusElement.textContent = 'Disconnected';
            return;
        }

        scheduleReconnect();
    };

    ws.onerror = function(error) {
        connectionStatusElement.textContent = 'Error';
        console.error('WebSocket error:', error);
    };
}

function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
    updateStatus(`Connection lost - Reconnecting in ${(delay / 1000).toFixed(0)}s...`, 'connecting');
    connectionStatusElement.textContent = 'Reconnecting...';

    reconnectTimer = setTimeout(() => {
        console.log(`Reconnect attempt ${reconnectAttempts}`);
        connect();
    }, delay);
}



function ackFrame(frameNumber) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ack', frameNumber }));
    }
}

function displayFrame(frameData) {
    frameData.receivedAt = Date.now();
    frameQueue.push(frameData);
    updateQueueInfo();
}

// Display loop using requestAnimationFrame for accurate timing
let lastDisplayTimestamp = 0;

function displayLoop(timestamp) {
    displayTimer = requestAnimationFrame(displayLoop);

    if (!isPlaying || frameQueue.length === 0) return;

    if (unlimitedMode) {
        // Drain the entire queue each tick — ack all, render the last
        while (frameQueue.length > 0) {
            const frameData = frameQueue.shift();

            actuallyDisplayFrame(frameData);
        }
    } else {
        const elapsed = timestamp - lastDisplayTimestamp;
        if (elapsed < displayInterval) return;
        // Snap to interval to prevent drift
        lastDisplayTimestamp = timestamp - (elapsed % displayInterval);

        const frameData = frameQueue.shift();
        frameData.processingStartTime = performance.now();
        actuallyDisplayFrame(frameData);
    }

    updateQueueInfo();
}

function startDisplayLoop() {
    stopDisplayLoop();
    lastDisplayTimestamp = 0;
    displayTimer = requestAnimationFrame(displayLoop);
}

function stopDisplayLoop() {
    if (displayTimer) {
        cancelAnimationFrame(displayTimer);
        displayTimer = null;
    }
}

function actuallyDisplayFrame(frameData) {
    const { frameNumber, data, mimeType } = frameData;

    // Hide placeholder text if it exists
    const placeholder = frameDisplay.querySelector('.placeholder');
    if (placeholder) {
        placeholder.style.display = 'none';
    }

    // Find existing image or create new one
    let img = frameDisplay.querySelector('img');
    if (!img) {
        img = document.createElement('img');
        frameDisplay.appendChild(img);
        // Apply active size preset if any
        if (activeSizeId) {
            const h = sizePresets[activeSizeId];
            img.style.height = h + 'px';
            img.style.width = 'auto';
            img.style.maxWidth = 'none';
        } else {
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
        }
    }

    // Update the image source (avoids flicker by reusing same element)
    img.src = `data:${mimeType};base64,${data}`;
    img.alt = `Frame ${frameNumber}`;

    const processingEndTime = Date.now();

    // Update statistics
    frameCount++;
    fpsCounter++;
    frameCountElement.textContent = frameCount;
    currentFrameElement.textContent = frameNumber;

    // Track data received (estimate based on base64 data length)
    const frameSize = data.length * 0.75 / 1024 / 1024; // Convert base64 to MB
    totalDataReceived += frameSize;
    totalDataReceivedElement.textContent = `${totalDataReceived.toFixed(2)}MB`;

    // Track frame receive times for receive FPS (keep existing logic)
    frameReceiveTimes.push(Date.now());
    if (frameReceiveTimes.length > 60) frameReceiveTimes.shift(); // Keep last 60 frames

    // Track frame display times for actual display FPS
    frameDisplayTimes.push(processingEndTime);
    if (frameDisplayTimes.length > 30) frameDisplayTimes.shift(); // Keep last 30 displays

    // Calculate actual display FPS
    if (frameDisplayTimes.length > 1) {
        const displayTimeSpan = (frameDisplayTimes[frameDisplayTimes.length - 1] - frameDisplayTimes[0]) / 1000;
        const actualDisplayFps = (frameDisplayTimes.length - 1) / displayTimeSpan;
        displayFpsActualElement.textContent = actualDisplayFps.toFixed(1);
    }

    // Check for dropped frames
    if (lastFrameNumber >= 0 && frameNumber > lastFrameNumber + 1) {
        droppedFrameCount += (frameNumber - lastFrameNumber - 1);
        droppedFramesElement.textContent = droppedFrameCount;
    }
    lastFrameNumber = frameNumber;

    // Update video time indicator
    if (currentVideoMetadata) {
        const currentTime = (frameNumber / currentVideoMetadata.fps).toFixed(1);
        const totalTime = currentVideoMetadata.duration.toFixed(1);
        document.getElementById('videoTime').textContent = `${currentTime}s / ${totalTime}s`;
    }

    // Calculate compression ratio and average frame size
    if (currentVideoMetadata) {
        const uncompressedSize = (currentVideoMetadata.width * currentVideoMetadata.height * 3) / 1024 / 1024; // RGB bytes to MB
        const compressionRatio = uncompressedSize / frameSize;
        compressionRatioElement.textContent = `${compressionRatio.toFixed(1)}:1`;
        avgFrameSizeElement.textContent = `${(frameSize * 1024).toFixed(1)}KB`;
    }

    // Ack frame so server can ack the AMQP message, opening prefetch window
    ackFrame(frameNumber);

    updateQueueInfo();
}

function setDisplayFps(fps) {
    fps = Math.max(0.1, Math.min(120, fps));
    unlimitedMode = false;
    displayInterval = Math.round(1000 / fps);
    startDisplayLoop();
    updateQueueInfo();
}

const speedButtons = {
    'presetSlow50': 0.5,
    'presetSlow75': 0.75,
    'presetNormal': 1,
    'presetFast150': 1.5,
    'presetFast200': 2,
    'unlimitedBtn': 'max'
};

function updateActiveSpeedButton(activeId) {
    for (const id of Object.keys(speedButtons)) {
        const btn = document.getElementById(id);
        btn.classList.toggle('active', id === activeId);
    }
}

function setPresetFps(multiplier) {
    const baseFps = currentVideoMetadata ? currentVideoMetadata.fps : 10;
    userSetFps = true;
    setDisplayFps(baseFps * multiplier);

    const activeId = Object.entries(speedButtons).find(([, v]) => v === multiplier)?.[0];
    updateActiveSpeedButton(activeId);
}

function setUnlimitedMode() {
    unlimitedMode = true;
    userSetFps = true;
    updateActiveSpeedButton('unlimitedBtn');
    updateQueueInfo();
}

function updateQueueInfo() {
    document.getElementById('queueInfo').textContent = frameQueue.length;
}

function updateFPS() {
    fpsElement.textContent = fpsCounter;
    fpsCounter = 0;
}

function startConsumer() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    manualDisconnect = false;
    reconnectAttempts = 0;
    updateStatus('Connecting...', 'connecting');
    connect();

    if (currentVideoMetadata && !userSetFps) {
        setDisplayFpsFromVideo();
    }
}

function togglePlayPause() {
    if (isPlaying) {
        pause();
    } else {
        play();
    }
}

function play() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        startConsumer();
    }
    // If no frames have been received yet, start from the beginning
    if (lastFrameNumber < 0 && frameQueue.length === 0) {
        seekTo('first');
    }
    isPlaying = true;
    updatePlayPauseButton();
}

function pause() {
    isPlaying = false;
    updatePlayPauseButton();
}

function updatePlayPauseButton() {
    const btn = document.getElementById('playPauseBtn');
    if (isPlaying) {
        btn.innerHTML = '&#9208;'; // ⏸
        btn.title = 'Pause';
    } else {
        btn.innerHTML = '&#9654;'; // ▶
        btn.title = 'Play';
    }
}

async function runProducer() {
    const btn = document.getElementById('runProducerBtn');
    const stopBtn = document.getElementById('stopProducerBtn');
    btn.disabled = true;
    btn.textContent = 'Running Producer...';

    try {
        const response = await fetch('/api/run-producer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const result = await response.json();

        if (response.ok) {
            updateStatus(`Producer started: ${result.message}`, 'connected');
            stopBtn.disabled = false;
            startProducerStatsPolling();
        } else {
            updateStatus(`Producer error: ${result.error}`, 'error');
            btn.disabled = false;
            btn.textContent = 'Run Producer';
        }

    } catch (error) {
        updateStatus(`Failed to start producer: ${error.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Run Producer';
    }
}

async function stopProducer() {
    try {
        const response = await fetch('/api/stop-producer', { method: 'POST' });
        const result = await response.json();

        if (response.ok) {
            updateStatus(`Producer stopped`, 'connected');
        } else {
            updateStatus(`Stop error: ${result.error}`, 'error');
        }
    } catch (error) {
        updateStatus(`Failed to stop producer: ${error.message}`, 'error');
    }
}

async function fetchProducerStats() {
    try {
        const response = await fetch('/api/producer-stats');
        const stats = await response.json();
        updateProducerStats(stats);
    } catch (error) {
        console.error('Failed to fetch producer stats:', error);
    }
}

function updateProducerStats(stats) {
    producerStatusElement.textContent = stats.isRunning ? 'Running' : 'Idle';
    producerStatusElement.parentElement.style.backgroundColor = stats.isRunning ? '#1b5e20' : '';

    // Toggle buttons based on producer state
    document.getElementById('runProducerBtn').disabled = stats.isRunning;
    document.getElementById('runProducerBtn').textContent = stats.isRunning ? 'Running Producer...' : 'Run Producer';
    document.getElementById('stopProducerBtn').disabled = !stats.isRunning;

    producerFramesElement.textContent = stats.framesPublished;
    producerDataElement.textContent = `${stats.totalDataSent.toFixed(2)}MB`;
    if (stats.avgPublishFps > 0) {
        avgProducerFpsElement.textContent = stats.avgPublishFps.toFixed(1);
    }
}

function startProducerStatsPolling() {
    if (producerStatsInterval) {
        clearInterval(producerStatsInterval);
    }

    fetchProducerStats();
    producerStatsInterval = setInterval(async () => {
        await fetchProducerStats();
        // Stop polling once producer is done
        if (!document.getElementById('producerStatus').textContent.includes('Running')) {
            clearInterval(producerStatsInterval);
            producerStatsInterval = null;
        }
    }, 500);
}

function clearDisplay() {
    frameDisplay.innerHTML = '<div class="placeholder">Display cleared - Waiting for frames...</div>';
    frameCount = 0;
    fpsCounter = 0;
    frameCountElement.textContent = '0';
    fpsElement.textContent = '0';
    currentFrameElement.textContent = '-';

    // Reset new stats
    totalDataReceived = 0;
    frameReceiveTimes = [];
    frameDisplayTimes = [];
    droppedFrameCount = 0;
    lastFrameNumber = -1;
    totalDataReceivedElement.textContent = '0MB';
    displayFpsActualElement.textContent = '0';
    droppedFramesElement.textContent = '0';
    compressionRatioElement.textContent = '-';
    avgFrameSizeElement.textContent = '-';

    // Clear frame queue
    frameQueue = [];
    updateQueueInfo();
}

async function seekTo(offset) {
    try {
        const response = await fetch('/api/restart-consumer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset })
        });

        const result = await response.json();

        if (response.ok) {
            updateStatus(`Seeked to offset ${offset}`, 'connected');
            frameQueue = [];
            updateQueueInfo();

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                startConsumer();
            }
        } else {
            updateStatus(`Seek error: ${result.error}`, 'error');
        }
    } catch (error) {
        updateStatus(`Failed to seek: ${error.message}`, 'error');
    }
}

function rewindToStart() {
    seekTo('first');
}

function seekRelative(seconds) {
    const fps = currentVideoMetadata ? currentVideoMetadata.fps : 10;
    const frameOffset = Math.round(seconds * fps);
    const newFrame = Math.max(0, lastFrameNumber + frameOffset);
    seekTo(newFrame);
}

async function fetchVideoMetadata() {
    try {
        const response = await fetch('/api/video-metadata');
        if (!response.ok) return; // 404 = no metadata yet, silently ignore
        const metadata = await response.json();
        const changed = JSON.stringify(metadata) !== JSON.stringify(currentVideoMetadata);
        if (changed) {
            currentVideoMetadata = metadata;
            updateVideoMetadataDisplay();
            if (!userSetFps) {
                setDisplayFpsFromVideo();
            }
        }
    } catch (error) {
        // Network error, silently ignore
    }
}

function updateVideoMetadataDisplay() {
    if (!currentVideoMetadata) return;

    videoResolutionElement.textContent = `${currentVideoMetadata.width}x${currentVideoMetadata.height}`;
    videoFpsElement.textContent = `${currentVideoMetadata.fps.toFixed(1)}`;
    videoDurationElement.textContent = `${currentVideoMetadata.duration.toFixed(1)}s`;
    videoCodecElement.textContent = currentVideoMetadata.codec;
}

function setDisplayFpsFromVideo() {
    if (!currentVideoMetadata) return;
    setDisplayFps(currentVideoMetadata.fps);
    updateActiveSpeedButton('presetNormal');
}

function startUptimeCounter() {
    if (uptimeInterval) clearInterval(uptimeInterval);
    uptimeInterval = setInterval(() => {
        if (sessionStartTime) {
            const uptime = Math.floor((Date.now() - sessionStartTime) / 1000);
            const minutes = Math.floor(uptime / 60);
            const seconds = uptime % 60;
            uptimeElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }, 1000);
}

function stopUptimeCounter() {
    if (uptimeInterval) {
        clearInterval(uptimeInterval);
        uptimeInterval = null;
    }
}

// --- Size presets ---

// Height-based presets (p = vertical pixels)
const sizePresets = {
    'size360': 360,
    'size480': 480,
    'size720': 720,
    'size1080': 1080
};

let activeSizeId = 'size480';

function setDisplaySize(sizeId) {
    const height = sizePresets[sizeId];
    if (!height) return;
    activeSizeId = sizeId;

    const img = frameDisplay.querySelector('img');
    if (img) {
        img.style.height = height + 'px';
        img.style.width = 'auto';
        img.style.maxWidth = 'none';
    }
    frameDisplay.style.maxWidth = 'none';

    for (const id of Object.keys(sizePresets)) {
        document.getElementById(id).classList.toggle('active', id === sizeId);
    }
}


// --- Event listeners ---

document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
document.getElementById('runProducerBtn').addEventListener('click', runProducer);
document.getElementById('stopProducerBtn').addEventListener('click', stopProducer);
document.getElementById('clearBtn').addEventListener('click', clearDisplay);
document.getElementById('rewindAllBtn').addEventListener('click', rewindToStart);
document.getElementById('rewind5Btn').addEventListener('click', () => seekRelative(-5));
document.getElementById('forward5Btn').addEventListener('click', () => seekRelative(5));
document.getElementById('forwardEndBtn').addEventListener('click', () => seekTo('last'));

document.getElementById('presetSlow50').addEventListener('click', () => setPresetFps(0.5));
document.getElementById('presetSlow75').addEventListener('click', () => setPresetFps(0.75));
document.getElementById('presetNormal').addEventListener('click', () => setPresetFps(1));
document.getElementById('presetFast150').addEventListener('click', () => setPresetFps(1.5));
document.getElementById('presetFast200').addEventListener('click', () => setPresetFps(2));
document.getElementById('unlimitedBtn').addEventListener('click', setUnlimitedMode);

document.getElementById('size360').addEventListener('click', () => setDisplaySize('size360'));
document.getElementById('size480').addEventListener('click', () => setDisplaySize('size480'));
document.getElementById('size720').addEventListener('click', () => setDisplaySize('size720'));
document.getElementById('size1080').addEventListener('click', () => setDisplaySize('size1080'));

// --- Initialization ---

fpsInterval = setInterval(updateFPS, 1000);
connectionStatusElement.textContent = 'Connecting...';

// Auto-connect consumer but start paused
startConsumer();
startDisplayLoop();

// Fetch initial producer stats and video metadata
fetchProducerStats();
fetchVideoMetadata();
videoMetadataInterval = setInterval(fetchVideoMetadata, 2000);

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
    if (ws) {
        ws.close();
    }
    stopDisplayLoop();
    clearInterval(fpsInterval);
    stopUptimeCounter();
    if (producerStatsInterval) {
        clearInterval(producerStatsInterval);
    }
    if (videoMetadataInterval) {
        clearInterval(videoMetadataInterval);
    }
});
