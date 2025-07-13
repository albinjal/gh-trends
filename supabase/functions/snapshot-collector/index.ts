import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface GitHubRepo {
  id: number;
  full_name: string;
  owner: {
    login: string;
  };
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  subscribers_count: number;
  size: number;
  topics: string[];
  created_at: string;
  pushed_at: string;
}

interface RepoSnapshot {
  repo_id: number;
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  subscribers: number;
  size: number;
}

interface BatchResult {
  success: number;
  failed: number;
  rate_limited: boolean;
  errors: string[];
}

/**
 * Fetch repository data from GitHub API in batches
 */
async function fetchReposBatch(
  repoNames: string[],
  githubToken?: string
): Promise<{ repos: GitHubRepo[]; errors: string[] }> {
  const repos: GitHubRepo[] = [];
  const errors: string[] = [];
  
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GitHubTrendsBot/1.0',
  };
  
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }
  
  // GitHub API doesn't support batch repo fetching, so we need individual requests
  // But we can parallelize with rate limiting
  const batchSize = 10; // Parallel requests
  
  for (let i = 0; i < repoNames.length; i += batchSize) {
    const batch = repoNames.slice(i, i + batchSize);
    const promises = batch.map(async (repoName) => {
      try {
        const response = await fetch(`https://api.github.com/repos/${repoName}`, {
          headers
        });
        
        if (response.status === 403) {
          const rateLimitReset = response.headers.get('x-ratelimit-reset');
          throw new Error(`Rate limited. Resets at: ${rateLimitReset}`);
        }
        
        if (response.status === 404) {
          throw new Error(`Repository not found: ${repoName}`);
        }
        
        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }
        
        const repo: GitHubRepo = await response.json();
        return { repo, error: null };
        
      } catch (error) {
        return { repo: null, error: `${repoName}: ${error.message}` };
      }
    });
    
    const results = await Promise.all(promises);
    
    for (const result of results) {
      if (result.repo) {
        repos.push(result.repo);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
    
    // Rate limiting: delay between batches
    if (i + batchSize < repoNames.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return { repos, errors };
}

/**
 * Update repository metadata and create snapshot
 */
async function updateRepoAndCreateSnapshot(
  supabaseUrl: string,
  supabaseKey: string,
  dbRepoId: number,
  githubRepo: GitHubRepo
): Promise<void> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Update repo metadata
  const { error: updateError } = await supabase
    .from('repos')
    .update({
      description: githubRepo.description,
      homepage: githubRepo.homepage,
      language: githubRepo.language,
      topics: githubRepo.topics,
      created_at: githubRepo.created_at,
      pushed_at: githubRepo.pushed_at,
      last_snapshot: new Date().toISOString()
    })
    .eq('id', dbRepoId);
  
  if (updateError) {
    throw new Error(`Failed to update repo metadata: ${updateError.message}`);
  }
  
  // Create snapshot
  const { error: snapshotError } = await supabase
    .from('snapshots')
    .insert({
      repo_id: dbRepoId,
      stars: githubRepo.stargazers_count,
      forks: githubRepo.forks_count,
      watchers: githubRepo.watchers_count,
      open_issues: githubRepo.open_issues_count,
      subscribers: githubRepo.subscribers_count,
      size: githubRepo.size
    });
  
  if (snapshotError) {
    throw new Error(`Failed to create snapshot: ${snapshotError.message}`);
  }
}

/**
 * Get active repositories that need snapshots
 */
async function getActiveRepos(
  supabaseUrl: string,
  supabaseKey: string,
  limit: number = 100
): Promise<{ id: number; full_name: string }[]> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  const { data, error } = await supabase
    .from('repos')
    .select('id, full_name')
    .eq('is_active', true)
    .order('last_snapshot', { ascending: true, nullsFirst: true })
    .limit(limit);
  
  if (error) {
    throw new Error(`Failed to fetch active repos: ${error.message}`);
  }
  
  return data || [];
}

/**
 * Check GitHub API rate limit
 */
async function checkRateLimit(githubToken?: string): Promise<{
  remaining: number;
  reset: number;
  limit: number;
}> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GitHubTrendsBot/1.0',
  };
  
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }
  
  const response = await fetch('https://api.github.com/rate_limit', { headers });
  
  if (!response.ok) {
    throw new Error(`Rate limit check failed: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    remaining: data.rate.remaining,
    reset: data.rate.reset,
    limit: data.rate.limit
  };
}

Deno.serve(async (req: Request) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const githubToken = Deno.env.get('GITHUB_TOKEN'); // Optional but recommended
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }
    
    // Parse request parameters
    const url = new URL(req.url);
    const batchSize = Math.min(
      parseInt(url.searchParams.get('batch_size') || '50'),
      200 // Maximum batch size
    );
    const minRateLimit = parseInt(url.searchParams.get('min_rate_limit') || '100');
    
    console.log(`Starting snapshot collection (batch_size: ${batchSize})`);
    
    // Check rate limit before starting
    const rateLimit = await checkRateLimit(githubToken);
    console.log(`GitHub API rate limit: ${rateLimit.remaining}/${rateLimit.limit}`);
    
    if (rateLimit.remaining < minRateLimit) {
      const resetTime = new Date(rateLimit.reset * 1000);
      throw new Error(`Rate limit too low (${rateLimit.remaining}). Resets at: ${resetTime.toISOString()}`);
    }
    
    // Get active repositories
    const activeRepos = await getActiveRepos(supabaseUrl, supabaseKey, batchSize);
    console.log(`Found ${activeRepos.length} active repos to snapshot`);
    
    if (activeRepos.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No repos to snapshot',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Fetch repo data from GitHub
    const repoNames = activeRepos.map(r => r.full_name);
    const { repos: githubRepos, errors } = await fetchReposBatch(repoNames, githubToken);
    
    console.log(`Fetched ${githubRepos.length} repos from GitHub API`);
    
    // Process each repo
    const results: BatchResult = {
      success: 0,
      failed: 0,
      rate_limited: false,
      errors: [...errors]
    };
    
    for (const githubRepo of githubRepos) {
      try {
        const dbRepo = activeRepos.find(r => r.full_name === githubRepo.full_name);
        if (!dbRepo) {
          throw new Error(`Database repo not found for ${githubRepo.full_name}`);
        }
        
        await updateRepoAndCreateSnapshot(supabaseUrl, supabaseKey, dbRepo.id, githubRepo);
        results.success++;
        
      } catch (error) {
        console.error(`Failed to process ${githubRepo.full_name}:`, error);
        results.failed++;
        results.errors.push(`${githubRepo.full_name}: ${error.message}`);
      }
    }
    
    // Check final rate limit
    const finalRateLimit = await checkRateLimit(githubToken);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      batch_size: batchSize,
      processed: githubRepos.length,
      results,
      rate_limit: {
        remaining: finalRateLimit.remaining,
        reset: new Date(finalRateLimit.reset * 1000).toISOString()
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