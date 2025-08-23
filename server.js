const express = require('express');
const amqp = require('amqplib');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const LAVINMQ_URL = process.env.LAVINMQ_URL || 'amqp://localhost:5672';
const QUEUE_NAME = 'video_frames';

// Global producer stats storage
let currentProducerStats = {
  isRunning: false,
  startTime: null,
  progress: 0,
  currentFps: 0,
  framesPublished: 0,
  totalFrames: 0,
  totalDataSent: 0,
  extractionTime: 0,
  publishingTime: 0
};

app.use(express.static('public'));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to run producer
app.post('/api/run-producer', (req, res) => {
  if (currentProducerStats.isRunning) {
    return res.status(400).json({
      success: false,
      error: 'Producer is already running'
    });
  }
  
  const videoPath = path.join(__dirname, 'sample-video.mp4');
  
  console.log('Starting producer process...');
  
  // Reset stats
  currentProducerStats = {
    isRunning: true,
    startTime: Date.now(),
    progress: 0,
    currentFps: 0,
    framesPublished: 0,
    totalFrames: 0,
    totalDataSent: 0,
    extractionTime: 0,
    publishingTime: 0
  };
  
  const producer = spawn('node', ['producer.js', videoPath], {
    cwd: __dirname,
    stdio: 'pipe'
  });
  
  let output = '';
  let errorOutput = '';
  
  producer.stdout.on('data', (data) => {
    const message = data.toString();
    output += message;
    console.log(`Producer: ${message.trim()}`);
    
    // Parse stats from producer output
    parseProducerStats(message);
  });
  
  producer.stderr.on('data', (data) => {
    const message = data.toString();
    errorOutput += message;
    console.error(`Producer Error: ${message.trim()}`);
  });
  
  producer.on('close', (code) => {
    console.log(`Producer process exited with code ${code}`);
    currentProducerStats.isRunning = false;
    
    if (code === 0) {
      console.log('Producer completed successfully');
    } else {
      console.error('Producer failed');
    }
  });
  
  producer.on('error', (error) => {
    console.error('Failed to start producer:', error.message);
    currentProducerStats.isRunning = false;
  });
  
  // Return immediately with success response
  res.json({
    success: true,
    message: 'Producer started in background',
    videoPath: videoPath
  });
});

// API endpoint to get producer stats
app.get('/api/producer-stats', (req, res) => {
  res.json(currentProducerStats);
});

// Parse stats from producer console output
function parseProducerStats(message) {
  try {
    // Parse progress updates
    const progressMatch = message.match(/Progress: ([\d.]+)%.*Publishing FPS: ([\d.]+)/);
    if (progressMatch) {
      currentProducerStats.progress = parseFloat(progressMatch[1]);
      currentProducerStats.currentFps = parseFloat(progressMatch[2]);
    }
    
    // Parse extraction stats
    const extractionMatch = message.match(/Frames extracted: (\d+)/);
    if (extractionMatch) {
      currentProducerStats.totalFrames = parseInt(extractionMatch[1]);
    }
    
    const extractionTimeMatch = message.match(/Extraction time: ([\d.]+)s/);
    if (extractionTimeMatch) {
      currentProducerStats.extractionTime = parseFloat(extractionTimeMatch[1]);
    }
    
    // Parse final stats
    const publishingTimeMatch = message.match(/Publishing time: ([\d.]+)s/);
    if (publishingTimeMatch) {
      currentProducerStats.publishingTime = parseFloat(publishingTimeMatch[1]);
    }
    
    const framesPublishedMatch = message.match(/Frames published: (\d+)\/(\d+)/);
    if (framesPublishedMatch) {
      currentProducerStats.framesPublished = parseInt(framesPublishedMatch[1]);
    }
    
    const totalDataMatch = message.match(/Total data published: ([\d.]+)MB/);
    if (totalDataMatch) {
      currentProducerStats.totalDataSent = parseFloat(totalDataMatch[1]);
    }
    
  } catch (error) {
    // Ignore parsing errors
  }
}

// WebSocket connection handler
wss.on('connection', async (ws) => {
  console.log('Client connected');
  
  // Start consuming frames when first client connects
  await startConsumingIfClients();
  
  ws.on('close', () => {
    console.log('Client disconnected');
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
      this.channel = await this.connection.createChannel();
      await this.channel.assertQueue(QUEUE_NAME, { durable: false });
      console.log('Connected to LavinMQ');
    } catch (error) {
      console.error('Failed to connect to LavinMQ:', error.message);
      throw error;
    }
  }

  async startConsuming() {
    console.log(`Starting to consume from queue: ${QUEUE_NAME}`);
    
    await this.channel.consume(QUEUE_NAME, (message) => {
      if (message !== null) {
        try {
          const frameData = JSON.parse(message.content.toString());
          
          console.log(`Received frame ${frameData.frameNumber}, WebSocket clients: ${wss.clients.size}`);
          
          // Broadcast frame to all connected WebSocket clients
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(frameData));
              console.log(`Sent frame ${frameData.frameNumber} to WebSocket client`);
            }
          });
          
          console.log(`Broadcasted frame ${frameData.frameNumber}`);
          this.channel.ack(message);
          
        } catch (error) {
          console.error('Error processing message:', error.message);
          this.channel.nack(message, false, false);
        }
      } else {
        console.log('Received null message');
      }
    });
    
    console.log('Started consuming frames from LavinMQ');
  }

  async close() {
    if (this.channel) await this.channel.close();
    if (this.connection) await this.connection.close();
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

async function startServer() {
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