-- Migration: Enhanced Discovery Schema
-- Created: 2025-07-14
-- Purpose: Add comprehensive discovery tracking with multiple sources

-- Create discovery sources table
CREATE TABLE discovery_sources (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_per_hour INTEGER DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial discovery sources
INSERT INTO discovery_sources (name, description, rate_limit_per_hour) VALUES
('github_trending', 'GitHub trending repositories (daily/weekly/monthly)', 20),
('github_explore', 'GitHub explore page repositories', 30),
('github_search', 'GitHub search API for trending keywords', 40),
('github_new_repos', 'Recently created repositories with activity', 30),
('github_collections', 'GitHub curated collections', 10);

-- Create enhanced discovery events table (replaces trending_discoveries)
CREATE TABLE discovery_events (
    id BIGSERIAL PRIMARY KEY,
    repo_id BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
    discovery_context JSONB NOT NULL DEFAULT '{}', -- {rank, period, language, topic, search_term, etc}
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add discovery metadata to repos table
ALTER TABLE repos ADD COLUMN IF NOT EXISTS discovery_sources TEXT[] DEFAULT '{}';
ALTER TABLE repos ADD COLUMN IF NOT EXISTS first_discovery_source TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS discovery_score INTEGER DEFAULT 0;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS discovery_count INTEGER DEFAULT 0;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS last_discovered TIMESTAMPTZ;

-- Update existing repos with discovery metadata from trending_discoveries
UPDATE repos SET 
    discovery_sources = ARRAY['github_trending'],
    first_discovery_source = 'github_trending',
    discovery_count = 1,
    last_discovered = (
        SELECT MIN(discovered_at) 
        FROM trending_discoveries 
        WHERE trending_discoveries.repo_id = repos.id
    )
WHERE id IN (SELECT DISTINCT repo_id FROM trending_discoveries);

-- Migrate existing trending_discoveries to discovery_events
INSERT INTO discovery_events (repo_id, source_id, discovery_context, discovered_at)
SELECT 
    td.repo_id,
    ds.id as source_id,
    jsonb_build_object(
        'period', td.period,
        'rank', td.rank,
        'language', td.language
    ) as discovery_context,
    td.discovered_at
FROM trending_discoveries td
JOIN discovery_sources ds ON ds.name = 'github_trending';

-- Create indexes for performance
CREATE INDEX idx_discovery_events_repo_id ON discovery_events(repo_id);
CREATE INDEX idx_discovery_events_source_id ON discovery_events(source_id);
CREATE INDEX idx_discovery_events_discovered_at ON discovery_events(discovered_at);
CREATE INDEX idx_discovery_events_context ON discovery_events USING GIN(discovery_context);
CREATE INDEX idx_repos_discovery_sources ON repos USING GIN(discovery_sources);
CREATE INDEX idx_repos_discovery_score ON repos(discovery_score DESC);
CREATE INDEX idx_repos_last_discovered ON repos(last_discovered DESC);

-- Add updated_at trigger for discovery_sources
CREATE TRIGGER update_discovery_sources_updated_at 
    BEFORE UPDATE ON discovery_sources 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Function to update repo discovery metadata when new discoveries are added
CREATE OR REPLACE FUNCTION update_repo_discovery_metadata()
RETURNS TRIGGER AS $$
BEGIN
    -- Update repo discovery metadata
    UPDATE repos SET
        discovery_sources = array_append(
            CASE WHEN NEW.source_id::text = ANY(
                SELECT unnest(discovery_sources) 
                FROM repos 
                WHERE id = NEW.repo_id
            ) THEN discovery_sources
            ELSE array_append(discovery_sources, (
                SELECT name FROM discovery_sources WHERE id = NEW.source_id
            ))
            END,
            NULL -- Remove any NULL values
        ),
        discovery_count = discovery_count + 1,
        discovery_score = discovery_score + 
            CASE 
                WHEN NEW.discovery_context->>'rank' IS NOT NULL 
                THEN (26 - LEAST(25, (NEW.discovery_context->>'rank')::INTEGER))
                ELSE 5
            END,
        last_discovered = NEW.discovered_at,
        first_discovery_source = COALESCE(
            first_discovery_source,
            (SELECT name FROM discovery_sources WHERE id = NEW.source_id)
        )
    WHERE id = NEW.repo_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for discovery metadata updates
CREATE TRIGGER update_repo_discovery_metadata_trigger
    AFTER INSERT ON discovery_events
    FOR EACH ROW
    EXECUTE FUNCTION update_repo_discovery_metadata();

-- Create view for comprehensive repository discovery analytics
CREATE VIEW repo_discovery_summary AS
SELECT 
    r.id,
    r.full_name,
    r.owner,
    r.name,
    r.language,
    r.description,
    r.discovery_sources,
    r.first_discovery_source,
    r.discovery_count,
    r.discovery_score,
    r.last_discovered,
    r.is_active,
    -- Latest snapshot data
    s.stars,
    s.forks,
    s.watchers,
    s.recorded_at as last_snapshot_at,
    -- Discovery source breakdown
    db.discovery_breakdown
FROM repos r
LEFT JOIN LATERAL (
    SELECT stars, forks, watchers, recorded_at
    FROM snapshots 
    WHERE repo_id = r.id 
    ORDER BY recorded_at DESC 
    LIMIT 1
) s ON true
LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(ds.name, de_count.cnt) as discovery_breakdown
    FROM (
        SELECT de.source_id, COUNT(*) as cnt
        FROM discovery_events de
        WHERE de.repo_id = r.id
        GROUP BY de.source_id
    ) de_count
    JOIN discovery_sources ds ON ds.id = de_count.source_id
) db ON true
ORDER BY r.discovery_score DESC, r.last_discovered DESC;

-- Add comment explaining the migration
COMMENT ON TABLE discovery_sources IS 'Tracks different sources for repository discovery (trending, explore, search, etc.)';
COMMENT ON TABLE discovery_events IS 'Logs all repository discovery events with source attribution and context';
COMMENT ON COLUMN repos.discovery_sources IS 'Array of source names where this repo was discovered';
COMMENT ON COLUMN repos.discovery_score IS 'Calculated score based on discovery frequency and ranking';
COMMENT ON VIEW repo_discovery_summary IS 'Comprehensive view of repository discovery analytics';