FROM node:20-bookworm AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

# Build only the API Gateway for a lightweight runtime image.
RUN npm run build:api


FROM node:20-bookworm-slim AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
# Keep Node heap conservative for low-memory hosts.
ENV NODE_OPTIONS=--max-old-space-size=256

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /usr/src/app/dist/apps/api-gateway ./dist/apps/api-gateway
COPY --from=builder /usr/src/app/libs/common/src/proto ./libs/common/src/proto

EXPOSE 3000

CMD ["node", "dist/apps/api-gateway/main"]
