-- Migration: Repo Growth Function
-- Created: 2025-07-13
-- Purpose: Add functions for calculating repository growth metrics

-- Function to calculate growth between two time periods for a specific repo
CREATE OR REPLACE FUNCTION calculate_growth(
    repo_github_id BIGINT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ
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
$$ LANGUAGE plpgsql;

-- Function to get latest snapshot for a repository
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
$$ LANGUAGE plpgsql;

-- Function to get repository growth history over time
CREATE OR REPLACE FUNCTION get_repo_growth_history(
    repo_github_id BIGINT,
    days_back INTEGER DEFAULT 30
)
RETURNS TABLE (
    snapshot_date DATE,
    stars INTEGER,
    forks INTEGER,
    watchers INTEGER,
    stars_change INTEGER,
    forks_change INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH daily_snapshots AS (
        -- Get one snapshot per day (latest of each day)
        SELECT DISTINCT ON (DATE(recorded_at))
            DATE(recorded_at) as snapshot_date,
            s.stars,
            s.forks,
            s.watchers,
            s.recorded_at
        FROM snapshots s
        WHERE s.github_id = repo_github_id
          AND s.recorded_at >= NOW() - (days_back || ' days')::INTERVAL
        ORDER BY DATE(recorded_at), s.recorded_at DESC
    ),
    with_changes AS (
        SELECT
            snapshot_date,
            stars,
            forks,
            watchers,
            stars - LAG(stars, 1, stars) OVER (ORDER BY snapshot_date) as stars_change,
            forks - LAG(forks, 1, forks) OVER (ORDER BY snapshot_date) as forks_change
        FROM daily_snapshots
    )
    SELECT
        snapshot_date::DATE,
        stars,
        forks,
        watchers,
        stars_change,
        forks_change
    FROM with_changes
    ORDER BY snapshot_date;
END;
$$ LANGUAGE plpgsql;

-- Function to get trending summary statistics
CREATE OR REPLACE FUNCTION get_trending_summary()
RETURNS TABLE (
    total_repos INTEGER,
    total_active_repos INTEGER,
    repos_with_recent_snapshots INTEGER,
    total_stars_tracked INTEGER,
    total_forks_tracked INTEGER,
    avg_stars_per_repo NUMERIC,
    top_language TEXT,
    trending_repos_24h INTEGER,
    new_discoveries_24h INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        (SELECT COUNT(*)::INTEGER FROM repos) as total_repos,

        (SELECT COUNT(*)::INTEGER
         FROM repos
         WHERE NOT is_archived AND NOT is_disabled) as total_active_repos,

        (SELECT COUNT(*)::INTEGER
         FROM repos r
         WHERE EXISTS (
             SELECT 1 FROM snapshots s
             WHERE s.github_id = r.github_id
               AND s.recorded_at >= NOW() - INTERVAL '48 hours'
         )) as repos_with_recent_snapshots,

        (SELECT COALESCE(SUM(stars), 0) FROM repos) as total_stars_tracked,
        (SELECT COALESCE(SUM(forks), 0) FROM repos) as total_forks_tracked,

        (SELECT ROUND(AVG(stars), 2) FROM repos WHERE stars > 0) as avg_stars_per_repo,

        (SELECT language
         FROM repos
         WHERE language IS NOT NULL
         GROUP BY language
         ORDER BY COUNT(*) DESC
         LIMIT 1) as top_language,

        (SELECT COUNT(*)::INTEGER
         FROM trending_repositories
         WHERE stars_24h > 0) as trending_repos_24h,

        (SELECT COUNT(*)::INTEGER
         FROM repos
         WHERE discovered_at >= NOW() - INTERVAL '24 hours') as new_discoveries_24h;
END;
$$ LANGUAGE plpgsql;

-- Add comments
COMMENT ON FUNCTION calculate_growth(BIGINT, TIMESTAMPTZ, TIMESTAMPTZ) IS 'Calculate repository growth metrics between two time periods';
COMMENT ON FUNCTION get_latest_snapshot(BIGINT) IS 'Get the most recent snapshot for a repository';
COMMENT ON FUNCTION get_repo_growth_history(BIGINT, INTEGER) IS 'Get daily growth history for a repository';
COMMENT ON FUNCTION get_trending_summary() IS 'Get summary statistics for the trending system';
