-- Migration: Add performance indexes
-- Created: 2025-07-13

-- Index for filtering repos by language and active status
CREATE INDEX idx_repos_language_active ON repos(language, is_active);

-- Index for repo lookups by full_name
CREATE INDEX idx_repos_full_name ON repos(full_name);

-- Index for snapshot queries by repo and time
CREATE INDEX idx_snapshots_repo_time ON snapshots(repo_id, recorded_at);

-- Index for trending discoveries by time and period
CREATE INDEX idx_trending_discoveries_time_period ON trending_discoveries(discovered_at, period);

-- Index for trending discoveries by repo
CREATE INDEX idx_trending_discoveries_repo ON trending_discoveries(repo_id);

-- Index for finding active repos that need snapshots
CREATE INDEX idx_repos_active_last_snapshot ON repos(is_active, last_snapshot) WHERE is_active = true;