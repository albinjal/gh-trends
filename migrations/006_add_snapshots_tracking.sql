-- Migration: Add Snapshots for Time-Series Tracking
-- Created: 2025-07-14
-- Purpose: Add snapshots table for tracking star/fork growth over time

-- Create snapshots table for time-series data
CREATE TABLE snapshots (
    id BIGSERIAL PRIMARY KEY,
    github_id BIGINT NOT NULL REFERENCES repos(github_id) ON DELETE CASCADE,
    
    -- GitHub stats at point in time
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    watchers INTEGER NOT NULL DEFAULT 0,
    open_issues INTEGER NOT NULL DEFAULT 0,
    subscribers INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0, -- repo size in KB
    
    -- Snapshot metadata
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient time-series queries
CREATE INDEX idx_snapshots_github_id_time ON snapshots(github_id, recorded_at DESC);
CREATE INDEX idx_snapshots_recorded_at ON snapshots(recorded_at DESC);
CREATE INDEX idx_snapshots_stars ON snapshots(stars DESC);

-- Enable RLS
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read access
CREATE POLICY "Allow anonymous read access" ON snapshots
    FOR SELECT 
    TO anon, authenticated
    USING (true);

-- Allow authenticated insert/update
CREATE POLICY "Allow authenticated insert" ON snapshots
    FOR INSERT 
    TO authenticated
    WITH CHECK (true);

-- Create function to get latest snapshot for a repo
CREATE OR REPLACE FUNCTION get_latest_snapshot(repo_github_id BIGINT)
RETURNS TABLE (
    stars INTEGER,
    forks INTEGER,
    watchers INTEGER,
    open_issues INTEGER,
    subscribers INTEGER,
    size INTEGER,
    recorded_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.stars,
        s.forks,
        s.watchers,
        s.open_issues,
        s.subscribers,
        s.size,
        s.recorded_at
    FROM snapshots s
    WHERE s.github_id = repo_github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- Create function to calculate growth between two time points
CREATE OR REPLACE FUNCTION calculate_growth(
    repo_github_id BIGINT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    stars_growth INTEGER,
    forks_growth INTEGER,
    watchers_growth INTEGER,
    start_stars INTEGER,
    end_stars INTEGER,
    start_forks INTEGER,
    end_forks INTEGER,
    days_elapsed NUMERIC
) AS $$
DECLARE
    start_snapshot RECORD;
    end_snapshot RECORD;
BEGIN
    -- Get snapshot closest to start time
    SELECT * INTO start_snapshot
    FROM snapshots
    WHERE github_id = repo_github_id
      AND recorded_at <= start_time
    ORDER BY recorded_at DESC
    LIMIT 1;
    
    -- Get snapshot closest to end time
    SELECT * INTO end_snapshot
    FROM snapshots
    WHERE github_id = repo_github_id
      AND recorded_at <= end_time
    ORDER BY recorded_at DESC
    LIMIT 1;
    
    -- Return growth calculations
    IF start_snapshot IS NOT NULL AND end_snapshot IS NOT NULL THEN
        RETURN QUERY SELECT
            end_snapshot.stars - start_snapshot.stars,
            end_snapshot.forks - start_snapshot.forks,
            end_snapshot.watchers - start_snapshot.watchers,
            start_snapshot.stars,
            end_snapshot.stars,
            start_snapshot.forks,
            end_snapshot.forks,
            EXTRACT(EPOCH FROM (end_snapshot.recorded_at - start_snapshot.recorded_at)) / 86400.0;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Create view for recent growth (last 7 days)
CREATE VIEW recent_growth AS
SELECT 
    r.github_id,
    r.full_name,
    r.owner,
    r.name,
    r.language,
    r.discovered_at,
    
    -- Latest stats
    latest.stars as current_stars,
    latest.forks as current_forks,
    latest.watchers as current_watchers,
    latest.recorded_at as last_updated,
    
    -- Growth calculations
    growth.stars_growth as stars_7d,
    growth.forks_growth as forks_7d,
    growth.watchers_growth as watchers_7d,
    growth.start_stars as stars_7d_ago,
    growth.days_elapsed,
    
    -- Growth rates (per day)
    CASE 
        WHEN growth.days_elapsed > 0 
        THEN ROUND(growth.stars_growth / growth.days_elapsed, 2)
        ELSE 0 
    END as stars_per_day,
    
    CASE 
        WHEN growth.days_elapsed > 0 
        THEN ROUND(growth.forks_growth / growth.days_elapsed, 2)
        ELSE 0 
    END as forks_per_day

FROM repos r
-- Get latest snapshot for each repo
LEFT JOIN LATERAL (
    SELECT stars, forks, watchers, recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true
-- Calculate 7-day growth
LEFT JOIN LATERAL (
    SELECT *
    FROM calculate_growth(r.github_id, NOW() - INTERVAL '7 days')
) growth ON true

WHERE latest.recorded_at IS NOT NULL
ORDER BY growth.stars_growth DESC NULLS LAST;

-- Create view for repositories that need snapshot updates
CREATE VIEW repos_needing_snapshots AS
SELECT 
    r.github_id,
    r.full_name,
    r.discovered_at,
    latest_snapshot.recorded_at as last_snapshot_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0 as hours_since_last_snapshot,
    
    -- Priority scoring (higher = more urgent)
    CASE
        -- New repos (discovered in last 24h) - high priority
        WHEN r.discovered_at >= NOW() - INTERVAL '24 hours' THEN 100
        -- No snapshots yet - high priority  
        WHEN latest_snapshot.recorded_at IS NULL THEN 90
        -- Haven't been snapshotted in 24+ hours - medium priority
        WHEN latest_snapshot.recorded_at <= NOW() - INTERVAL '24 hours' THEN 50
        -- Haven't been snapshotted in 12+ hours - low priority
        WHEN latest_snapshot.recorded_at <= NOW() - INTERVAL '12 hours' THEN 25
        -- Recent snapshot - very low priority
        ELSE 1
    END as priority_score
    
FROM repos r
LEFT JOIN LATERAL (
    SELECT recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest_snapshot ON true

-- Only include repos that actually need updates
WHERE 
    latest_snapshot.recorded_at IS NULL OR 
    latest_snapshot.recorded_at <= NOW() - INTERVAL '6 hours'

ORDER BY priority_score DESC, hours_since_last_snapshot DESC;

-- Add comments
COMMENT ON TABLE snapshots IS 'Time-series snapshots of GitHub repository statistics';
COMMENT ON FUNCTION get_latest_snapshot(BIGINT) IS 'Get the most recent snapshot for a repository';
COMMENT ON FUNCTION calculate_growth(BIGINT, TIMESTAMPTZ, TIMESTAMPTZ) IS 'Calculate growth metrics between two time points';
COMMENT ON VIEW recent_growth IS 'Repository growth statistics over the last 7 days';
COMMENT ON VIEW repos_needing_snapshots IS 'Repositories that need snapshot updates, prioritized by urgency';