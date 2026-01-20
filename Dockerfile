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

# Copy source code
COPY . .

# Build NestJS applications
# We need to build all apps. Since we don't have a single build:all, we build them individually or rely on the fact that they are monorepo apps.
# Ideally, we should build them to dist folder.
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
EXPOSE 3000 50051 50052 50053

# Start command
# We use a custom start command to run everything.
# We need to ensure we use the built versions (dist) for Node apps for performance, 
# and the venv python for the AI service.

CMD ["npm", "run", "start:prod:all"]
