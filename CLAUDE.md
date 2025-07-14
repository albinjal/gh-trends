# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub Trends Discovery System - A modular system for discovering and tracking trending GitHub repositories with automated data collection and lifecycle management.

**Key Components:**
- Discovery Module: Scrapes GitHub trending pages
- Snapshot Module: Collects detailed repo stats via GitHub API
- Lifecycle Module: Manages which repos to actively track
- Database: Time-series storage with comprehensive metrics

## Development Commands



### Edge Function Deployment
```bash
supabase functions deploy trending-scraper --project-ref ktpdhiudpwckpyqmeitc
supabase functions deploy snapshot-collector --project-ref ktpdhiudpwckpyqmeitc
supabase functions deploy repo-lifecycle --project-ref ktpdhiudpwckpyqmeitc
```

## Architecture Notes

**Modular Design:**
- Separate functions for discovery, data collection, and lifecycle management
- Independent scheduling and rate limiting per module
- Database-first approach with comprehensive data capture

**Rate Limiting Strategy:**
- GitHub API: 5,000 req/hour with PAT
- Intelligent batching and throttling
- Circuit breaker patterns for API protection

**Lifecycle Management:**
- Auto-deactivate repos after 7+ days of low growth
- Reactivate if repos trend again within 3 days
- Prevents unbounded tracking growth

## Configuration

- Supabase MCP server configured in `.mcp.json` (read-write mode)
- Project ref: `ktpdhiudpwckpyqmeitc`
- Environment variables needed: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`

## Coding Guidelines

This project follows specific coding guidelines located in `.cursor/rules/`. When working on related tasks, refer to and adhere to these guidelines:

- [`create-db-functions.mdc`](.cursor/rules/create-db-functions.mdc): Guidelines for writing Supabase database functions
  - Default to `SECURITY INVOKER` and set `search_path = ''`
  - Use fully qualified names for all database objects
  - Prefer immutable/stable functions for optimization
- [`create-migration.mdc`](.cursor/rules/create-migration.mdc): Guidelines for writing Postgres migrations
  - Use UTC timestamp naming: `YYYYMMDDHHmmss_description.sql`
  - Enable RLS on all new tables, write granular policies
  - Include thorough comments and metadata headers
- [`create-rls-policies.mdc`](.cursor/rules/create-rls-policies.mdc): Guidelines for writing Postgres Row Level Security policies
  - Separate policies for each operation (select, insert, update, delete)
  - Use `auth.uid()` and specify roles with `TO` clause
  - Optimize with indexes and minimize joins
- [`postgres-sql-style-guide.mdc`](.cursor/rules/postgres-sql-style-guide.mdc): Guidelines for writing Postgres SQL
  - Use lowercase SQL, snake_case naming, plurals for tables
  - Add meaningful comments and prefer CTEs for complex queries
  - Always specify schema in queries
- [`writing-supabase-edge-functions.mdc`](.cursor/rules/writing-supabase-edge-functions.mdc): Coding rules for Supabase Edge Functions
  - Use Web APIs and Deno core APIs over external dependencies
      - Use `npm:` or `jsr:` specifiers with versions for imports
  - Use `Deno.serve()` instead of deprecated serve imports
