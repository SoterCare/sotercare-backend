# Use Node.js 20 on Debian Bookworm (Python 3.11 available by default)
FROM node:20-bookworm

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

# Install Python dependencies using a virtual environment
WORKDIR /usr/src/app/apps/ai-summary-service
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel
COPY apps/ai-summary-service/requirements.txt ./
RUN pip3 install --no-cache-dir --default-timeout=100 -r requirements.txt

# Go back to root
WORKDIR /usr/src/app

# Copy source code
COPY . .

# Setup start script
RUN chmod +x start.sh

# Build NestJS applications
RUN npm run build:api
RUN npm run build:auth
RUN npm run build:email
RUN npm run build:health

# Switch back to ai-summary-service context for gRPC generation
WORKDIR /usr/src/app/apps/ai-summary-service

# Create __init__.py files for Python package structure
RUN mkdir -p src/generated
RUN touch src/__init__.py src/core/__init__.py src/generated/__init__.py

# Regenerate ALL proto stubs so gencode version always matches installed runtime
RUN python3 -m grpc_tools.protoc -I../../libs/common/src/proto --python_out=src/generated --grpc_python_out=src/generated ../../libs/common/src/proto/health.proto
RUN python3 -m grpc_tools.protoc -I../../libs/common/src/proto --python_out=src/generated --grpc_python_out=src/generated ../../libs/common/src/proto/summary.proto

# Fix relative imports in generated grpc files
RUN sed -i 's/import health_pb2/from . import health_pb2/g' src/generated/health_pb2_grpc.py
RUN sed -i 's/import summary_pb2/from . import summary_pb2/g' src/generated/summary_pb2_grpc.py

# Go back to root
WORKDIR /usr/src/app

# Expose ports
EXPOSE 3000 50051 50052 50053 50054 6379

# Start command
CMD ["./start.sh"]
