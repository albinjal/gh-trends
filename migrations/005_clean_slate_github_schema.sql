-- Migration: Clean Slate GitHub-First Schema
-- Created: 2025-07-14
-- Purpose: Reset to simplified GitHub ID-based discovery system

-- Drop all existing tables (clean slate approach)
DROP TABLE IF EXISTS discovery_events CASCADE;
DROP TABLE IF EXISTS discovery_sources CASCADE;
DROP TABLE IF EXISTS trending_discoveries CASCADE;
DROP TABLE IF EXISTS snapshots CASCADE;
DROP TABLE IF EXISTS repos CASCADE;

-- Drop functions and triggers
DROP FUNCTION IF EXISTS update_repo_discovery_metadata() CASCADE;
DROP VIEW IF EXISTS repo_discovery_summary CASCADE;

-- Create new simplified repos table using GitHub IDs
CREATE TABLE repos (
    github_id BIGINT PRIMARY KEY, -- GitHub's immutable repo ID
    full_name TEXT NOT NULL, -- owner/repo (for display, can change)
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    homepage TEXT,
    language TEXT,
    topics TEXT[] DEFAULT ARRAY[]::TEXT[],
    
    -- GitHub stats (captured at discovery time)
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    watchers INTEGER NOT NULL DEFAULT 0,
    open_issues INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0, -- repo size in KB
    
    -- GitHub metadata
    is_fork BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    license TEXT, -- license name
    default_branch TEXT DEFAULT 'main',
    
    -- Timestamps from GitHub
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    github_pushed_at TIMESTAMPTZ,
    
    -- Discovery tracking (minimal)
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discovery_context JSONB DEFAULT '{}', -- {source: 'trending', rank: 3, page: 'daily'}
    
    -- Internal tracking
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_repos_full_name ON repos(full_name);
CREATE INDEX idx_repos_owner ON repos(owner);
CREATE INDEX idx_repos_language ON repos(language);
CREATE INDEX idx_repos_stars ON repos(stars DESC);
CREATE INDEX idx_repos_discovered_at ON repos(discovered_at DESC);
CREATE INDEX idx_repos_discovery_context ON repos USING GIN(discovery_context);
CREATE INDEX idx_repos_topics ON repos USING GIN(topics);

-- Enable RLS (Row Level Security)
ALTER TABLE repos ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read access for all repos
CREATE POLICY "Allow anonymous read access" ON repos
    FOR SELECT 
    TO anon, authenticated
    USING (true);

-- Allow authenticated users to insert/update repos
CREATE POLICY "Allow authenticated insert" ON repos
    FOR INSERT 
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated update" ON repos
    FOR UPDATE 
    TO authenticated
    USING (true);

-- Re-create the updated_at trigger
CREATE TRIGGER update_repos_updated_at 
    BEFORE UPDATE ON repos 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create view for trending repos (top by stars discovered recently)
CREATE VIEW trending_repos AS
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

-- Create view for recent discoveries
CREATE VIEW recent_discoveries AS
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

-- Add comments
COMMENT ON TABLE repos IS 'GitHub repositories discovered from trending/explore pages, using GitHub ID as primary key';
COMMENT ON COLUMN repos.github_id IS 'Immutable GitHub repository ID';
COMMENT ON COLUMN repos.full_name IS 'Current owner/repo name (can change if repo is renamed/transferred)';
COMMENT ON COLUMN repos.discovery_context IS 'Optional context about how repo was discovered {source, rank, page, etc}';
COMMENT ON VIEW trending_repos IS 'Recently discovered repos sorted by GitHub stars';
COMMENT ON VIEW recent_discoveries IS 'Last 100 discovered repositories';