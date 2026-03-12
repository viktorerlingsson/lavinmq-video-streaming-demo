# LavinMQ Video Streaming Demo

A demonstration application that streams video frames through LavinMQ using AMQP stream queues. Frames are extracted from a video file, published as messages, and consumed in real-time via WebSocket for browser playback.

## Features

- Video frame extraction using FFmpeg at native FPS
- AMQP stream queues for replay/seek capability
- Back-pressure via client-driven acks with prefetch
- Transport controls: play/pause, rewind, forward, seek to start/end
- Playback speed presets relative to original FPS (0.5x–2x + Max)
- Display size presets (360p, 480p, 720p, 1080p)
- Auto-reconnect with exponential backoff
- Vite frontend with Express backend

## Prerequisites

1. **Node.js** (v18 or higher)
2. **FFmpeg** — required for video frame extraction
3. **LavinMQ** — AMQP message broker

### Installing FFmpeg

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

### Installing LavinMQ

Follow instructions at [lavinmq.com](https://lavinmq.com/documentation/installation).

## Setup

```bash
npm install
cp .env.example .env  # edit LAVINMQ_URL if needed
```

## Development

```bash
npm run dev
```

This starts both the Express backend (port 3001) and Vite dev server (port 3000) concurrently. Open `http://localhost:3000`.

## Production

```bash
npm run build
npm start
```

The Express server serves the built frontend from `dist/` on port 3000.

## Usage

1. Make sure LavinMQ is running
2. Open the web interface
3. Expand **Video Source** and click **Publish Video** to extract and publish frames (only needed once — frames persist in the stream queue)
4. Press **play** to start playback

See the **How to Use** panel in the app for more details.

### Command-line producer

```bash
node producer.js sample-video.mp4
# or with custom LavinMQ URL
node producer.js sample-video.mp4 amqp://your-server:5672
```

## Architecture

```
Video File → FFmpeg → Producer → LavinMQ Stream Queue → Server → WebSocket → Browser
                      (publish)     (persist/replay)    (consume)  (proxy)   (display)
```

- **Producer** (`producer.js`) — extracts frames with FFmpeg, publishes as base64 JPEG messages to a stream queue
- **Server** (`server.js`) — Express + WebSocket server, consumes from LavinMQ with prefetch 50, forwards frames to browser, acks on client confirmation
- **Frontend** (`src/`) — Vite-served SPA with rAF-based display loop, transport controls, and live statistics

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```
LAVINMQ_URL=amqp://guest:guest@localhost:5672
PORT=3000
```

## Sample Video

Set `SAMPLE_VIDEO_URL` in `.env` to auto-download a sample video on server start. Or place a `sample-video.mp4` in the project root manually.

## Troubleshooting

- **FFmpeg not found** — ensure FFmpeg is installed and in your PATH
- **Connection refused to LavinMQ** — verify LavinMQ is running and the URL in `.env` is correct
- **Frames not displaying** — check browser console for errors, ensure the producer has been run at least once

## License

MIT
