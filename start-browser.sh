#!/bin/bash
# Kill any existing agent-browser daemon on port 50838
PID=$(netstat -ano 2>/dev/null | grep ':50838' | grep LISTENING | awk '{print $NF}' | head -1)
if [ -n "$PID" ]; then
  powershell -Command "Stop-Process -Id $PID -Force" 2>/dev/null
  sleep 1
fi
# Start daemon in headed mode (visible browser window)
AGENT_BROWSER_HEADED=1 node /C/Users/user/AppData/Roaming/npm/node_modules/agent-browser/dist/daemon.js &
sleep 2
echo "agent-browser daemon started (headed, PID=$!)"
