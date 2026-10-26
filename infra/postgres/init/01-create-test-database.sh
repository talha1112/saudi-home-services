#!/bin/sh
# Runs once, when the postgres data volume is first created. Creates a separate
# database for migration and integration tests so they never touch development data.
set -eu

TEST_DB="${POSTGRES_TEST_DB:-home_services_test}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
  SELECT 'CREATE DATABASE "${TEST_DB}"'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${TEST_DB}')\gexec
EOSQL
