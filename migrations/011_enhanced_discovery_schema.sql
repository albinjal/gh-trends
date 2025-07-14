-- Migration: Enhanced Discovery Schema
-- Created: 2025-07-14
-- Purpose: Add enhanced discovery features and performance monitoring

-- Create discovery performance view
CREATE OR REPLACE VIEW discovery_performance AS
SELECT
    r.full_name,
    r.discovered_at,
    r.discovery_context,
    (r.github_id IS NOT NULL) AS is_complete,
    CASE
        WHEN r.github_id IS NOT NULL THEN 'complete'
        ELSE 'stub'
    END AS status,
    EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) / 3600.0 AS hours_since_discovery,
    COALESCE(latest.stars, r.stars, 0) AS current_stars,
    COALESCE(latest.forks, r.forks, 0) AS current_forks,
    latest.recorded_at AS last_snapshot_at
FROM repos r
LEFT JOIN LATERAL (
    SELECT s.stars, s.forks, s.recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true
WHERE r.discovered_at >= NOW() - INTERVAL '7 days'
ORDER BY r.discovered_at DESC;

-- Create recent discoveries performance view
CREATE OR REPLACE VIEW recent_discoveries_performance AS
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
    latest.stars AS current_stars,
    latest.forks AS current_forks,
    latest.recorded_at AS last_snapshot,
    COALESCE(latest.stars - r.stars, 0) AS stars_gained_since_discovery,
    COALESCE(latest.forks - r.forks, 0) AS forks_gained_since_discovery,
    EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) / 86400.0 AS days_since_discovery,
    CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) > 86400 THEN
            ROUND(COALESCE(latest.stars - r.stars, 0)::NUMERIC / (EXTRACT(EPOCH FROM (NOW() - r.discovered_at)) / 86400.0), 2)
        ELSE 0
    END AS stars_per_day_since_discovery
FROM repos r
LEFT JOIN LATERAL (
    SELECT s.stars, s.forks, s.watchers, s.recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest ON true
WHERE r.discovered_at >= NOW() - INTERVAL '7 days'
ORDER BY r.discovered_at DESC;

-- Update repos_needing_snapshots view to include stubs priority
CREATE OR REPLACE VIEW repos_needing_snapshots AS
SELECT
    r.github_id,
    r.full_name,
    COALESCE(r.stars, 0) AS stars,
    r.discovered_at,
    latest_snapshot.recorded_at AS last_snapshot_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0 AS hours_since_last_snapshot,

    -- Enhanced priority scoring with stub support
    CASE
        -- URGENT: Repository stubs (no github_id) - need immediate completion
        WHEN r.github_id IS NULL THEN 1100

        -- URGENT: New repos (discovered in last 48h) - snapshot immediately
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 1000

        -- URGENT: No snapshots yet for repos discovered >48h ago
        WHEN latest_snapshot.recorded_at IS NULL AND r.discovered_at < NOW() - INTERVAL '48 hours' THEN 900

        -- HIGH: Popular repos (10k+ stars) - daily updates
        WHEN COALESCE(r.stars, 0) >= 10000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '20 hours' THEN 800

        -- HIGH: Medium popularity (1k+ stars) - daily updates
        WHEN COALESCE(r.stars, 0) >= 1000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '22 hours' THEN 700

        -- MEDIUM: Moderate popularity (100+ stars) - every 2 days
        WHEN COALESCE(r.stars, 0) >= 100 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '44 hours' THEN 500

        -- MEDIUM: Small repos (10+ stars) - every 3 days
        WHEN COALESCE(r.stars, 0) >= 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '68 hours' THEN 300

        -- LOW: Very small repos (<10 stars) - weekly updates only
        WHEN COALESCE(r.stars, 0) < 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '7 days' THEN 100

        -- SKIP: Recent snapshots don't need updates yet
        ELSE 0
    END AS priority_score,

    -- Update frequency description
    CASE
        WHEN r.github_id IS NULL THEN 'immediate_stub'
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 'immediate'
        WHEN COALESCE(r.stars, 0) >= 1000 THEN 'daily'
        WHEN COALESCE(r.stars, 0) >= 100 THEN 'every_2_days'
        WHEN COALESCE(r.stars, 0) >= 10 THEN 'every_3_days'
        ELSE 'weekly'
    END AS update_frequency,

    -- Time until next update is due
    CASE
        WHEN r.github_id IS NULL THEN 0
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 0
        WHEN COALESCE(r.stars, 0) >= 1000 THEN GREATEST(0, 24 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        WHEN COALESCE(r.stars, 0) >= 100 THEN GREATEST(0, 48 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        WHEN COALESCE(r.stars, 0) >= 10 THEN GREATEST(0, 72 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        ELSE GREATEST(0, 168 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
    END AS hours_until_next_update

FROM repos r
LEFT JOIN LATERAL (
    SELECT recorded_at
    FROM snapshots s
    WHERE s.github_id = r.github_id
    ORDER BY s.recorded_at DESC
    LIMIT 1
) latest_snapshot ON true

-- Only include repos that actually need updates (priority_score > 0)
WHERE
    CASE
        WHEN r.github_id IS NULL THEN true
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN true
        WHEN latest_snapshot.recorded_at IS NULL AND r.discovered_at < NOW() - INTERVAL '48 hours' THEN true
        WHEN COALESCE(r.stars, 0) >= 10000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '20 hours' THEN true
        WHEN COALESCE(r.stars, 0) >= 1000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '22 hours' THEN true
        WHEN COALESCE(r.stars, 0) >= 100 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '44 hours' THEN true
        WHEN COALESCE(r.stars, 0) >= 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '68 hours' THEN true
        WHEN COALESCE(r.stars, 0) < 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '7 days' THEN true
        ELSE false
    END

ORDER BY
    CASE
        WHEN r.github_id IS NULL THEN 1100
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 1000
        WHEN latest_snapshot.recorded_at IS NULL AND r.discovered_at < NOW() - INTERVAL '48 hours' THEN 900
        WHEN COALESCE(r.stars, 0) >= 10000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '20 hours' THEN 800
        WHEN COALESCE(r.stars, 0) >= 1000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '22 hours' THEN 700
        WHEN COALESCE(r.stars, 0) >= 100 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '44 hours' THEN 500
        WHEN COALESCE(r.stars, 0) >= 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '68 hours' THEN 300
        WHEN COALESCE(r.stars, 0) < 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '7 days' THEN 100
        ELSE 0
    END DESC,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0 DESC;

-- Re-create snapshot schedule summary view
CREATE OR REPLACE VIEW snapshot_schedule_summary AS
SELECT
    update_frequency,
    COUNT(*) as repo_count,
    AVG(hours_since_last_snapshot) as avg_hours_since_last,
    MIN(hours_until_next_update) as min_hours_until_next,
    MAX(priority_score) as max_priority
FROM repos_needing_snapshots
GROUP BY update_frequency
ORDER BY MAX(priority_score) DESC;

-- Add comments for new views
COMMENT ON VIEW discovery_performance IS 'Performance monitoring for repository discovery process';
COMMENT ON VIEW recent_discoveries_performance IS 'Performance analysis of recently discovered repositories';
COMMENT ON VIEW repos_needing_snapshots IS 'Repositories needing snapshots with intelligent priority scoring including stub support';
COMMENT ON VIEW snapshot_schedule_summary IS 'Summary of snapshot scheduling by update frequency';
