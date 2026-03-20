FROM node:20-bookworm AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .

# Build only the API Gateway for a lightweight runtime image.
RUN npm run build:api
RUN npm run build:auth
RUN npm run build:email
RUN npm run build:health
# Keep only production dependencies for the final image.
RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runner

WORKDIR /usr/src/app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Keep Node heap conservative for low-memory hosts.
ENV NODE_OPTIONS=--max-old-space-size=256
ENV PATH=/opt/venv/bin:$PATH

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY package*.json ./

COPY --from=builder /usr/src/app/dist/apps/api-gateway ./dist/apps/api-gateway
COPY --from=builder /usr/src/app/dist/apps/auth-service ./dist/apps/auth-service
COPY --from=builder /usr/src/app/dist/apps/email-service ./dist/apps/email-service
COPY --from=builder /usr/src/app/dist/apps/health-service ./dist/apps/health-service
COPY --from=builder /usr/src/app/libs/common/src/proto ./libs/common/src/proto
COPY apps/ai-summary-service/requirements.txt ./apps/ai-summary-service/requirements.txt
COPY apps/ai-summary-service/src ./apps/ai-summary-service/src

RUN python3 -m venv /opt/venv \
	&& /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
	&& /opt/venv/bin/pip install --no-cache-dir -r apps/ai-summary-service/requirements.txt

EXPOSE 3000 50051 50052 50053 50054

CMD ["sh", "-c", "node dist/apps/api-gateway/main & node dist/apps/auth-service/main & node dist/apps/email-service/main & node dist/apps/health-service/main & python3 apps/ai-summary-service/src/main.py & wait"]
