#!/bin/bash

# Start Redis in the background
echo "Starting Redis Server..."
redis-server --daemonize yes

# Wait a moment for Redis to start
sleep 2

# Check if Redis is running
if pgrep "redis-server" > /dev/null
then
    echo "Redis Server returned: Running"
else
    echo "Redis Server returned: Stopped (Error)"
fi

# Start the Node.js/Python Microservices
echo "Starting Microservices..."
npm run start:prod:all
