import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { fetchReposBatched } from '../utils/github-graphql.ts';

interface GitHubRepoStats {
  id: number;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  subscribers_count: number;
  size: number;
}

// Add optional stars to RepoToSnapshot
interface RepoToSnapshot {
  github_id: number;
  full_name: string;
  priority_score: number;
  hours_since_last_snapshot: number;
  stars?: number;
}

interface SnapshotData {
  github_id: number;
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  subscribers: number;
  size: number;
}

// Define FullRepoData after GitHubRepoStats
interface FullRepoData {
  databaseId: number;
  name: string;
  owner: { login: string };
  description: string | null;
  homepageUrl: string | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  issues: { totalCount: number };
  diskUsage: number;
  isFork: boolean;
  isArchived: boolean;
  isDisabled: boolean;
  licenseInfo: { name: string } | null;
  defaultBranchRef: { name: string } | null;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
}

/**
 * Get repositories that need snapshot updates, prioritized by urgency
 */
async function getReposNeedingSnapshots(
  supabaseUrl: string,
  supabaseKey: string,
  limit: number = 100
): Promise<RepoToSnapshot[]> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from('repos_needing_snapshots')
    .select('github_id, full_name, priority_score, hours_since_last_snapshot')
    .limit(limit);

  if (error) {
    throw new Error(`Failed to get repos needing snapshots: ${error.message}`);
  }

  return data || [];
}

/**
 * Store snapshot data in the database
 */
async function storeSnapshots(
  supabaseUrl: string,
  supabaseKey: string,
  snapshots: SnapshotData[]
): Promise<{ inserted: number; errors: number }> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (snapshots.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  let inserted = 0;
  let errors = 0;

  // Insert snapshots in batches
  const batchSize = 50;
  for (let i = 0; i < snapshots.length; i += batchSize) {
    const batch = snapshots.slice(i, i + batchSize);

    try {
      const { error } = await supabase
        .from('snapshots')
        .insert(batch);

      if (error) {
        console.error(`Failed to insert snapshot batch ${i / batchSize + 1}:`, error);
        errors += batch.length;
      } else {
        inserted += batch.length;
        console.log(`Inserted snapshot batch ${i / batchSize + 1}: ${batch.length} snapshots`);
      }

    } catch (error) {
      console.error(`Exception inserting snapshot batch ${i / batchSize + 1}:`, error);
      errors += batch.length;
    }
  }

  return { inserted, errors };
}

/**
 * Check GitHub API rate limit status
 */
async function checkRateLimit(githubToken: string): Promise<{
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
 * Main snapshot collection function
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

    // Parse request parameters
    const url = new URL(req.url);
    const maxRepos = parseInt(url.searchParams.get('limit') || '1000'); // Much higher default

    console.log(`Starting snapshot collection (repo limit: ${maxRepos})`);

    // Check GitHub API rate limit
    const rateLimit = await checkRateLimit(githubToken);
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

    // Get repositories that need snapshots
    const reposToSnapshot = await getReposNeedingSnapshots(supabaseUrl, supabaseKey, maxRepos);
    console.log(`Found ${reposToSnapshot.length} repos needing snapshots`);

    if (reposToSnapshot.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No repositories need snapshot updates at this time',
        stats: { repos_checked: 0, snapshots_taken: 0, api_calls_made: 0 }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Collect snapshots with rate limiting
    const snapshots: SnapshotData[] = [];
    let apiCallsUsed = 0;
    let processedRepos = 0;

    // Use available rate limit intelligently (leave buffer for other functions)
    const availableApiCalls = Math.max(0, rateLimit.remaining - 100); // Leave 100 calls buffer
    const effectiveLimit = Math.min(reposToSnapshot.length, maxRepos, availableApiCalls * 100); // Adjust for batching (assuming ~100 per call)

    console.log(`Processing ${effectiveLimit} repos (limited by: repos=${reposToSnapshot.length}, max=${maxRepos}, api_calls=${availableApiCalls})`);

    const reposToProcess = reposToSnapshot.slice(0, effectiveLimit);

    // Update fields in fetch call to include all:
    const statsResults = await fetchReposBatched<FullRepoData>(
      reposToProcess.map(r => r.full_name),
      githubToken,
      'databaseId name owner { login } description homepageUrl primaryLanguage { name } repositoryTopics(first: 100) { nodes { topic { name } } } stargazerCount forkCount watchers { totalCount } issues(states: OPEN) { totalCount } diskUsage isFork isArchived isDisabled licenseInfo { name } defaultBranchRef { name } createdAt updatedAt pushedAt'
    );
    apiCallsUsed = Math.ceil(reposToProcess.length / 100);

    // In processing loop, add check for new repos and upsert to repos
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseKey);

    await Promise.all(statsResults.map(async (data, index) => {
      processedRepos++;
      if (data) {
        const repo = reposToProcess[index];
        const isNew = repo.hours_since_last_snapshot > 9999 || !repo.stars;  // Heuristic for stubs
        if (isNew) {
          const { error } = await supabase.from('repos').upsert({
            github_id: data.databaseId,
            full_name: `${data.owner.login}/${data.name}`,
            owner: data.owner.login,
            name: data.name,
            description: data.description,
            homepage: data.homepageUrl,
            language: data.primaryLanguage?.name || null,
            topics: data.repositoryTopics.nodes.map(n => n.topic.name),
            stars: data.stargazerCount,
            forks: data.forkCount,
            watchers: data.watchers.totalCount,
            open_issues: data.issues.totalCount,
            size: data.diskUsage,
            is_fork: data.isFork,
            is_archived: data.isArchived,
            is_disabled: data.isDisabled,
            license: data.licenseInfo?.name || null,
            default_branch: data.defaultBranchRef?.name || '',
            github_created_at: data.createdAt,
            github_updated_at: data.updatedAt,
            github_pushed_at: data.pushedAt
          }, { onConflict: 'full_name' });
          if (error) console.error('Upsert failed:', error);
        }
        snapshots.push({
          github_id: data.databaseId || repo.github_id,
          stars: data.stargazerCount,
          forks: data.forkCount,
          watchers: data.watchers.totalCount,
          open_issues: data.issues.totalCount,
          subscribers: data.watchers.totalCount,  // Approx
          size: data.diskUsage
        });
      }
    }));

    console.log(`Collected ${snapshots.length} snapshots using ${apiCallsUsed} API calls`);

    // Store snapshots in database
    const storeResult = await storeSnapshots(supabaseUrl, supabaseKey, snapshots);

    console.log(`Snapshot collection complete: ${storeResult.inserted} inserted, ${storeResult.errors} errors`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      stats: {
        repos_checked: processedRepos,
        snapshots_taken: snapshots.length,
        api_calls_made: apiCallsUsed,
        rate_limit_remaining: rateLimit.remaining - apiCallsUsed,
        ...storeResult
      },
      rate_limit: {
        remaining_after: rateLimit.remaining - apiCallsUsed,
        total: rateLimit.total,
        reset_time: rateLimit.reset_time
      }
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      }
    });

  } catch (error) {
    console.error('Snapshot collector error:', error);

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
