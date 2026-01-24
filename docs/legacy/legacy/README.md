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

-   Node.js (v18+)
-   Docker & Docker Compose
-   Python 3.10+ (for AI Summary Service)

---

## Running with Docker (Recommended)

This is the easiest way to run the entire stack. All services, databases, and dependencies are containerized.

### Quick Start

```bash
# Build and start all containers
docker-compose up --build -d

# View logs
docker-compose logs -f
```

### Services Available

| Service       | URL/Port                     | Description                |
|---------------|------------------------------|----------------------------|
| API Gateway   | http://localhost:3000        | Main HTTP API              |
| Swagger UI    | http://localhost:3000/api    | API Documentation          |
| Auth Service  | localhost:50051 (gRPC)       | Authentication microservice|
| Email Service | localhost:50052 (gRPC)       | Email handling             |
| AI Summary    | localhost:50053 (gRPC)       | AI Summary service         |
| PostgreSQL    | localhost:5432               | Database                   |
| Redis         | localhost:6379               | Cache                      |

### Stopping Docker

```bash
# Stop containers (keeps data)
docker-compose down

# Stop containers and remove volumes (clears database)
docker-compose down -v
```

### Troubleshooting Docker

**Port already in use error:**
```bash
# Find what's using the port (e.g., 6379)
netstat -ano | findstr :6379

# Stop all containers and try again
docker-compose down
docker-compose up -d
```

**Database password authentication failed:**
```bash
# This usually means old data persists with a different password
# Reset volumes to fix:
docker-compose down -v
docker-compose up -d
```

---

## Running Locally (Development)

Use this method if you want to run services directly on your machine for development.

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory:

```env
# Database (Docker Postgres)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=auth_db

# Redis (Docker Redis)
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 3. Start Infrastructure Only

Start only Postgres and Redis containers:

```bash
docker-compose up -d postgres redis
```

### 4. Setup Python Environment (for AI Service)

**Windows (PowerShell):**
```powershell
cd apps\ai-summary-service
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
cd ..\..
```

**Linux/Mac:**
```bash
cd apps/ai-summary-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd ../..
```

### 5. Run All Services

```bash
npm run start:all
```

Or run services individually in separate terminals:

```bash
# Terminal 1: API Gateway (Port 3000)
npm run start:dev api-gateway

# Terminal 2: Auth Service (gRPC :50051)
npm run start:dev auth-service

# Terminal 3: Email Service (gRPC :50052)
npm run start:dev email-service

# Terminal 4: AI Summary Service (gRPC :50053)
npm run start:ai-service
```

### Troubleshooting Local Development

**"password authentication failed for user postgres":**
- Ensure Docker Postgres is running: `docker ps`
- Check your `.env` file has `DB_PASS=postgres`
- If the Docker volume has old data, reset it:
  ```bash
  docker-compose down -v
  docker-compose up -d postgres redis
  ```

**"system cannot find the path specified" (AI Service):**
- The Python virtual environment is missing. Create it:
  ```bash
  cd apps/ai-summary-service
  python -m venv venv
  venv\Scripts\pip install -r requirements.txt
  ```

---

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

### User Profile

1.  **Get Profile**
    -   **Endpoint**: `GET /user/profile?id=1`
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "Profile retrieved successfully",
          "user": {
            "id": 1,
            "email": "jane@example.com",
            "name": "Jane Doe",
            "mobileNumber": "+1234567890"
          }
        }
        ```

2.  **Update Profile** (name, mobile only - email requires separate verification)
    -   **Endpoint**: `POST /user/update`
    -   **Body**: 
        ```json
        {
          "id": 1,
          "name": "Jane Smith",
          "email": "jane@example.com",
          "mobileNumber": "+0987654321"
        }
        ```
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "Profile updated successfully"
        }
        ```

### Email Update Flow

When updating email, a two-step verification process is required:

1.  **Initiate Email Update** (Sends OTP to new email)
    -   **Endpoint**: `POST /user/email/initiate`
    -   **Body**: 
        ```json
        {
          "userId": 1,
          "newEmail": "newemail@example.com"
        }
        ```
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "Verification OTP sent to new email"
        }
        ```

2.  **Verify Email Update** (Confirms OTP and updates email)
    -   **Endpoint**: `POST /user/email/verify`
    -   **Body**: 
        ```json
        {
          "userId": 1,
          "newEmail": "newemail@example.com",
          "otp": "123456"
        }
        ```
    -   **Response** (Success):
        ```json
        {
          "success": true,
          "message": "Email updated successfully"
        }
        ```

## Project Structure

-   `apps/`
    -   `api-gateway`: HTTP entry point + Swagger.
    -   `auth-service`: Core logic, DB, Redis.
    -   `email-service`: Email handling.
    -   `ai-summary-service`: Python-based AI summary microservice.
-   `libs/common/src/proto`: Shared Protobuf definitions (`auth.proto`, `email.proto`, `summary.proto`).

