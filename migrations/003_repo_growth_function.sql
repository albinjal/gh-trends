-- Migration: Add repo growth calculation function
-- Created: 2025-07-13

-- Function to calculate repository growth metrics
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
        SELECT DISTINCT ON (s.repo_id)
            s.repo_id,
            s.stars,
            s.forks,
            s.recorded_at as latest_recorded_at
        FROM snapshots s
        INNER JOIN repos r ON r.id = s.repo_id
        WHERE r.is_active = true
        ORDER BY s.repo_id, s.recorded_at DESC
    ),
    day_old_snapshots AS (
        SELECT DISTINCT ON (s.repo_id)
            s.repo_id,
            s.stars as day_old_stars,
            s.forks as day_old_forks
        FROM snapshots s
        INNER JOIN repos r ON r.id = s.repo_id
        WHERE r.is_active = true
        AND s.recorded_at <= NOW() - INTERVAL '24 hours'
        ORDER BY s.repo_id, s.recorded_at DESC
    ),
    growth_calculations AS (
        SELECT 
            r.id as repo_id,
            r.full_name,
            r.is_active,
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
        LEFT JOIN latest_snapshots ls ON ls.repo_id = r.id
        LEFT JOIN day_old_snapshots dos ON dos.repo_id = r.id
        WHERE r.is_active = true
        AND COALESCE(ls.stars, 0) >= p_min_total_stars
    )
    SELECT 
        gc.repo_id,
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