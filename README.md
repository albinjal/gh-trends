# GitHub Trends Discovery System

A modular system for discovering and tracking trending GitHub repositories with automated data collection and lifecycle management.

## Architecture

- **Discovery Module**: Scrapes GitHub trending pages to find new repositories
- **Snapshot Module**: Collects detailed repository statistics via GitHub API
- **Lifecycle Module**: Manages which repositories to actively track based on growth metrics
- **Database**: Comprehensive data storage with time-series snapshots

## Setup

### 1. Database Setup

Remove the `--read-only` flag from `.mcp.json` and run the migrations:

```bash
# Update .mcp.json to remove --read-only flag, then apply migrations:
```

Apply the migrations in order:
1. `migrations/001_create_core_schema.sql`
2. `migrations/002_add_indexes.sql` 
3. `migrations/003_repo_growth_function.sql`

### 2. Environment Variables

Set these environment variables in your Supabase project:

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key (for database access)
- `GITHUB_TOKEN`: GitHub Personal Access Token (optional but recommended for higher rate limits)

### 3. Deploy Edge Functions

Deploy the three Edge Functions to your Supabase project:

```bash
# Deploy trending scraper
supabase functions deploy trending-scraper --project-ref your-project-ref

# Deploy snapshot collector  
supabase functions deploy snapshot-collector --project-ref your-project-ref

# Deploy repo lifecycle manager
supabase functions deploy repo-lifecycle --project-ref your-project-ref
```

## Usage

### Discovery (Daily)

Scrape trending repositories and add new ones to tracking:

```bash
# Default: scrape daily trending for all languages
curl -X POST https://your-project.supabase.co/functions/v1/trending-scraper

# Specific periods and languages
curl -X POST "https://your-project.supabase.co/functions/v1/trending-scraper?periods=daily,weekly&languages=javascript,python"
```

### Snapshot Collection (Hourly)

Collect detailed statistics for tracked repositories:

```bash
# Default batch size (50 repos)
curl -X POST https://your-project.supabase.co/functions/v1/snapshot-collector

# Custom batch size and rate limit threshold
curl -X POST "https://your-project.supabase.co/functions/v1/snapshot-collector?batch_size=100&min_rate_limit=200"
```

### Lifecycle Management (Daily)

Manage which repositories to actively track:

```bash
# Default settings
curl -X POST https://your-project.supabase.co/functions/v1/repo-lifecycle

# Custom thresholds
curl -X POST "https://your-project.supabase.co/functions/v1/repo-lifecycle?min_daily_growth=5&max_stale_days=14"
```

## Database Schema

### Tables

- **repos**: Repository metadata and tracking status
- **snapshots**: Time-series data for repository statistics
- **trending_discoveries**: Records of when repos appeared in trending

### Key Fields

**repos table:**
- `is_active`: Whether to continue collecting snapshots
- `last_snapshot`: Last time statistics were collected
- `first_seen`: When repository was first discovered

**snapshots table:**
- `stars`, `forks`, `watchers`: Key growth metrics
- `recorded_at`: Timestamp for time-series analysis

## Rate Limiting

- GitHub API: 5,000 requests/hour with Personal Access Token
- Built-in rate limit checking and throttling
- Configurable batch sizes and minimum thresholds
- Automatic circuit breaker for API protection

## Lifecycle Management

Repositories are automatically:
- **Activated** when discovered in trending
- **Deactivated** after 7+ days of low growth (< 2 stars/day)
- **Reactivated** if they appear in trending again within 3 days

This prevents unbounded growth of tracked repositories while maintaining comprehensive coverage of trending projects.

## Next Steps

- Add materialized views for computed metrics and rankings
- Build REST API endpoints for filtered leaderboards
- Create frontend interface for browsing trends
- Implement email digest and LLM integration endpoints