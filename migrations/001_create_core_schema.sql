-- Migration: Create Core Schema
-- Created: 2025-07-13
-- Purpose: Initial database schema for GitHub repository tracking

-- Create repos table for storing GitHub repository information
CREATE TABLE repos (
    id BIGSERIAL PRIMARY KEY,
    github_id BIGINT UNIQUE NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    homepage TEXT,
    language TEXT,
    topics TEXT[] DEFAULT ARRAY[]::TEXT[],
    stars INTEGER DEFAULT 0 NOT NULL,
    forks INTEGER DEFAULT 0 NOT NULL,
    watchers INTEGER DEFAULT 0 NOT NULL,
    open_issues INTEGER DEFAULT 0 NOT NULL,
    size INTEGER DEFAULT 0 NOT NULL,
    is_fork BOOLEAN DEFAULT FALSE NOT NULL,
    is_archived BOOLEAN DEFAULT FALSE NOT NULL,
    is_disabled BOOLEAN DEFAULT FALSE NOT NULL,
    license TEXT,
    default_branch TEXT DEFAULT 'main',
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    github_pushed_at TIMESTAMPTZ,
    discovered_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create snapshots table for time-series data
CREATE TABLE snapshots (
    id BIGSERIAL PRIMARY KEY,
    repo_id BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    stars INTEGER DEFAULT 0 NOT NULL,
    forks INTEGER DEFAULT 0 NOT NULL,
    watchers INTEGER DEFAULT 0 NOT NULL,
    open_issues INTEGER DEFAULT 0 NOT NULL,
    subscribers INTEGER DEFAULT 0 NOT NULL,
    size INTEGER DEFAULT 0 NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at for repos
CREATE TRIGGER repos_updated_at_trigger
    BEFORE UPDATE ON repos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add table comments
COMMENT ON TABLE repos IS 'GitHub repositories tracked by the system';
COMMENT ON TABLE snapshots IS 'Time-series snapshots of GitHub repository statistics';
