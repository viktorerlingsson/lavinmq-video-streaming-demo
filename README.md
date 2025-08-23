# LavinMQ Video Streaming Demo

A demonstration application that extracts frames from a video file, encodes them as Base64 strings, and streams them through LavinMQ to a web client for real-time playback with configurable display rates.

## Features

- 🎥 720p video frame extraction using FFmpeg
- 🚀 High-throughput streaming via LavinMQ/AMQP (1900+ FPS publishing)
- 📡 WebSocket-based web client with frame queuing
- 📊 Comprehensive performance metrics (producer & consumer stats)
- 🎛️ Configurable display FPS (0.1 - 60 FPS)
- 🌐 Manual start/stop controls for producer and consumer
- ⏱️ Real-time processing time measurement

## Prerequisites

1. **Node.js** (v14 or higher)
2. **FFmpeg** - Required for video frame extraction
3. **LavinMQ** - AMQP message broker

### Installing FFmpeg

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

### Installing LavinMQ

**Docker (Recommended):**
```bash
docker run -d --name lavinmq -p 5672:5672 -p 15672:15672 lavinmq/lavinmq
```

**Manual Installation:**
Follow instructions at [LavinMQ Documentation](https://lavinmq.com/documentation/installation)

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

## Usage

### 1. Start LavinMQ
Make sure LavinMQ is running on `localhost:5672` (default).

### 2. Generate Sample Video (Optional)
Create a 720p test video:
```bash
./create-sample-video.sh
```

### 3. Start the Web Server
```bash
npm start
```

The web interface will be available at: `http://localhost:3000`

### 4. Use the Web Interface
1. **Open browser** to `http://localhost:3000`
2. **Set display FPS** using the input field (try 1-5 FPS to see individual frames)
3. **Click "Start Consumer"** to connect and begin receiving frames
4. **Click "Run Producer"** to process the video and start streaming
5. **Watch frames** display at your chosen rate with live statistics

### Alternative: Command Line Producer
You can also run the producer from command line:
```bash
node producer.js sample-video.mp4
# or with custom LavinMQ URL
node producer.js sample-video.mp4 amqp://your-lavinmq-server:5672
```

## How It Works

1. **Producer** (`producer.js`):
   - Uses FFmpeg to extract 720p PNG frames at 10 FPS from video
   - Converts frames to Base64 strings (~150KB each)
   - Publishes frames to LavinMQ as fast as possible (1900+ FPS)
   - Provides real-time extraction and publishing statistics

2. **Consumer Server** (`server.js`):
   - Starts consuming from LavinMQ only when WebSocket clients connect
   - Forwards frame messages to connected web clients via WebSocket
   - Tracks producer statistics and exposes API endpoints

3. **Web Client** (`index.html`):
   - Manual connection controls (no auto-start)
   - Configurable display FPS with frame queuing system
   - Real-time metrics: processing time, FPS, queue status
   - Rate-limited display independent of publishing speed

## Architecture

```
Video File → FFmpeg → Producer → LavinMQ → Server → WebSocket → Browser
   (720p)   (extract) (1900fps)  (queue)   (serve)  (stream)   (display @custom fps)
```

## Performance Metrics

The demo tracks comprehensive performance data:

**Producer Stats:**
- Extraction FPS (how fast FFmpeg processes video)
- Publishing FPS (how fast frames are sent to LavinMQ)
- Progress tracking and data throughput

**Consumer Stats:**
- Processing time per frame (DOM manipulation cost)
- Display FPS (actual frame display rate)
- Queue size (frames waiting to be displayed)

## Configuration

### Environment Variables
- `PORT`: Web server port (default: 3000)
- `LAVINMQ_URL`: LavinMQ connection URL (default: amqp://localhost:5672)

### Display Settings
- **FPS Control**: Set any value from 0.1 to 60 FPS via web interface
- **Preset Buttons**: Quick settings for 1, 5, 10, 30 FPS
- **Queue Monitoring**: Color-coded queue status indicator

## Sample Video Generation

The included script generates a test pattern video:
- **Resolution**: 1280x720 (720p)
- **Duration**: 10 seconds
- **Frame Rate**: 10 FPS (100 frames total)
- **File Size**: ~171KB

```bash
./create-sample-video.sh
```

## Performance Characteristics

**Typical Performance:**
- **Producer**: 1900+ FPS publishing rate
- **Frame Size**: ~150KB Base64-encoded PNG
- **Total Data**: ~15MB for 10-second video
- **Processing Time**: 1-10ms per frame (browser-dependent)

**LavinMQ Capabilities Demonstrated:**
- High-throughput message publishing
- Reliable message queuing and delivery
- Real-time streaming with WebSocket integration

## Troubleshooting

**FFmpeg not found:**
- Ensure FFmpeg is installed and accessible in your PATH

**Connection refused to LavinMQ:**
- Verify LavinMQ is running on the correct port
- Check firewall settings

**Frames not displaying:**
- Check browser console for errors
- Verify WebSocket connection in browser dev tools
- Ensure video file format is supported by FFmpeg

## License

MIT License - Feel free to use this for your LavinMQ demonstrations!