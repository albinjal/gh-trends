-- Migration: Consolidated Schema Cleanup (Fixed)
-- Created: 2025-07-14
-- Purpose: Clean up schema and add essential views and functions

-- Add calculate_repo_growth_metrics function for lifecycle management
CREATE OR REPLACE FUNCTION calculate_repo_growth_metrics(
    p_min_total_stars INTEGER DEFAULT 10,
    p_max_stale_days INTEGER DEFAULT 7
)
RETURNS TABLE (
    repo_id BIGINT,
    full_name TEXT,
    daily_star_growth INTEGER,
    daily_fork_growth INTEGER,
    total_stars INTEGER,
    total_forks INTEGER,
    days_since_last_growth INTEGER,
    is_active BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_snapshots AS (
        SELECT DISTINCT ON (s.github_id)
            s.github_id,
            s.stars,
            s.forks,
            s.recorded_at as latest_recorded_at
        FROM snapshots s
        INNER JOIN repos r ON r.github_id = s.github_id
        WHERE r.github_id IS NOT NULL
        ORDER BY s.github_id, s.recorded_at DESC
    ),
    day_old_snapshots AS (
        SELECT DISTINCT ON (s.github_id)
            s.github_id,
            s.stars as day_old_stars,
            s.forks as day_old_forks
        FROM snapshots s
        INNER JOIN repos r ON r.github_id = s.github_id
        WHERE r.github_id IS NOT NULL
        AND s.recorded_at <= NOW() - INTERVAL '24 hours'
        ORDER BY s.github_id, s.recorded_at DESC
    ),
    growth_calculations AS (
        SELECT
            r.github_id,
            r.full_name,
            TRUE as is_active, -- Simplified for now
            COALESCE(ls.stars, 0) as current_stars,
            COALESCE(ls.forks, 0) as current_forks,
            COALESCE(ls.stars - dos.day_old_stars, 0) as star_growth_24h,
            COALESCE(ls.forks - dos.day_old_forks, 0) as fork_growth_24h,
            -- Calculate days since last meaningful growth (simplified)
            CASE
                WHEN COALESCE(ls.stars - dos.day_old_stars, 0) >= 2 THEN 0
                ELSE EXTRACT(DAYS FROM (NOW() - COALESCE(ls.latest_recorded_at, NOW())))::INTEGER
            END as days_stale
        FROM repos r
        LEFT JOIN latest_snapshots ls ON ls.github_id = r.github_id
        LEFT JOIN day_old_snapshots dos ON dos.github_id = r.github_id
        WHERE r.github_id IS NOT NULL
        AND COALESCE(ls.stars, r.stars, 0) >= p_min_total_stars
    )
    SELECT
        gc.github_id,
        gc.full_name,
        gc.star_growth_24h,
        gc.fork_growth_24h,
        gc.current_stars,
        gc.current_forks,
        gc.days_stale,
        gc.is_active
    FROM growth_calculations gc
    ORDER BY gc.current_stars DESC;
END;
$$ LANGUAGE plpgsql;

-- Create essential views for the application

-- View for recent discoveries
CREATE OR REPLACE VIEW recent_discoveries AS
SELECT
    github_id,
    full_name,
    owner,
    name,
    description,
    language,
    stars,
    discovery_context,
    discovered_at
FROM repos
ORDER BY discovered_at DESC
LIMIT 100;

-- View for trending repositories (last 30 days)
CREATE OR REPLACE VIEW trending_repos AS
SELECT
    github_id,
    full_name,
    owner,
    name,
    description,
    language,
    topics,
    stars,
    forks,
    watchers,
    discovery_context,
    discovered_at,
    github_created_at,
    github_updated_at
FROM repos
WHERE discovered_at >= NOW() - INTERVAL '30 days'
ORDER BY stars DESC, discovered_at DESC;

-- View for recent growth analysis
CREATE OR REPLACE VIEW recent_growth AS
SELECT
    r.github_id,
    r.full_name,
    r.owner,
    r.name,
    r.language,
    r.discovered_at,
    latest.stars AS current_stars,
    latest.forks AS current_forks,
    latest.watchers AS current_watchers,
    latest.recorded_at AS last_updated,
    growth.stars_growth AS stars_7d,
    growth.forks_growth AS forks_7d,
    growth.watchers_growth AS watchers_7d,
    growth.start_stars AS stars_7d_ago,
    growth.days_elapsed,
    CASE
        WHEN growth.days_elapsed > 0 THEN ROUND(growth.stars_growth::NUMERIC / growth.days_elapsed, 2)
        ELSE 0
    END AS stars_per_day,
    CASE
        WHEN growth.days_elapsed > 0 THEN ROUND(growth.forks_growth::NUMERIC / growth.days_elapsed, 2)
        ELSE 0
    END AS forks_per_day
FROM repos r
LEFT JOIN LATERAL (
    SELECT s.stars, s.forks, s.watchers, s.recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
    SELECT * FROM calculate_growth(r.github_id, NOW() - INTERVAL '7 days', NOW())
) growth ON true
WHERE latest.recorded_at IS NOT NULL
ORDER BY growth.stars_growth DESC NULLS LAST;

-- Add view comments
COMMENT ON VIEW recent_discoveries IS 'Most recently discovered repositories';
COMMENT ON VIEW trending_repos IS 'Repositories discovered in the last 30 days, sorted by popularity';
COMMENT ON VIEW recent_growth IS 'Repository growth analysis over the last 7 days';

-- Add function comment
COMMENT ON FUNCTION calculate_repo_growth_metrics(INTEGER, INTEGER) IS 'Calculate growth metrics for repository lifecycle management';
