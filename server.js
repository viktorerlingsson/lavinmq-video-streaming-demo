require('dotenv').config();
const express = require('express');
const amqp = require('amqplib');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const LAVINMQ_URL = process.env.LAVINMQ_URL || 'amqp://localhost:5672';
const QUEUE_NAME = 'video_frames';
const SAMPLE_VIDEO_PATH = path.join(__dirname, 'sample-video.mp4');
const SAMPLE_VIDEO_URL = process.env.SAMPLE_VIDEO_URL || 'https://lavinmq-demos.s3.us-east-2.amazonaws.com/video-demo/sample_video.mp4';

// Global producer stats storage
let currentProducerStats = {
  isRunning: false,
  startTime: null,
  framesPublished: 0,
  totalDataSent: 0,
  avgPublishFps: 0
};

// Store video metadata for clients
let currentVideoMetadata = null;

// Current producer child process
let producerProcess = null;

app.use(express.json());

// Serve built frontend in production
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('/', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// API endpoint to run producer
app.post('/api/run-producer', (req, res) => {
  if (currentProducerStats.isRunning) {
    return res.status(400).json({
      success: false,
      error: 'Producer is already running'
    });
  }
  
  const videoPath = SAMPLE_VIDEO_PATH;
  
  console.log('Starting producer process...');
  
  // Reset stats
  currentProducerStats = {
    isRunning: true,
    startTime: Date.now(),
    framesPublished: 0,
    totalDataSent: 0,
    avgPublishFps: 0
  };
  
  producerProcess = spawn('node', ['producer.js', videoPath, LAVINMQ_URL], {
    cwd: __dirname,
    stdio: 'pipe'
  });

  producerProcess.stdout.on('data', (data) => {
    const message = data.toString();
    console.log(`Producer: ${message.trim()}`);
    parseProducerStats(message);
  });

  producerProcess.stderr.on('data', (data) => {
    console.error(`Producer Error: ${data.toString().trim()}`);
  });

  producerProcess.on('close', (code) => {
    console.log(`Producer process exited with code ${code}`);
    currentProducerStats.isRunning = false;
    producerProcess = null;

    if (code === 0) {
      console.log('Producer completed successfully');
    } else {
      console.error('Producer failed');
    }
  });

  producerProcess.on('error', (error) => {
    console.error('Failed to start producer:', error.message);
    currentProducerStats.isRunning = false;
    producerProcess = null;
  });
  
  // Return immediately with success response
  res.json({
    success: true,
    message: 'Producer started in background'
  });
});

// API endpoint to stop producer
app.post('/api/stop-producer', (req, res) => {
  if (!producerProcess) {
    return res.status(400).json({ success: false, error: 'Producer is not running' });
  }

  producerProcess.kill('SIGTERM');
  res.json({ success: true, message: 'Producer stopped' });
});

// API endpoint to get producer stats
app.get('/api/producer-stats', (req, res) => {
  res.json(currentProducerStats);
});

// API endpoint to get video metadata
app.get('/api/video-metadata', (req, res) => {
  if (currentVideoMetadata) {
    res.json(currentVideoMetadata);
  } else {
    res.status(404).json({ 
      error: 'No video metadata available',
      message: 'Run producer first or ensure stream queue has metadata' 
    });
  }
});

// API endpoint to restart consumer with replay option
app.post('/api/restart-consumer', async (req, res) => {
  const { offset } = req.body;

  try {
    if (isConsuming) {
      try { await consumer.close(); } catch (e) { /* may already be closed */ }
      isConsuming = false;
    }

    unackedMessages.clear();
    await consumer.connect();
    await consumer.startConsuming(offset);
    isConsuming = true;

    res.json({ success: true, offset });
  } catch (error) {
    console.error('Failed to restart consumer:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Parse stats from producer console output
function parseProducerStats(message) {
  // Look for structured STATS: lines from producer
  const lines = message.split('\n');
  for (const line of lines) {
    if (!line.startsWith('STATS:')) continue;
    try {
      const stats = JSON.parse(line.slice(6));
      if (stats.type === 'complete') {
          currentProducerStats.framesPublished = stats.framesPublished;
          currentProducerStats.totalDataSent = stats.totalDataSent;
          currentProducerStats.avgPublishFps = stats.avgPublishFps;
      }
    } catch (error) {
      // Ignore malformed lines
    }
  }
}

// Map of frameNumber -> AMQP message, awaiting client ack
let unackedMessages = new Map();

// WebSocket connection handler
wss.on('connection', async (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ack' && msg.frameNumber != null) {
        const entry = unackedMessages.get(msg.frameNumber);
        if (entry) {
          entry.channel.ack(entry.message);
          unackedMessages.delete(msg.frameNumber);
        }
      }
    } catch (error) {
      // Ignore malformed messages
    }
  });

  // Start consuming frames when first client connects
  try {
    await startConsumingIfClients();
  } catch (error) {
    console.error('Failed to start consuming:', error.message);
  }

  ws.on('close', () => {
    console.log('Client disconnected');
    for (const { message, channel } of unackedMessages.values()) {
      try { channel.nack(message, false, true); } catch (e) { /* channel may be closed */ }
    }
    unackedMessages.clear();
  });
});

// LavinMQ Consumer
class FrameConsumer {
  constructor(lavinMQUrl = LAVINMQ_URL) {
    this.lavinMQUrl = lavinMQUrl;
    this.connection = null;
    this.channel = null;
  }

  async connect() {
    try {
      this.connection = await amqp.connect(this.lavinMQUrl);
      this.connection.on('error', () => { isConsuming = false; });
      this.connection.on('close', () => { isConsuming = false; });
      this.channel = await this.connection.createChannel();
      await this.channel.prefetch(50);

      console.log('Connected to LavinMQ');
    } catch (error) {
      console.error('Failed to connect to LavinMQ:', error.message);
      throw error;
    }
  }

  async startConsuming(offset = 'first') {
    console.log(`Starting to consume from queue: ${QUEUE_NAME} (offset: ${offset})`);

    const consumeOptions = {
      noAck: false,
      arguments: {
        'x-stream-offset': offset
      }
    };
    
    await this.channel.consume(QUEUE_NAME, (message) => {
      if (message !== null) {
        try {
          const frameData = JSON.parse(message.content.toString());
          
          // Store video metadata from first frame (or updated on re-publish)
          if (frameData.metadata) {
            currentVideoMetadata = frameData.metadata;
          }
          
          const jsonMessage = JSON.stringify({
            frameNumber: frameData.frameNumber,
            timestamp: frameData.timestamp,
            data: frameData.imageData,
            mimeType: frameData.mimeType,
            metadata: frameData.metadata
          });
          
          // Hold message until client acks after display
          unackedMessages.set(frameData.frameNumber, { message, channel: this.channel });

          // Broadcast to all connected WebSocket clients
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(jsonMessage);
            }
          });
          
        } catch (error) {
          console.error('Error processing message:', error.message);
          this.channel.nack(message, false, false);
        }
      }
    }, consumeOptions);
    
    console.log('Started consuming frames from LavinMQ stream');
  }


  async close() {
    try { if (this.channel) await this.channel.close(); } catch (e) { /* already closed */ }
    try { if (this.connection) await this.connection.close(); } catch (e) { /* already closed */ }
    this.channel = null;
    this.connection = null;
  }
}

// Start the consumer
const consumer = new FrameConsumer();
let isConsuming = false;

async function startConsumingIfClients() {
  if (wss.clients.size > 0 && !isConsuming) {
    console.log('WebSocket clients connected, starting to consume frames...');
    await consumer.connect();
    await consumer.startConsuming();
    isConsuming = true;
  }
}

async function ensureSampleVideo() {
  if (fs.existsSync(SAMPLE_VIDEO_PATH)) return;
  if (!SAMPLE_VIDEO_URL) {
    console.log('No sample-video.mp4 found. Set SAMPLE_VIDEO_URL in .env to auto-download.');
    return;
  }
  console.log(`Downloading sample video from ${SAMPLE_VIDEO_URL}...`);
  const response = await fetch(SAMPLE_VIDEO_URL);
  if (!response.ok) {
    console.error(`Failed to download sample video: ${response.status}`);
    return;
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(SAMPLE_VIDEO_PATH));
  console.log('Sample video downloaded.');
}

async function startServer() {
  await ensureSampleVideo();
  try {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log('Ready for WebSocket connections...');
    });

  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await consumer.close();
  server.close();
  process.exit(0);
});

startServer();