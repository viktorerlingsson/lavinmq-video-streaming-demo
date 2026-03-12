require('dotenv').config();
const amqp = require('amqplib');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

class VideoFrameProducer {
  constructor(videoPath, lavinMQUrl = 'amqp://localhost:5672') {
    this.videoPath = videoPath;
    this.lavinMQUrl = lavinMQUrl;
    this.connection = null;
    this.channel = null;
    this.queueName = 'video_frames';
  }

  async connect(videoMetadata = null) {
    try {
      this.connection = await amqp.connect(this.lavinMQUrl);
      this.channel = await this.connection.createChannel();

      // Delete existing queue to ensure clean slate with correct metadata
      try {
        await this.channel.deleteQueue(this.queueName);
        console.log('Deleted existing queue to refresh metadata');
      } catch (error) {
        // deleteQueue failure closes the channel in AMQP — recreate it
        this.channel = await this.connection.createChannel();
      }
      
      // Configure as stream queue for replay capability
      const queueArgs = {
        'x-queue-type': 'stream',
        'x-max-length-bytes': 1073741824 // 1 GB
      };
      
      // Add video metadata as queue arguments if provided
      if (videoMetadata) {
        queueArgs['x-video-width'] = videoMetadata.width.toString();
        queueArgs['x-video-height'] = videoMetadata.height.toString();
        queueArgs['x-video-fps'] = videoMetadata.fps.toString();
        queueArgs['x-video-duration'] = videoMetadata.duration.toString();
        queueArgs['x-video-codec'] = videoMetadata.codec;
        if (videoMetadata.bitrate) {
          queueArgs['x-video-bitrate'] = videoMetadata.bitrate.toString();
        }
      }
      
      await this.channel.assertQueue(this.queueName, { 
        durable: true,
        arguments: queueArgs
      });
      
      console.log(`Connected to LavinMQ with fresh stream queue${videoMetadata ? ' (with metadata)' : ''}`);
    } catch (error) {
      console.error('Failed to connect to LavinMQ:', error.message);
      throw error;
    }
  }

  async getVideoMetadata() {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(this.videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream) {
          reject(new Error('No video stream found'));
          return;
        }
        
        const videoMetadata = {
          duration: parseFloat(metadata.format.duration),
          width: videoStream.width,
          height: videoStream.height,
          fps: videoStream.r_frame_rate.split('/').reduce((a, b) => a / b),
          codec: videoStream.codec_name,
          bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null
        };
        
        resolve(videoMetadata);
      });
    });
  }

  async extractAndPublishFrames(videoMetadata) {
    console.log('📹 VIDEO METADATA:');
    console.log(`   Resolution: ${videoMetadata.width}x${videoMetadata.height}`);
    console.log(`   Original FPS: ${videoMetadata.fps}`);
    console.log(`   Duration: ${videoMetadata.duration.toFixed(2)}s`);
    console.log(`   Codec: ${videoMetadata.codec}`);
    if (videoMetadata.bitrate) {
      console.log(`   Bitrate: ${Math.round(videoMetadata.bitrate / 1000)}kbps`);
    }

    const tempDir = path.join(__dirname, 'temp_frames');
    await fs.ensureDir(tempDir);

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let extractedFrames = 0;
      const extractionStart = Date.now();

      ffmpeg(this.videoPath)
        .outputOptions([
          `-vf fps=${videoMetadata.fps}`,
          '-f image2',
          '-vcodec mjpeg',
          '-q:v 3'
        ])
        .output(path.join(tempDir, 'frame_%04d.jpg'))
        .on('end', async () => {
          const extractionTime = (Date.now() - extractionStart) / 1000;
          console.log(`STATS:${JSON.stringify({ type: 'extraction', totalFrames: extractedFrames, extractionTime })}`);

          try {
            const frameFiles = await fs.readdir(tempDir);
            frameFiles.sort();

            const publishStart = Date.now();
            let totalDataSent = 0;

            for (let i = 0; i < frameFiles.length; i++) {
              const framePath = path.join(tempDir, frameFiles[i]);
              const frameBuffer = await fs.readFile(framePath);

              const frameMessage = {
                frameNumber: i,
                timestamp: Date.now(),
                imageData: frameBuffer.toString('base64'),
                mimeType: 'image/jpeg',
                metadata: i === 0 ? videoMetadata : null
              };

              const messageBuffer = Buffer.from(JSON.stringify(frameMessage));
              totalDataSent += messageBuffer.length;

              this.channel.sendToQueue(
                this.queueName,
                messageBuffer,
                {
                  persistent: true,
                  messageId: `frame_${i}`,
                  timestamp: Date.now()
                }
              );
            }

            const publishTime = (Date.now() - publishStart) / 1000;
            const totalTime = (Date.now() - startTime) / 1000;
            const totalDataMB = parseFloat((totalDataSent / 1024 / 1024).toFixed(2));
            const avgPublishFps = frameFiles.length / publishTime;
            console.log(`STATS:${JSON.stringify({ type: 'complete', totalTime, publishingTime: publishTime, avgPublishFps, totalDataSent: totalDataMB, framesPublished: frameFiles.length, totalFrames: extractedFrames })}`);

            await fs.remove(tempDir);
            console.log('\n✅ All frames published successfully!');
            resolve();

          } catch (error) {
            await fs.remove(tempDir);
            reject(error);
          }
        })
        .on('error', async (error) => {
          await fs.remove(tempDir);
          reject(error);
        })
        .on('progress', (progress) => {
          if (progress.frames) {
            extractedFrames = progress.frames;
            if (extractedFrames % 10 === 0) {
              console.log(`   Extracting... ${extractedFrames} frames processed`);
            }
          }
        })
        .run();
    });
  }

  async close() {
    try { if (this.channel) await this.channel.close(); } catch (e) { /* already closed */ }
    try { if (this.connection) await this.connection.close(); } catch (e) { /* already closed */ }
    console.log('Disconnected from LavinMQ');
  }
}

// Main execution
async function main() {
  const videoPath = process.argv[2] || './sample-video.mp4';
  const lavinMQUrl = process.argv[3] || process.env.LAVINMQ_URL || 'amqp://localhost:5672';

  if (!fs.existsSync(videoPath)) {
    console.error('Error: Video file not found:', videoPath);
    console.log('Usage: node producer.js <video-file> [lavinmq-url]');
    process.exit(1);
  }

  const producer = new VideoFrameProducer(videoPath, lavinMQUrl);

  try {
    // Get metadata first, then connect with it
    const videoMetadata = await producer.getVideoMetadata();
    await producer.connect(videoMetadata);
    await producer.extractAndPublishFrames(videoMetadata);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await producer.close();
  }
}

if (require.main === module) {
  main();
}