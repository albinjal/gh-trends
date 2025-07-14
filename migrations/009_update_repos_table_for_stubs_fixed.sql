-- Migration: Update Repos Table for Stubs (Fixed)
-- Created: 2025-07-14
-- Purpose: Support repository stubs discovered without GitHub ID initially

-- Drop existing foreign key constraint from snapshots to repos
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_repo_id_fkey;

-- Remove the old primary key and unique constraint on repos
ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_pkey;
ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_github_id_key;

-- Drop the old id column if it exists
ALTER TABLE repos DROP COLUMN IF EXISTS id;

-- Allow github_id to be NULL for repository stubs
ALTER TABLE repos ALTER COLUMN github_id DROP NOT NULL;

-- Make github_id the primary key (using BIGINT, allowing NULL initially)
ALTER TABLE repos ADD PRIMARY KEY (github_id);

-- Update snapshots table to reference github_id instead of repo_id
ALTER TABLE snapshots DROP COLUMN IF EXISTS repo_id;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS github_id BIGINT NOT NULL;

-- Re-add foreign key constraint from snapshots to repos
ALTER TABLE snapshots ADD CONSTRAINT snapshots_github_id_fkey
    FOREIGN KEY (github_id) REFERENCES repos(github_id) ON DELETE CASCADE;

-- Add discovery_context column for tracking how repos were discovered
ALTER TABLE repos ADD COLUMN IF NOT EXISTS discovery_context JSONB DEFAULT '{}'::JSONB;

-- Update indexes to work with new schema
DROP INDEX IF EXISTS idx_snapshots_repo_id_time;
CREATE INDEX IF NOT EXISTS idx_snapshots_github_id_time ON snapshots (github_id, recorded_at DESC);

-- Add index for discovery context
CREATE INDEX IF NOT EXISTS idx_repos_discovery_context ON repos USING GIN (discovery_context);

-- Add comments
COMMENT ON COLUMN repos.github_id IS 'GitHub repository ID - NULL for stubs, populated by snapshot-collector';
COMMENT ON COLUMN repos.full_name IS 'Repository full name - used for initial discovery before GitHub ID is available';
COMMENT ON COLUMN repos.discovery_context IS 'Optional context about how repo was discovered {source, rank, page, etc}';

-- Update table comment
COMMENT ON TABLE repos IS 'GitHub repositories discovered from trending/explore pages, using GitHub ID as primary key';
