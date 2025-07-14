-- Migration: Improve Snapshot Priority System
-- Created: 2025-07-14  
-- Purpose: Enhanced priority system for efficient snapshot scheduling

-- Drop and recreate the repos_needing_snapshots view with better priority logic
DROP VIEW IF EXISTS repos_needing_snapshots;

CREATE VIEW repos_needing_snapshots AS
SELECT 
    r.github_id,
    r.full_name,
    r.stars,
    r.discovered_at,
    latest_snapshot.recorded_at as last_snapshot_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0 as hours_since_last_snapshot,
    
    -- Enhanced priority scoring based on repo characteristics
    CASE
        -- URGENT: New repos (discovered in last 48h) - snapshot immediately
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 1000
        
        -- URGENT: No snapshots yet for repos discovered >48h ago
        WHEN latest_snapshot.recorded_at IS NULL AND r.discovered_at < NOW() - INTERVAL '48 hours' THEN 900
        
        -- HIGH: Popular repos (10k+ stars) - daily updates
        WHEN r.stars >= 10000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '20 hours' THEN 800
        
        -- HIGH: Medium popularity (1k+ stars) - daily updates  
        WHEN r.stars >= 1000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '22 hours' THEN 700
        
        -- MEDIUM: Moderate popularity (100+ stars) - every 2 days
        WHEN r.stars >= 100 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '44 hours' THEN 500
        
        -- MEDIUM: Small repos (10+ stars) - every 3 days
        WHEN r.stars >= 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '68 hours' THEN 300
        
        -- LOW: Very small repos (<10 stars) - weekly updates only
        WHEN r.stars < 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '7 days' THEN 100
        
        -- SKIP: Recent snapshots don't need updates yet
        ELSE 0
    END as priority_score,
    
    -- Update frequency description
    CASE
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 'immediate'
        WHEN r.stars >= 1000 THEN 'daily'
        WHEN r.stars >= 100 THEN 'every_2_days'  
        WHEN r.stars >= 10 THEN 'every_3_days'
        ELSE 'weekly'
    END as update_frequency,
    
    -- Time until next update is due
    CASE
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN 0
        WHEN r.stars >= 1000 THEN GREATEST(0, 24 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        WHEN r.stars >= 100 THEN GREATEST(0, 48 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        WHEN r.stars >= 10 THEN GREATEST(0, 72 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
        ELSE GREATEST(0, 168 - EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot.recorded_at, r.discovered_at))) / 3600.0)
    END as hours_until_next_update
    
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
        WHEN r.discovered_at >= NOW() - INTERVAL '48 hours' THEN true
        WHEN latest_snapshot.recorded_at IS NULL AND r.discovered_at < NOW() - INTERVAL '48 hours' THEN true
        WHEN r.stars >= 10000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '20 hours' THEN true
        WHEN r.stars >= 1000 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '22 hours' THEN true
        WHEN r.stars >= 100 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '44 hours' THEN true
        WHEN r.stars >= 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '68 hours' THEN true
        WHEN r.stars < 10 AND latest_snapshot.recorded_at <= NOW() - INTERVAL '7 days' THEN true
        ELSE false
    END

ORDER BY priority_score DESC, hours_since_last_snapshot DESC;

-- Create a summary view for snapshot scheduling insights
CREATE VIEW snapshot_schedule_summary AS
SELECT 
    update_frequency,
    COUNT(*) as repo_count,
    AVG(hours_since_last_snapshot) as avg_hours_since_last,
    MIN(hours_until_next_update) as min_hours_until_next,
    MAX(priority_score) as max_priority
FROM repos_needing_snapshots
GROUP BY update_frequency
ORDER BY max_priority DESC;

-- Add comments
COMMENT ON VIEW repos_needing_snapshots IS 'Repositories needing snapshots with intelligent priority scoring based on popularity and recency';
COMMENT ON VIEW snapshot_schedule_summary IS 'Summary of snapshot scheduling by update frequency';