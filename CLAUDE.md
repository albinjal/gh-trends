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
supabase functions deploy github-discovery --project-ref ktpdhiudpwckpyqmeitc
supabase functions deploy snapshot-collector --project-ref ktpdhiudpwckpyqmeitc
```

### API Usage Coordination & Scheduling

**Optimized API Efficiency:**
- **Discovery Function**: Only calls API for NEW repos (skips existing ones)
- **Snapshot Collector**: Smart priority system based on repo popularity
- **No Hard Limits**: Uses full rate limit intelligently with buffer

**Recommended Schedule:**
- **Discovery**: Once daily (finds new trending repos)
- **Snapshots**: Every hour (processes repos by priority)

**Priority-Based Snapshot Updates:**
- **Immediate**: New repos (discovered <48h ago)
- **Daily**: Popular repos (1000+ stars) 
- **Every 2 days**: Medium repos (100+ stars)
- **Every 3 days**: Small repos (10+ stars)
- **Weekly**: Very small repos (<10 stars)

**Estimated API Usage:**
- **Discovery**: ~50-200 calls/day (only new repos)
- **Snapshots**: ~200-500 calls/hour (priority-based)
- **Total**: Well under 5,000/hour limit

### Automated Scheduling Setup

**Using Supabase Cron (pg_cron):**
```sql
-- Daily discovery at 2 AM UTC
SELECT cron.schedule('github-discovery', '0 2 * * *', 'SELECT invoke_edge_function(''github-discovery'')');

-- Hourly snapshots (every hour at minute 15)
SELECT cron.schedule('snapshot-collector', '15 * * * *', 'SELECT invoke_edge_function(''snapshot-collector'')');
```

**Alternative: External Cron (GitHub Actions, etc.):**
```bash
# Daily discovery
curl -X POST "https://ktpdhiudpwckpyqmeitc.supabase.co/functions/v1/github-discovery" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# Hourly snapshots  
curl -X POST "https://ktpdhiudpwckpyqmeitc.supabase.co/functions/v1/snapshot-collector" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

## Architecture Notes

**Simplified Design:**
- Single discovery function that scrapes pages and fetches GitHub API data
- GitHub ID-based storage for durable repository identification
- Clean separation of discovery and querying

**Rate Limiting Strategy:**
- GitHub API: 5,000 req/hour with PAT
- Conservative limits with ~100 API calls per discovery run
- Efficient deduplication to avoid redundant API calls

**Data Model:**
- Primary key: GitHub repository ID (immutable)
- Rich metadata from GitHub API for powerful querying
- Optional discovery context for analytics

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
  - Prefer testing functions locally for cost savings
