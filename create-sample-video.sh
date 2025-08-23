#!/bin/bash

# Create a sample video with moving test pattern
# Requires FFmpeg to be installed

echo "Creating sample video with FFmpeg..."

ffmpeg -f lavfi -i "testsrc=duration=10:size=1280x720:rate=10" \
       -f lavfi -i "sine=frequency=1000:duration=10" \
       -c:v libx264 -c:a aac -pix_fmt yuv420p \
       -y sample-video.mp4

if [ $? -eq 0 ]; then
    echo "✅ Sample video created: sample-video.mp4"
    echo "📁 File size: $(ls -lh sample-video.mp4 | awk '{print $5}')"
    echo "🎬 Duration: 10 seconds, 10 FPS, 1280x720 (720p)"
else
    echo "❌ Failed to create sample video. Please check if FFmpeg is installed."
    exit 1
fi