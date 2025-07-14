import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { fetchReposBatched } from '../utils/github-graphql.ts';

interface GitHubRepo {
  id: number; // GitHub's repo ID
  full_name: string;
  name: string;
  owner: {
    login: string;
  };
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  size: number;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  license: {
    name: string;
  } | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

interface DiscoveredRepo {
  github_id: number;
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  size: number;
  is_fork: boolean;
  is_archived: boolean;
  is_disabled: boolean;
  license: string | null;
  default_branch: string;
  github_created_at: string;
  github_updated_at: string;
  github_pushed_at: string;
  discovery_context: Record<string, any>;
}

/**
 * Extract GitHub repository URLs from HTML content
 */
function extractGitHubRepoUrls(html: string): string[] {
  // Match GitHub repo URLs: github.com/owner/repo
  const repoPattern = /github\.com\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;
  const matches = [...html.matchAll(repoPattern)];

  const repos = new Set<string>();

  matches.forEach(match => {
    const fullName = match[1];
    const parts = fullName.split('/');

    // Validate owner/repo format and filter out non-repo URLs
    if (parts.length === 2 &&
        parts[0].length > 0 &&
        parts[1].length > 0 &&
        !fullName.includes('/settings') &&
        !fullName.includes('/orgs') &&
        !fullName.includes('/users') &&
        !fullName.includes('.')) { // Avoid file paths
      repos.add(fullName);
    }
  });

  return Array.from(repos);
}

/**
 * Scrape a single page for GitHub repository URLs
 */
async function scrapePage(url: string, context: Record<string, any>): Promise<{ repos: string[], context: Record<string, any> }> {
  console.log(`Scraping: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GitHubTrendsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const repos = extractGitHubRepoUrls(html);

    console.log(`Found ${repos.length} repos on ${url}`);
    return { repos, context };

  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return { repos: [], context };
  }
}

/**
 * Check which repository full_names we already have in the database
 */
async function getExistingRepoNames(
  supabaseUrl: string,
  supabaseKey: string,
  fullNames: string[]
): Promise<Set<string>> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (fullNames.length === 0) return new Set();

  const { data, error } = await supabase
    .from('repos')
    .select('full_name')
    .in('full_name', fullNames);

  if (error) {
    console.error('Failed to check existing repos:', error);
    return new Set();
  }

  return new Set(data?.map(row => row.full_name) || []);
}

/**
 * Check GitHub API rate limit status
 */
async function checkGitHubRateLimit(githubToken: string): Promise<{
  remaining: number;
  total: number;
  reset_time: Date;
}> {
  try {
    const response = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'User-Agent': 'GitHubTrendsBot/1.0',
      }
    });

    if (!response.ok) {
      throw new Error(`Rate limit check failed: ${response.status}`);
    }

    const data = await response.json();
    const coreLimit = data.resources.core;

    return {
      remaining: coreLimit.remaining,
      total: coreLimit.limit,
      reset_time: new Date(coreLimit.reset * 1000)
    };

  } catch (error) {
    console.error('Failed to check rate limit:', error);
    // Return conservative defaults if check fails
    return {
      remaining: 100,
      total: 5000,
      reset_time: new Date(Date.now() + 3600000) // 1 hour from now
    };
  }
}

/**
 * Store discovered repositories in the database
 */
async function storeDiscoveredRepos(
  supabaseUrl: string,
  supabaseKey: string,
  repos: DiscoveredRepo[]
): Promise<{ inserted: number; errors: number }> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (repos.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  let inserted = 0;
  let errors = 0;

  console.log(`Storing ${repos.length} new repositories`);

  // Insert new repos in batches
  const batchSize = 50;
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);

    try {
      const { error } = await supabase
        .from('repos')
        .insert(batch.map(repo => ({
          github_id: repo.github_id,
          full_name: repo.full_name,
          owner: repo.owner,
          name: repo.name,
          description: repo.description,
          homepage: repo.homepage,
          language: repo.language,
          topics: repo.topics,
          stars: repo.stars,
          forks: repo.forks,
          watchers: repo.watchers,
          open_issues: repo.open_issues,
          size: repo.size,
          is_fork: repo.is_fork,
          is_archived: repo.is_archived,
          is_disabled: repo.is_disabled,
          license: repo.license,
          default_branch: repo.default_branch,
          github_created_at: repo.github_created_at,
          github_updated_at: repo.github_updated_at,
          github_pushed_at: repo.github_pushed_at,
          discovery_context: repo.discovery_context
        })));

      if (error) {
        console.error(`Failed to insert batch ${i / batchSize + 1}:`, error);
        errors += batch.length;
      } else {
        inserted += batch.length;
        console.log(`Inserted batch ${i / batchSize + 1}: ${batch.length} repos`);
      }

    } catch (error) {
      console.error(`Exception inserting batch ${i / batchSize + 1}:`, error);
      errors += batch.length;
    }
  }

  return { inserted, errors };
}

/**
 * Add a storeRepoStubs function
 */
async function storeRepoStubs(
  supabaseUrl: string,
  supabaseKey: string,
  stubs: { full_name: string; discovery_context: Record<string, any> }[]
): Promise<{ inserted: number; errors: number }> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (stubs.length === 0) return { inserted: 0, errors: 0 };

  // Insert stubs
  const { error } = await supabase.from('repos').insert(
    stubs.map(s => ({
      full_name: s.full_name,
      discovered_at: new Date().toISOString(),
      discovery_context: s.discovery_context
    }))
  );

  return { inserted: error ? 0 : stubs.length, errors: error ? stubs.length : 0 };
}

/**
 * Main discovery function
 */
Deno.serve(async (req: Request) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const githubToken = Deno.env.get('GITHUB_TOKEN');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }
    if (!githubToken) {
      throw new Error('Missing GitHub token');
    }

    // Define pages to scrape
    const scrapeTargets = [
      { url: 'https://github.com/trending', context: { source: 'trending', period: 'daily' } },
      { url: 'https://github.com/trending?since=weekly', context: { source: 'trending', period: 'weekly' } },
      { url: 'https://github.com/trending?since=monthly', context: { source: 'trending', period: 'monthly' } },
      { url: 'https://github.com/explore', context: { source: 'explore' } },
      // Add more sources as needed
    ];

    console.log('Starting GitHub discovery...');

    // Phase 1: Scrape pages for repo URLs
    const allRepoUrls = new Set<string>();
    const repoContexts = new Map<string, Record<string, any>>();

    for (const target of scrapeTargets) {
      const result = await scrapePage(target.url, target.context);

      result.repos.forEach(repoUrl => {
        allRepoUrls.add(repoUrl);
        // Store context for this repo (last one wins if multiple sources)
        repoContexts.set(repoUrl, result.context);
      });

      // Rate limiting between page scrapes
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`Found ${allRepoUrls.size} unique repos across all sources`);

    // Phase 2: Check GitHub rate limit and filter existing repos
    const rateLimit = await checkGitHubRateLimit(githubToken);
    console.log(`GitHub API rate limit: ${rateLimit.remaining}/${rateLimit.total} remaining`);

    if (rateLimit.remaining < 50) {
      const resetIn = Math.ceil((rateLimit.reset_time.getTime() - Date.now()) / 60000);
      console.warn(`Low API rate limit (${rateLimit.remaining} remaining). Reset in ${resetIn} minutes.`);

      return new Response(JSON.stringify({
        success: false,
        error: `Rate limit too low (${rateLimit.remaining} remaining). Try again in ${resetIn} minutes.`,
        rate_limit: rateLimit
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check which repos we already have (by full_name)
    const repoArray = Array.from(allRepoUrls);
    const existingRepoNames = await getExistingRepoNames(supabaseUrl, supabaseKey, repoArray);

    // Filter out repos we already have
    const newRepoUrls = repoArray.filter(repoUrl => !existingRepoNames.has(repoUrl));
    const skippedCount = repoArray.length - newRepoUrls.length;

    console.log(`${newRepoUrls.length} new repos to add as stubs, ${skippedCount} already exist`);

    const stubs = newRepoUrls.map(url => ({
      full_name: url,
      discovery_context: repoContexts.get(url) || {}
    }));

    const storeResult = await storeRepoStubs(supabaseUrl, supabaseKey, stubs);

    console.log(`Discovery complete: ${storeResult.inserted} stubs inserted, ${storeResult.errors} errors`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      stats: {
        pages_scraped: scrapeTargets.length,
        unique_repos_found: allRepoUrls.size,
        existing_repos_skipped: skippedCount,
        new_stubs_added: newRepoUrls.length,
        api_calls_made: 0,  // No API calls now
        ...storeResult
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Discovery error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
