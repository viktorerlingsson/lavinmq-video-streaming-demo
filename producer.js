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
        // Queue might not exist, which is fine
        console.log('No existing queue to delete');
      }
      
      // Configure as stream queue for replay capability
      const queueArgs = {
        'x-queue-type': 'stream',
        'x-max-age': '1h' // Keep messages for 1 hour
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
          fps: eval(videoStream.r_frame_rate), // Parse fraction like "30/1"
          codec: videoStream.codec_name,
          bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null
        };
        
        resolve(videoMetadata);
      });
    });
  }

  async extractAndPublishFrames() {
    // Get video metadata first
    const videoMetadata = await this.getVideoMetadata();
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

    const stats = {
      startTime: Date.now(),
      extractionStartTime: null,
      extractionEndTime: null,
      publishingStartTime: null,
      publishingEndTime: null,
      totalFrames: 0,
      framesPublished: 0,
      totalDataSent: 0,
      videoMetadata: videoMetadata
    };

    return new Promise((resolve, reject) => {
      let frameCount = 0;
      stats.extractionStartTime = Date.now();
      
      ffmpeg(this.videoPath)
        .outputOptions([
          '-vf fps=10', // Extract 10 frames per second
          '-f image2',
          '-vcodec mjpeg',
          '-q:v 3' // High quality JPEG (1-31, lower = better quality)
        ])
        .output(path.join(tempDir, 'frame_%04d.jpg'))
        .on('end', async () => {
          stats.extractionEndTime = Date.now();
          stats.totalFrames = frameCount;
          
          const extractionTime = (stats.extractionEndTime - stats.extractionStartTime) / 1000;
          console.log(`📊 EXTRACTION STATS:`);
          console.log(`   Frames extracted: ${frameCount}`);
          console.log(`   Extraction time: ${extractionTime.toFixed(2)}s`);
          console.log(`   Extraction FPS: ${(frameCount / extractionTime).toFixed(1)}`);
          
          try {
            const frameFiles = await fs.readdir(tempDir);
            frameFiles.sort();
            
            stats.publishingStartTime = Date.now();
            console.log('\n📡 PUBLISHING STATS:');
            
            let publishedCount = 0;
            let publishFpsCounter = 0;
            let lastPublishFpsTime = Date.now();
            
            for (let i = 0; i < frameFiles.length; i++) {
              const framePath = path.join(tempDir, frameFiles[i]);
              const frameBuffer = await fs.readFile(framePath);
              
              // Create message with base64 encoded image (for JSON compatibility with current server)
              const metadata = i === 0 ? videoMetadata : null;
              const frameMessage = {
                frameNumber: i,
                timestamp: Date.now(),
                imageData: frameBuffer.toString('base64'), // Convert to base64 for JSON
                mimeType: 'image/jpeg',
                metadata: metadata
              };
              
              // Serialize as JSON for now (can optimize further later)
              const messageBuffer = Buffer.from(JSON.stringify(frameMessage));
              stats.totalDataSent += messageBuffer.length;
              
              await this.channel.sendToQueue(
                this.queueName,
                messageBuffer,
                { 
                  persistent: true,
                  // Add message properties for stream replay
                  messageId: `frame_${i}`,
                  timestamp: Date.now()
                }
              );
              
              publishedCount++;
              publishFpsCounter++;
              stats.framesPublished = publishedCount;
              
              // Calculate and display real-time stats every 10 frames
              if (i > 0 && (i + 1) % 10 === 0) {
                const now = Date.now();
                const timeDiff = (now - lastPublishFpsTime) / 1000;
                const currentFps = publishFpsCounter / timeDiff;
                const progress = ((i + 1) / frameFiles.length * 100).toFixed(1);
                const avgDataPerFrame = (stats.totalDataSent / publishedCount / 1024).toFixed(1);
                
                console.log(`   Progress: ${progress}% (${i + 1}/${frameFiles.length}) | Publishing FPS: ${currentFps.toFixed(1)} | Avg frame size: ${avgDataPerFrame}KB`);
                
                publishFpsCounter = 0;
                lastPublishFpsTime = now;
              }
              
              // No delay - publish as fast as possible
            }
            
            stats.publishingEndTime = Date.now();
            
            // Final stats summary
            const totalTime = (stats.publishingEndTime - stats.startTime) / 1000;
            const publishTime = (stats.publishingEndTime - stats.publishingStartTime) / 1000;
            const avgPublishFps = stats.framesPublished / publishTime;
            const totalDataMB = (stats.totalDataSent / 1024 / 1024).toFixed(2);
            const avgFrameSizeKB = (stats.totalDataSent / stats.framesPublished / 1024).toFixed(1);
            
            console.log(`\n🎯 FINAL STATS:`);
            console.log(`   Total time: ${totalTime.toFixed(2)}s`);
            console.log(`   Publishing time: ${publishTime.toFixed(2)}s`);
            console.log(`   Average publishing FPS: ${avgPublishFps.toFixed(1)}`);
            console.log(`   Total data published: ${totalDataMB}MB`);
            console.log(`   Average frame size: ${avgFrameSizeKB}KB`);
            console.log(`   Frames published: ${stats.framesPublished}/${stats.totalFrames}`);
            
            // Cleanup temp files
            await fs.remove(tempDir);
            console.log('\n✅ All frames published successfully!');
            resolve(stats);
            
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
            frameCount = progress.frames;
            // Show extraction progress every 10 frames
            if (frameCount > 0 && frameCount % 10 === 0) {
              console.log(`   Extracting... ${frameCount} frames processed`);
            }
          }
        })
        .run();
    });
  }

  async close() {
    if (this.channel) await this.channel.close();
    if (this.connection) await this.connection.close();
    console.log('Disconnected from LavinMQ');
  }
}

// Main execution
async function main() {
  const videoPath = process.argv[2] || './sample-video.mp4';
  const lavinMQUrl = process.argv[3] || 'amqp://localhost:5672';

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
    await producer.extractAndPublishFrames();
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await producer.close();
  }
}

if (require.main === module) {
  main();
}