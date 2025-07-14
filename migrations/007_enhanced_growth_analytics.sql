-- Migration: Enhanced Growth Analytics
-- Created: 2025-07-14
-- Purpose: Add comprehensive views and functions for trending analysis

-- Create view for top trending repositories (by velocity)
CREATE VIEW trending_repositories AS
SELECT 
    r.github_id,
    r.full_name,
    r.owner,
    r.name,
    r.description,
    r.language,
    r.topics,
    r.discovered_at,
    
    -- Latest stats
    latest.stars as current_stars,
    latest.forks as current_forks,
    latest.watchers as current_watchers,
    latest.recorded_at as last_updated,
    
    -- 24-hour growth
    growth_1d.stars_growth as stars_24h,
    growth_1d.forks_growth as forks_24h,
    CASE 
        WHEN growth_1d.days_elapsed > 0 
        THEN ROUND(growth_1d.stars_growth / growth_1d.days_elapsed, 2)
        ELSE 0 
    END as stars_per_day_24h,
    
    -- 7-day growth
    growth_7d.stars_growth as stars_7d,
    growth_7d.forks_growth as forks_7d,
    CASE 
        WHEN growth_7d.days_elapsed > 0 
        THEN ROUND(growth_7d.stars_growth / growth_7d.days_elapsed, 2)
        ELSE 0 
    END as stars_per_day_7d,
    
    -- 30-day growth
    growth_30d.stars_growth as stars_30d,
    growth_30d.forks_growth as forks_30d,
    CASE 
        WHEN growth_30d.days_elapsed > 0 
        THEN ROUND(growth_30d.stars_growth / growth_30d.days_elapsed, 2)
        ELSE 0 
    END as stars_per_day_30d,
    
    -- Trending score (weighted combination of recent growth)
    COALESCE(
        (growth_1d.stars_growth * 10) + 
        (growth_7d.stars_growth * 2) + 
        (growth_30d.stars_growth * 0.5),
        0
    ) as trending_score

FROM repos r
-- Get latest snapshot
LEFT JOIN LATERAL (
    SELECT stars, forks, watchers, recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true
-- 24-hour growth
LEFT JOIN LATERAL (
    SELECT *
    FROM calculate_growth(r.github_id, NOW() - INTERVAL '1 day')
) growth_1d ON true
-- 7-day growth
LEFT JOIN LATERAL (
    SELECT *
    FROM calculate_growth(r.github_id, NOW() - INTERVAL '7 days')
) growth_7d ON true
-- 30-day growth
LEFT JOIN LATERAL (
    SELECT *
    FROM calculate_growth(r.github_id, NOW() - INTERVAL '30 days')
) growth_30d ON true

WHERE 
    latest.recorded_at IS NOT NULL
    AND latest.recorded_at >= NOW() - INTERVAL '48 hours' -- Only include recently updated repos
    AND NOT r.is_fork -- Exclude forks
    AND NOT r.is_archived -- Exclude archived repos

ORDER BY trending_score DESC, latest.stars DESC;

-- Create view for language-specific trending
CREATE VIEW trending_by_language AS
SELECT 
    language,
    COUNT(*) as repo_count,
    AVG(trending_score) as avg_trending_score,
    MAX(trending_score) as max_trending_score,
    SUM(stars_24h) as total_stars_24h,
    SUM(stars_7d) as total_stars_7d,
    
    -- Top repos in this language
    jsonb_agg(
        jsonb_build_object(
            'github_id', github_id,
            'full_name', full_name,
            'stars', current_stars,
            'stars_24h', stars_24h,
            'trending_score', trending_score
        ) ORDER BY trending_score DESC
    ) FILTER (WHERE rn <= 5) as top_repos

FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY language ORDER BY trending_score DESC) as rn
    FROM trending_repositories
    WHERE language IS NOT NULL
) ranked

GROUP BY language
HAVING COUNT(*) >= 3 -- Only include languages with at least 3 trending repos
ORDER BY avg_trending_score DESC;

-- Create function to get repository growth history
CREATE OR REPLACE FUNCTION get_repo_growth_history(
    repo_github_id BIGINT,
    days_back INTEGER DEFAULT 30
)
RETURNS TABLE (
    date DATE,
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
$$ LANGUAGE plpgsql STABLE;

-- Create view for recent discoveries with initial performance
CREATE VIEW recent_discoveries_performance AS
SELECT 
    r.github_id,
    r.full_name,
    r.owner,
    r.name,
    r.description,
    r.language,
    r.topics,
    r.discovered_at,
    r.discovery_context,
    
    -- Current stats
    latest.stars as current_stars,
    latest.forks as current_forks,
    latest.recorded_at as last_snapshot,
    
    -- Growth since discovery
    COALESCE(latest.stars - r.stars, 0) as stars_gained_since_discovery,
    COALESCE(latest.forks - r.forks, 0) as forks_gained_since_discovery,
    
    -- Days since discovery
    EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) / 86400.0 as days_since_discovery,
    
    -- Growth rate since discovery
    CASE 
        WHEN EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) > 86400 -- More than 1 day
        THEN ROUND((COALESCE(latest.stars - r.stars, 0)) / (EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) / 86400.0), 2)
        ELSE 0 
    END as stars_per_day_since_discovery

FROM repos r
LEFT JOIN LATERAL (
    SELECT stars, forks, watchers, recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true

WHERE r.discovered_at >= NOW() - INTERVAL '7 days' -- Last 7 days discoveries
ORDER BY r.discovered_at DESC;

-- Create function to get trending summary statistics
CREATE OR REPLACE FUNCTION get_trending_summary()
RETURNS TABLE (
    total_repos INTEGER,
    total_active_repos INTEGER,
    repos_with_recent_snapshots INTEGER,
    total_stars_tracked BIGINT,
    total_forks_tracked BIGINT,
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
$$ LANGUAGE plpgsql STABLE;

-- Add comments
COMMENT ON VIEW trending_repositories IS 'Comprehensive trending analysis with multi-timeframe growth metrics';
COMMENT ON VIEW trending_by_language IS 'Trending statistics aggregated by programming language';
COMMENT ON VIEW recent_discoveries_performance IS 'Performance tracking for recently discovered repositories';
COMMENT ON FUNCTION get_repo_growth_history(BIGINT, INTEGER) IS 'Get daily growth history for a specific repository';
COMMENT ON FUNCTION get_trending_summary() IS 'Get overall summary statistics for the trending system';