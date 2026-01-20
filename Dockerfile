# Use Node.js 18 as the base image
FROM node:18-bullseye

# Install Python 3 and pip
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

# Set working directory
WORKDIR /usr/src/app

# Copy package files (Node)
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Install Redis and Postgres
RUN apt-get update && apt-get install -y redis-server postgresql postgresql-contrib

# Copy source code
COPY . .

# Copy and setup start script
COPY start.sh ./
RUN chmod +x start.sh

# Build NestJS applications
RUN npm run build:api
RUN npm run build:auth
RUN npm run build:email

# Setup Python Environment
WORKDIR /usr/src/app/apps/ai-summary-service
RUN python3 -m venv venv
RUN . venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt
# Generate Proto code
RUN . venv/bin/activate && python3 -m grpc_tools.protoc -I../../libs/common/src/proto --python_out=. --grpc_python_out=. summary.proto

# Go back to root
WORKDIR /usr/src/app

# Expose ports
EXPOSE 3000 50051 50052 50053 6379

# Start command
CMD ["./start.sh"]
