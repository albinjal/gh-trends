# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub Trends Discovery System - A modular system for discovering and tracking trending GitHub repositories with automated data collection and lifecycle management.

**Key Components:**
- **Discovery Module**: Scrapes GitHub trending/explore pages, creates repo stubs (API-free)
- **Snapshot Module**: Fetches complete repo data via GraphQL batching, updates stubs, creates time-series snapshots
- **Shared GraphQL Utility**: Reusable batched GitHub API fetching (up to 100 repos per call)
- **Database**: Time-series storage with comprehensive metrics and intelligent priority system

**New Simplified Workflow:**
1. **Discovery** (daily): Scrapes web pages → inserts minimal repo stubs (just `full_name` + context)
2. **Snapshots** (hourly): Processes prioritized repos → fetches complete data for stubs → upserts to `repos` → creates snapshots
3. **Ongoing**: Regular updates based on popularity-driven priority system

## Development Commands

### Edge Function Deployment
```bash
supabase functions deploy github-discovery --project-ref ktpdhiudpwckpyqmeitc
supabase functions deploy snapshot-collector --project-ref ktpdhiudpwckpyqmeitc
```

### API Usage Coordination & Scheduling

**Optimized API Efficiency:**
- **Discovery Function**: **NO API CALLS** - pure web scraping + database stubs
- **Snapshot Collector**: GraphQL batching (up to 100 repos per API call) with smart priority system
- **Shared Utility**: `fetchReposBatched()` with dynamic field selection and rate limiting

**Recommended Schedule:**
- **Discovery**: Once daily (finds new trending repos, creates stubs)
- **Snapshots**: Every hour (processes stubs + existing repos by priority)

**Priority-Based Snapshot Updates:**
- **Urgent (1100)**: New stubs (no `github_id` yet) - immediate API fetch
- **Urgent (1000)**: New repos (discovered <48h ago)
- **High (800-700)**: Popular repos (1000+ stars) - daily updates
- **Medium (500-300)**: Medium repos (100+ stars) - every 2-3 days
- **Low (100)**: Small repos (<10 stars) - weekly updates

**Estimated API Usage (with GraphQL batching):**
- **Discovery**: 0 calls/day (no API usage)
- **Snapshots**: ~5-50 calls/hour (100 repos per call via batching)
- **Total**: Dramatically reduced API usage, well under 5,000/hour limit

### Automated Scheduling Setup

**Using Supabase Cron (pg_cron):**
```sql
-- Daily discovery at 2 AM UTC (API-free scraping)
SELECT cron.schedule('github-discovery', '0 2 * * *', 'SELECT invoke_edge_function(''github-discovery'')');

-- Hourly snapshots with GraphQL batching (every hour at minute 15)
SELECT cron.schedule('snapshot-collector', '15 * * * *', 'SELECT invoke_edge_function(''snapshot-collector'')');
```

**Alternative: External Cron (GitHub Actions, etc.):**
```bash
# Daily discovery (no API calls)
curl -X POST "https://ktpdhiudpwckpyqmeitc.supabase.co/functions/v1/github-discovery" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# Hourly snapshots with batching
curl -X POST "https://ktpdhiudpwckpyqmeitc.supabase.co/functions/v1/snapshot-collector" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

## Architecture Notes

**Simplified Two-Phase Design:**
- **Phase 1**: Discovery scrapes trending pages and creates minimal repo stubs (just `full_name` + discovery context)
- **Phase 2**: Snapshot collector processes priority queue, fetches complete GitHub data via GraphQL batching, and creates time-series snapshots

**Key Benefits:**
- **API Efficiency**: GraphQL batching reduces API calls by ~100x (100 repos per call vs 1 per call)
- **No Discovery Delays**: Web scraping runs without API rate limits
- **Smart Prioritization**: New stubs get highest priority for immediate processing
- **Unified Data Fetching**: All GitHub API interactions centralized in one function

**Database Schema:**
- **repos table**: Stores complete repo metadata (nullable fields for stubs)
- **snapshots table**: Time-series data for trend analysis
- **repos_needing_snapshots view**: Priority queue with special handling for stubs
- **Indexes**: Optimized for stub lookups and priority queries

**Rate Limiting Strategy:**
- GitHub GraphQL API: 5,000 points/hour (much more efficient than REST)
- Batched queries: ~100 repos per API call vs 1 repo per REST call
- Conservative buffer: Leaves 100 calls for other operations
- Built-in delays: 1.1 seconds between batches for stability

**Data Model:**
- Primary key: GitHub repository ID (immutable, set by snapshot collector)
- Stub entries: Initially just `full_name` + `discovery_context`
- Complete data: Populated by snapshot collector via GraphQL
- Smart upserts: Detects stubs and fills in missing data

## Configuration

- Supabase MCP server configured in `.mcp.json` (read-write mode)
- Project ref: `ktpdhiudpwckpyqmeitc`
- Environment variables needed:
  - Discovery: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - Snapshots: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`

## File Structure

```
supabase/functions/
├── github-discovery/index.ts     # API-free discovery (scraping only)
├── snapshot-collector/index.ts   # GraphQL batching + snapshot creation
└── utils/github-graphql.ts       # Shared GraphQL utility
```

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
