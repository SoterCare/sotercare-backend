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

# Install Redis and Postgres and clean default data
RUN apt-get update && apt-get install -y redis-server postgresql postgresql-contrib && rm -rf /var/lib/postgresql/ /var/log/postgresql/

# Copy source code
COPY . .

# Copy and setup start script
COPY start.sh ./
RUN chmod +x start.sh

# Build NestJS applications
RUN npm run build:api
RUN npm run build:auth
RUN npm run build:email
RUN npm run build:health

# Install Python dependencies globally (no venv needed in container)
WORKDIR /usr/src/app/apps/ai-summary-service
RUN pip3 install --no-cache-dir -r requirements.txt

# Create __init__.py files for Python package structure
RUN touch src/__init__.py src/core/__init__.py src/generated/__init__.py

# Generate Proto code in the new src/generated directory
RUN python3 -m grpc_tools.protoc -I../../libs/common/src/proto --python_out=src/generated --grpc_python_out=src/generated ../../libs/common/src/proto/summary.proto

# Fix the relative import in generated grpc file
RUN sed -i 's/import summary_pb2/from . import summary_pb2/g' src/generated/summary_pb2_grpc.py

# Go back to root
WORKDIR /usr/src/app

# Expose ports
EXPOSE 3000 50051 50052 50053 50054 6379

# Start command
CMD ["./start.sh"]
