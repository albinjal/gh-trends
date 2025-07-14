import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { fetchReposBatched } from '../utils/github-graphql.ts';

interface RepoToSnapshot {
  github_id: number | null;
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
 * Main snapshot collection function with GraphQL batching
 */
Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const githubToken = Deno.env.get('GITHUB_TOKEN');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }
    if (!githubToken) {
      throw new Error('Missing GitHub token');
    }

    // Import and create Supabase client
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const maxRepos = parseInt(url.searchParams.get('limit') || '1000');

    console.log(`Starting snapshot collection (repo limit: ${maxRepos})`);

    // Check GitHub rate limit
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
    const { data: reposToSnapshot, error: fetchError } = await supabase
      .from('repos_needing_snapshots')
      .select('github_id, full_name, priority_score, hours_since_last_snapshot')
      .limit(maxRepos);

    if (fetchError) {
      throw new Error(`Failed to get repos needing snapshots: ${fetchError.message}`);
    }

    console.log(`Found ${reposToSnapshot?.length || 0} repos needing snapshots`);

    if (!reposToSnapshot || reposToSnapshot.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No repositories need snapshot updates at this time',
        stats: { repos_checked: 0, snapshots_taken: 0, api_calls_made: 0 }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const snapshots: SnapshotData[] = [];
    let apiCallsUsed = 0;
    let processedRepos = 0;

    const availableApiCalls = Math.max(0, rateLimit.remaining - 100);
    const effectiveLimit = Math.min(reposToSnapshot.length, maxRepos, availableApiCalls * 100);

    console.log(`Processing ${effectiveLimit} repos (limited by: repos=${reposToSnapshot.length}, max=${maxRepos}, api_calls=${availableApiCalls})`);

    const reposToProcess = reposToSnapshot.slice(0, effectiveLimit);

    // Fetch complete repo data via GraphQL batching
    const statsResults = await fetchReposBatched<FullRepoData>(
      reposToProcess.map(r => r.full_name),
      githubToken,
      'databaseId name owner { login } description homepageUrl primaryLanguage { name } repositoryTopics(first: 100) { nodes { topic { name } } } stargazerCount forkCount watchers { totalCount } issues(states: OPEN) { totalCount } diskUsage isFork isArchived isDisabled licenseInfo { name } defaultBranchRef { name } createdAt updatedAt pushedAt'
    );
    apiCallsUsed = Math.ceil(reposToProcess.length / 100);

    // Process results: update repo stubs and create snapshots
    const upsertPromises: Promise<any>[] = [];

    statsResults.forEach((data, index) => {
      processedRepos++;
      if (data) {
        const repo = reposToProcess[index];
        const isNew = !repo.github_id || repo.hours_since_last_snapshot > 9999;

        // Update repo with complete data if it's a stub
        if (isNew) {
          const upsertPromise = supabase.from('repos').upsert({
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
          }, { onConflict: 'full_name' }).then(({ error }) => {
            if (error) console.error('Upsert failed for', `${data.owner.login}/${data.name}`, ':', error);
          });

          upsertPromises.push(upsertPromise);
        }

        // Create snapshot
        snapshots.push({
          github_id: data.databaseId,
          stars: data.stargazerCount,
          forks: data.forkCount,
          watchers: data.watchers.totalCount,
          open_issues: data.issues.totalCount,
          subscribers: data.watchers.totalCount,
          size: data.diskUsage
        });
      }
    });

    // Wait for all upserts to complete
    await Promise.all(upsertPromises);

    console.log(`Collected ${snapshots.length} snapshots using ${apiCallsUsed} API calls`);

    // Store snapshots in database
    const storeResult = await storeSnapshots(supabase, snapshots);

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
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

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
    return {
      remaining: 100,
      total: 5000,
      reset_time: new Date(Date.now() + 3600000)
    };
  }
}

async function storeSnapshots(
  supabase: any,
  snapshots: SnapshotData[]
): Promise<{ inserted: number; errors: number }> {
  if (snapshots.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  let inserted = 0;
  let errors = 0;

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
