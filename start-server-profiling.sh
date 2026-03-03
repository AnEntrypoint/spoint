#!/bin/bash
# Start server with profiling output to file
cd /c/dev/devbox/spawnpoint
node server.js > server-profiling-output.txt 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server to be ready
sleep 5

# Run profiling
echo "Starting 50-bot profiling..."
node run-profiling.js

# Stop server
kill $SERVER_PID 2>/dev/null || true
sleep 1

echo "Server output saved to server-profiling-output.txt"
