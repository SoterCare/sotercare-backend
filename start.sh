#!/bin/bash

# Detect externalized state (managed Postgres / Redis). When configured we do NOT
# launch the embedded servers — their data lives on the container's ephemeral
# filesystem and is wiped on every Koyeb restart/redeploy/scale-to-zero.
EXTERNAL_DB=false
if [ -n "$DATABASE_URL" ]; then
    EXTERNAL_DB=true
elif [ -n "$DB_HOST" ] && [ "$DB_HOST" != "127.0.0.1" ] && [ "$DB_HOST" != "localhost" ]; then
    EXTERNAL_DB=true
fi

EXTERNAL_REDIS=false
if [ -n "$REDIS_URL" ]; then
    EXTERNAL_REDIS=true
elif [ -n "$REDIS_HOST" ] && [ "$REDIS_HOST" != "127.0.0.1" ] && [ "$REDIS_HOST" != "localhost" ]; then
    EXTERNAL_REDIS=true
fi

# 1. Start Redis (embedded only — external Redis needs no local server)
if [ "$EXTERNAL_REDIS" = false ]; then
    echo "Starting embedded Redis..."
    redis-server --daemonize yes
    sleep 2
else
    echo "Using external Redis (REDIS_URL/REDIS_HOST) — skipping embedded Redis."
fi

# 2. Start Postgres (embedded only). With a managed DB this block is skipped so the
#    ephemeral in-container Postgres never runs and can't shadow the real data.
if [ "$EXTERNAL_DB" = false ]; then
    echo "Starting embedded Postgres..."
    # Fix permissions just in case
    mkdir -p /var/lib/postgresql
    chown -R postgres:postgres /var/lib/postgresql

    # Determine Postgres version (e.g. 13)
    PG_VER=$(ls /usr/lib/postgresql/ | head -n 1)
    PG_BIN="/usr/lib/postgresql/$PG_VER/bin"
    PG_DATA="/var/lib/postgresql/$PG_VER/main"

    # Initialize DB if data dir is empty
    if [ ! -s "$PG_DATA/PG_VERSION" ]; then
        echo "Initializing Postgres Data at $PG_DATA..."
        mkdir -p $PG_DATA
        chown postgres:postgres $PG_DATA
        su - postgres -c "$PG_BIN/initdb -D $PG_DATA"
        echo "Starting Postgres Server..."
        mkdir -p /var/log/postgresql
        chown postgres:postgres /var/log/postgresql
        touch /var/log/postgresql/postgres.log
        chown postgres:postgres /var/log/postgresql/postgres.log
        su - postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l /var/log/postgresql/postgres.log start"
        sleep 5

        echo "Creating 'postgres' user with password and 'auth_db'..."
        # Set password for default 'postgres' user
        su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'postgres';\""
        # Create the application database
        su - postgres -c "createdb auth_db"
    else
        echo "Postgres data found. Starting Server..."
        mkdir -p /var/log/postgresql
        chown postgres:postgres /var/log/postgresql
        touch /var/log/postgresql/postgres.log
        chown postgres:postgres /var/log/postgresql/postgres.log
        su - postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l /var/log/postgresql/postgres.log start"
        sleep 5
    fi

    # 3. Wait for Postgres to be ready
    echo "Waiting for Postgres to be ready..."
    until su - postgres -c "$PG_BIN/pg_isready"; do
      echo "Postgres is unavailable - sleeping"
      sleep 1
    done
    echo "Postgres is up!"
else
    echo "Using external managed Postgres (DATABASE_URL/DB_HOST) — skipping embedded Postgres. Data persists outside the container."
fi

# 4. Check Services and Start Microservices
echo "Starting Application..."
npm run start:prod:all
