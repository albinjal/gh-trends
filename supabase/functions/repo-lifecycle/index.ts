import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface RepoGrowthMetrics {
  repo_id: number;
  full_name: string;
  daily_star_growth: number;
  daily_fork_growth: number;
  total_stars: number;
  total_forks: number;
  days_since_last_growth: number;
  is_active: boolean;
}

interface LifecycleConfig {
  min_daily_growth: number;
  max_stale_days: number;
  min_total_stars: number;
  batch_size: number;
}

/**
 * Calculate growth metrics for repositories
 */
async function calculateGrowthMetrics(
  supabaseUrl: string,
  supabaseKey: string,
  config: LifecycleConfig
): Promise<RepoGrowthMetrics[]> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Query to calculate growth metrics using SQL
  const { data, error } = await supabase.rpc('calculate_repo_growth_metrics', {
    p_min_total_stars: config.min_total_stars,
    p_max_stale_days: config.max_stale_days
  });
  
  if (error) {
    // Fallback to manual calculation if stored procedure doesn't exist
    console.warn('Stored procedure not found, using manual calculation');
    return await calculateGrowthMetricsManual(supabaseUrl, supabaseKey, config);
  }
  
  return data || [];
}

/**
 * Manual calculation of growth metrics (fallback)
 */
async function calculateGrowthMetricsManual(
  supabaseUrl: string,
  supabaseKey: string,
  config: LifecycleConfig
): Promise<RepoGrowthMetrics[]> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Get all active repos with their latest and previous snapshots
  const { data: repos, error } = await supabase
    .from('repos')
    .select(`
      id,
      full_name,
      is_active,
      snapshots (
        stars,
        forks,
        recorded_at
      )
    `)
    .eq('is_active', true)
    .order('id');
  
  if (error) {
    throw new Error(`Failed to fetch repos: ${error.message}`);
  }
  
  const metrics: RepoGrowthMetrics[] = [];
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  for (const repo of repos || []) {
    const snapshots = (repo.snapshots as any[])
      .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
    
    if (snapshots.length < 2) {
      continue; // Need at least 2 snapshots to calculate growth
    }
    
    const latest = snapshots[0];
    const previous = snapshots[1];
    
    // Find snapshot from ~24h ago
    const dayOldSnapshot = snapshots.find(s => 
      new Date(s.recorded_at) <= oneDayAgo
    ) || previous;
    
    const daily_star_growth = latest.stars - dayOldSnapshot.stars;
    const daily_fork_growth = latest.forks - dayOldSnapshot.forks;
    
    // Calculate days since last meaningful growth
    let days_since_last_growth = 0;
    for (let i = 1; i < snapshots.length; i++) {
      const current = snapshots[i - 1];
      const prev = snapshots[i];
      
      if (current.stars - prev.stars >= config.min_daily_growth) {
        break;
      }
      
      const daysDiff = Math.floor(
        (new Date(current.recorded_at).getTime() - new Date(prev.recorded_at).getTime()) 
        / (24 * 60 * 60 * 1000)
      );
      days_since_last_growth += daysDiff;
      
      if (days_since_last_growth >= config.max_stale_days) {
        break;
      }
    }
    
    metrics.push({
      repo_id: repo.id,
      full_name: repo.full_name,
      daily_star_growth,
      daily_fork_growth,
      total_stars: latest.stars,
      total_forks: latest.forks,
      days_since_last_growth,
      is_active: repo.is_active
    });
  }
  
  return metrics;
}

/**
 * Deactivate stale repositories
 */
async function deactivateStaleRepos(
  supabaseUrl: string,
  supabaseKey: string,
  staleRepos: RepoGrowthMetrics[]
): Promise<number> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  if (staleRepos.length === 0) {
    return 0;
  }
  
  const staleRepoIds = staleRepos.map(r => r.repo_id);
  
  const { error } = await supabase
    .from('repos')
    .update({ is_active: false })
    .in('id', staleRepoIds);
  
  if (error) {
    throw new Error(`Failed to deactivate repos: ${error.message}`);
  }
  
  console.log(`Deactivated ${staleRepos.length} stale repos:`, 
    staleRepos.map(r => r.full_name));
  
  return staleRepos.length;
}

/**
 * Reactivate trending repositories that were previously deactivated
 */
async function reactivateTrendingRepos(
  supabaseUrl: string,
  supabaseKey: string
): Promise<number> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Find inactive repos that appeared in trending within the last 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  
  const { data: trendingRepos, error } = await supabase
    .from('trending_discoveries')
    .select(`
      repo_id,
      repos (
        id,
        full_name,
        is_active
      )
    `)
    .gte('discovered_at', threeDaysAgo.toISOString())
    .eq('repos.is_active', false);
  
  if (error) {
    throw new Error(`Failed to fetch recent trending repos: ${error.message}`);
  }
  
  if (!trendingRepos || trendingRepos.length === 0) {
    return 0;
  }
  
  const repoIds = trendingRepos.map(tr => tr.repo_id);
  
  const { error: updateError } = await supabase
    .from('repos')
    .update({ is_active: true })
    .in('id', repoIds);
  
  if (updateError) {
    throw new Error(`Failed to reactivate trending repos: ${updateError.message}`);
  }
  
  console.log(`Reactivated ${repoIds.length} recently trending repos`);
  
  return repoIds.length;
}

Deno.serve(async (req: Request) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }
    
    // Parse configuration from request
    const url = new URL(req.url);
    const config: LifecycleConfig = {
      min_daily_growth: parseInt(url.searchParams.get('min_daily_growth') || '2'),
      max_stale_days: parseInt(url.searchParams.get('max_stale_days') || '7'),
      min_total_stars: parseInt(url.searchParams.get('min_total_stars') || '10'),
      batch_size: parseInt(url.searchParams.get('batch_size') || '100')
    };
    
    console.log('Starting repo lifecycle management with config:', config);
    
    // Calculate growth metrics
    const metrics = await calculateGrowthMetrics(supabaseUrl, supabaseKey, config);
    console.log(`Analyzed ${metrics.length} repositories`);
    
    // Find stale repositories
    const staleRepos = metrics.filter(m => 
      m.is_active && 
      m.days_since_last_growth >= config.max_stale_days &&
      m.daily_star_growth < config.min_daily_growth &&
      m.total_stars >= config.min_total_stars
    );
    
    // Find high-growth repositories that should remain active
    const activeRepos = metrics.filter(m =>
      m.is_active &&
      (m.daily_star_growth >= config.min_daily_growth || 
       m.days_since_last_growth < config.max_stale_days)
    );
    
    // Deactivate stale repos
    const deactivatedCount = await deactivateStaleRepos(supabaseUrl, supabaseKey, staleRepos);
    
    // Reactivate recently trending repos
    const reactivatedCount = await reactivateTrendingRepos(supabaseUrl, supabaseKey);
    
    const summary = {
      total_analyzed: metrics.length,
      active_repos: activeRepos.length,
      stale_repos: staleRepos.length,
      deactivated: deactivatedCount,
      reactivated: reactivatedCount,
      config
    };
    
    console.log('Lifecycle management summary:', summary);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      summary,
      stale_repos: staleRepos.map(r => ({
        full_name: r.full_name,
        total_stars: r.total_stars,
        daily_growth: r.daily_star_growth,
        days_stale: r.days_since_last_growth
      }))
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      }
    });
    
  } catch (error) {
    console.error('Repo lifecycle error:', error);
    
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