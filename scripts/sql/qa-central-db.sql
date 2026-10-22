-- Shared E2E database for Tech Lead Cockpit and QA Cockpit (test cases, runs, plans, environments).
--
-- Run ONCE, by an admin, on the dev PostgreSQL server. It only creates an empty database owned by
-- an existing login; it touches no other database. The apps create and upgrade their own tables
-- on first use (connector/qa/pg-store.ts → MIGRATIONS, recorded in table schema_version):
--   schema_version, qa_projects, qa_suites, qa_plans, qa_runs, qa_environments
-- No secrets are stored there: tokens and passwords stay in each user's macOS Keychain.
--
-- Usage (app_user = the existing login both apps will use; enter it in Koneksi → Penyimpanan E2E):
--   psql -h <host> -U <admin> -d postgres -v app_user=<login> -f scripts/sql/qa-central-db.sql

\set ON_ERROR_STOP on

CREATE DATABASE tlc_qa OWNER :"app_user" ENCODING 'UTF8' TEMPLATE template0;

-- Only the app login may connect (PostgreSQL grants CONNECT to everyone by default).
REVOKE ALL ON DATABASE tlc_qa FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE tlc_qa TO :"app_user";
