# NestJS Auth Microservice (gRPC + HTTP)

This is a **NestJS Monorepo** project implementing an **Authentication Flow** using Email-based TOTP (Time-based One-Time Password) for Registration and Login. It uses **gRPC** for efficient inter-service communication and exposes an **HTTP API Gateway** for client interaction.

## Architecture

The system consists of three microservices:

1.  **API Gateway** (`apps/api-gateway`):
    -   Exposes HTTP REST endpoints.
    -   Acts as a proxy, converting HTTP requests to gRPC calls.
    -   Forwards requests to the **Auth Service**.

2.  **Auth Service** (`apps/auth-service`):
    -   **Transport**: gRPC.
    -   **Persistence**: PostgreSQL (TypeORM) for User data.
    -   **Caching**: Redis for temporary OTP storage.
    -   **Logic**: Handles Registration, Login, and OTP validation.
    -   Calls the **Email Service** via gRPC to send emails.

3.  **Email Service** (`apps/email-service`):
    -   **Transport**: gRPC.
    -   **Logic**: Handles sending emails (currently logs to console).

## Tech Stack

-   **Framework**: NestJS
-   **Communication**: gRPC (Protobuf), HTTP
-   **Database**: PostgreSQL (TypeORM)
-   **Cache**: Redis
-   **Language**: TypeScript

## Prerequisites

-   Node.js (v16+)
-   PostgreSQL
-   Redis

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Configuration**:
    Create a `.env` file in the root directory with the following variables:
    ```env
    DB_HOST=localhost
    DB_PORT=5432
    DB_USER=postgres
    DB_PASS=postgres
    DB_NAME=auth_db
    REDIS_HOST=localhost
    REDIS_PORT=6379
    ```

3.  **Database Setup**:
    -   Ensure PostgreSQL and Redis are running.
    -   Create the database named `auth_db` (or whatever you set in `.env`).

## Running the App

You can run all services with a single command:

```bash
npm run start:all
```

Alternatively, run them individually in separate terminals:

```bash
# Terminal 1: API Gateway (Port 3000)
npm run start:dev api-gateway

# Terminal 2: Auth Service (gRPC)
npm run start:dev auth-service

# Terminal 3: Email Service (gRPC)
npm run start:dev email-service
```

## API Documentation

APIs are available at `http://localhost:3000`.

### Registration Flow

1.  **Register User**
    -   **Endpoint**: `POST /auth/register`
    -   **Body**:
        ```json
        {
          "name": "Jane Doe",
          "email": "jane@example.com"
        }
        ```
    -   **Action**: Generates an OTP, stores it in Redis (5 min TTL), and triggers the Email Service to send the OTP.

2.  **Verify Registration**
    -   **Endpoint**: `POST /auth/verify`
    -   **Body**:
        ```json
        {
          "email": "jane@example.com",
          "otp": "123456"
        }
        ```
    -   **Action**: Verifies the OTP. If valid, creates the User in PostgreSQL.

### Login Flow

1.  **Login**
    -   **Endpoint**: `POST /auth/login`
    -   **Body**:
        ```json
        {
          "email": "jane@example.com"
        }
        ```
    -   **Action**: Checks if user exists. If yes, generates a login OTP, stores it in Redis, and sends email.

2.  **Verify Login**
    -   **Endpoint**: `POST /auth/login-verify`
    -   **Body**:
        ```json
        {
          "email": "jane@example.com",
          "otp": "654321"
        }
        ```
    -   **Action**: Verifies the OTP. Returns success status (and mock token).

## Project Structure

-   `apps/`
    -   `api-gateway`: HTTP entry point.
    -   `auth-service`: Core logic, DB, Redis.
    -   `email-service`: Email handling.
-   `libs/common/src/proto`: Shared Protobuf definitions (`auth.proto`, `email.proto`).
