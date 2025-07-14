-- Migration: Add Indexes
-- Created: 2025-07-13
-- Purpose: Add performance indexes for common queries

-- Indexes for repos table
CREATE INDEX idx_repos_full_name ON repos (full_name);
CREATE INDEX idx_repos_owner ON repos (owner);
CREATE INDEX idx_repos_language ON repos (language);
CREATE INDEX idx_repos_stars ON repos (stars DESC);
CREATE INDEX idx_repos_discovered_at ON repos (discovered_at DESC);
CREATE INDEX idx_repos_topics ON repos USING GIN (topics);

-- Indexes for snapshots table
CREATE INDEX idx_snapshots_repo_id_time ON snapshots (repo_id, recorded_at DESC);
CREATE INDEX idx_snapshots_recorded_at ON snapshots (recorded_at DESC);
CREATE INDEX idx_snapshots_stars ON snapshots (stars DESC);

-- Add comments
COMMENT ON INDEX idx_repos_full_name IS 'Fast lookup by repository full name';
COMMENT ON INDEX idx_repos_owner IS 'Fast lookup by repository owner';
COMMENT ON INDEX idx_repos_language IS 'Fast filtering by programming language';
COMMENT ON INDEX idx_repos_stars IS 'Fast sorting by star count (descending)';
COMMENT ON INDEX idx_repos_discovered_at IS 'Fast sorting by discovery date';
COMMENT ON INDEX idx_repos_topics IS 'Fast search within topics array';
COMMENT ON INDEX idx_snapshots_repo_id_time IS 'Fast lookup of snapshots for a repo ordered by time';
COMMENT ON INDEX idx_snapshots_recorded_at IS 'Fast sorting by snapshot date';
COMMENT ON INDEX idx_snapshots_stars IS 'Fast sorting by star count in snapshots';
