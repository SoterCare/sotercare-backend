#!/bin/bash

# 1. Start Redis
echo "Starting Redis..."
redis-server --daemonize yes
sleep 2

# 2. Start Postgres
echo "Starting Postgres..."
# Fix permissions just in case
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
    su - postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l /var/lib/postgresql/postgres.log start"
    sleep 5
    
    echo "Creating 'postgres' user with password and 'auth_db'..."
    # Set password for default 'postgres' user
    su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'postgres';\""
    # Create the application database
    su - postgres -c "createdb auth_db"
else
    echo "Postgres data found. Starting Server..."
    su - postgres -c "$PG_BIN/pg_ctl -D $PG_DATA -l /var/lib/postgresql/postgres.log start"
    sleep 5
fi

# 3. Check Services
if pgrep "redis-server" > /dev/null; then echo "Redis: Running"; else echo "Redis: Failed"; fi
if pgrep "postgres" > /dev/null; then echo "Postgres: Running"; else echo "Postgres: Failed"; fi

# 4. Start Microservices
echo "Starting Application..."
npm run start:prod:all
