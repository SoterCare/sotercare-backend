# NestJS Auth Microservice (gRPC + HTTP)

This is a **NestJS Monorepo** project implementing an **Authentication Flow** using Email-based TOTP (Time-based One-Time Password) for Registration and Login. It uses **gRPC** for efficient inter-service communication and exposes an **HTTP API Gateway** for client interaction.

## Architecture

The system consists of three microservices:

1.  **API Gateway** (`apps/api-gateway`):
    -   Exposes HTTP REST endpoints.
    -   Acts as a proxy, converting HTTP requests to gRPC calls.
    -   Forwards requests to the **Auth Service**.
    -   **Swagger UI**: Available at `/api`.

2.  **Auth Service** (`apps/auth-service`):
    -   **Transport**: gRPC (Port `50051`).
    -   **Persistence**: PostgreSQL (TypeORM) for User data.
    -   **Caching**: Redis for temporary OTP storage.
    -   **Logic**: Handles Registration, Login, and OTP validation.
    -   Calls the **Email Service** via gRPC.

3.  **Email Service** (`apps/email-service`):
    -   **Transport**: gRPC (Port `50052`).
    -   **Logic**: Handles sending emails (currently logs to console).

## Tech Stack

-   **Framework**: NestJS
-   **Communication**: gRPC (Protobuf), HTTP
-   **Database**: PostgreSQL (TypeORM)
-   **Cache**: Redis
-   **Documentation**: Swagger (OpenAPI)

## Prerequisites

-   Node.js (v16+)
-   Docker & Docker Compose (for DB and Redis)

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Configuration**:
    Create a `.env` file in the root directory (already configured for Docker):
    ```env
    DB_HOST=localhost
    DB_PORT=5432
    DB_USER=postgres
    DB_PASS=postgres
    DB_NAME=auth_db
    REDIS_HOST=localhost
    REDIS_PORT=6379
    ```

3.  **Start Infrastructure (Postgres & Redis)**:
    ```bash
    docker-compose up -d
    ```

## Running the App

You can run all services with a single command:

```bash
npm run start:all
```

Alternatively, run them individually in separate terminals:

```bash
# Terminal 1: API Gateway (Port 3000)
npm run start:dev api-gateway

# Terminal 2: Auth Service (gRPC :50051)
npm run start:dev auth-service

# Terminal 3: Email Service (gRPC :50052)
npm run start:dev email-service
```

## API Documentation

**Interactive Documentation (Swagger UI)** is available at: `http://localhost:3000/api`

### Registration Flow

1.  **Register User**
    -   **Endpoint**: `POST /auth/register`
    -   **Body**: `{"name": "Jane Doe", "email": "jane@example.com"}`
    -   **Action**: Generates an OTP, stores it in Redis (5 min TTL), and triggers email.

2.  **Verify Registration**
    -   **Endpoint**: `POST /auth/verify`
    -   **Body**: `{"email": "jane@example.com", "otp": "123456"}`
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "User registered successfully",
          "accessToken": "eyJhbGci...",
          "user": {
            "id": 1,
            "email": "jane@example.com",
            "name": "Jane Doe"
          }
        }
        ```

### Login Flow

1.  **Login**
    -   **Endpoint**: `POST /auth/login`
    -   **Body**: `{"email": "jane@example.com"}`
    -   **Action**: Checks if user exists. If yes, generates a login OTP.

2.  **Verify Login**
    -   **Endpoint**: `POST /auth/login-verify`
    -   **Body**: `{"email": "jane@example.com", "otp": "654321"}`
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "Login successful",
          "accessToken": "eyJhbGci...",
          "user": {
            "id": 1,
            "email": "jane@example.com",
            "name": "Jane Doe"
          }
        }
        ```

## Project Structure

-   `apps/`
    -   `api-gateway`: HTTP entry point + Swagger.
    -   `auth-service`: Core logic, DB, Redis.
    -   `email-service`: Email handling.
-   `libs/common/src/proto`: Shared Protobuf definitions (`auth.proto`, `email.proto`).
