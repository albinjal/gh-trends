import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ========== INTERFACES ==========

interface DiscoveredRepo {
  full_name: string;
  owner: string;
  name: string;
  language: string | null;
  description: string | null;
  homepage: string | null;
  context: Record<string, any>; // rank, period, topic, etc.
}

interface DiscoveryModule {
  name: string;
  source_id: number;
  discover(): Promise<DiscoveredRepo[]>;
  rateLimitDelay: number;
}

interface DiscoveryResult {
  source_name: string;
  discovered: number;
  inserted: number;
  existing: number;
  errors: string[];
}

// ========== DISCOVERY MODULES ==========

/**
 * GitHub Trending Discovery Module
 * Enhanced version that covers multiple periods and languages
 */
class GitHubTrendingModule implements DiscoveryModule {
  name = 'github_trending';
  source_id = 1;
  rateLimitDelay = 2000; // 2 seconds between requests

  async discover(): Promise<DiscoveredRepo[]> {
    const repos: DiscoveredRepo[] = [];
    
    // Multiple periods and top languages
    const periods: ('daily' | 'weekly' | 'monthly')[] = ['daily', 'weekly', 'monthly'];
    const languages = ['', 'javascript', 'python', 'typescript', 'rust', 'go', 'java', 'cpp', 'c'];
    
    for (const period of periods) {
      for (const language of languages) {
        try {
          console.log(`Fetching trending: ${period}/${language || 'all'}`);
          
          const periodRepos = await this.fetchTrendingRepos(period, language);
          repos.push(...periodRepos);
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        } catch (error) {
          console.error(`Failed to fetch trending ${period}/${language}:`, error);
        }
      }
    }
    
    return repos;
  }

  private async fetchTrendingRepos(
    period: 'daily' | 'weekly' | 'monthly',
    language?: string
  ): Promise<DiscoveredRepo[]> {
    const params = new URLSearchParams();
    if (period !== 'daily') params.set('since', period);
    if (language) params.set('l', language);
    
    const url = `https://github.com/trending?${params.toString()}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GitHubTrendsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    if (!response.ok) {
      throw new Error(`GitHub trending fetch failed: ${response.status}`);
    }
    
    const html = await response.text();
    return this.parseTrendingRepos(html, period, language);
  }

  private parseTrendingRepos(
    html: string, 
    period: string, 
    language?: string
  ): DiscoveredRepo[] {
    const repos: DiscoveredRepo[] = [];
    const repoPattern = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>(.*?)<\/article>/gs;
    const repoMatches = html.match(repoPattern) || [];
    
    repoMatches.forEach((repoHtml, index) => {
      try {
        const nameMatch = repoHtml.match(/href="\/([^/]+\/[^"]+)"[^>]*class="Link"/s);
        if (!nameMatch) return;
        
        const full_name = nameMatch[1].trim();
        const [owner, name] = full_name.split('/');
        
        if (!owner || !name) return;
        
        const langMatch = repoHtml.match(/<span[^>]*itemprop="programmingLanguage"[^>]*>([^<]+)<\/span>/);
        const repoLanguage = langMatch ? langMatch[1].trim() : null;
        
        const descMatch = repoHtml.match(/<p[^>]*class="[^"]*col-9[^"]*color-fg-muted[^"]*"[^>]*>\s*([^<]+)/s);
        const description = descMatch ? descMatch[1].trim() : null;
        
        repos.push({
          full_name,
          owner,
          name,
          language: repoLanguage,
          description,
          homepage: null,
          context: {
            period,
            rank: index + 1,
            trending_language: language || null,
            source_detail: 'github_trending'
          }
        });
      } catch (error) {
        console.warn(`Failed to parse trending repo at index ${index}:`, error);
      }
    });
    
    return repos;
  }
}

/**
 * GitHub Explore Discovery Module
 */
class GitHubExploreModule implements DiscoveryModule {
  name = 'github_explore';
  source_id = 2;
  rateLimitDelay = 3000; // 3 seconds

  async discover(): Promise<DiscoveredRepo[]> {
    const repos: DiscoveredRepo[] = [];
    
    try {
      console.log('Fetching GitHub Explore page...');
      
      const response = await fetch('https://github.com/explore', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GitHubTrendsBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      });
      
      if (!response.ok) {
        throw new Error(`GitHub explore fetch failed: ${response.status}`);
      }
      
      const html = await response.text();
      repos.push(...this.parseExploreRepos(html));
      
    } catch (error) {
      console.error('Failed to fetch GitHub explore:', error);
    }
    
    return repos;
  }

  private parseExploreRepos(html: string): DiscoveredRepo[] {
    const repos: DiscoveredRepo[] = [];
    
    // Look for repository links in explore page
    const repoLinkPattern = /href="\/([^/]+\/[^"]+)"/g;
    const matches = [...html.matchAll(repoLinkPattern)];
    
    const seenRepos = new Set<string>();
    
    matches.forEach((match, index) => {
      try {
        const full_name = match[1];
        
        // Filter out non-repo links (settings, orgs, etc.)
        if (full_name.includes('/settings') || 
            full_name.includes('/orgs') || 
            full_name.includes('/users') ||
            full_name.split('/').length !== 2) {
          return;
        }
        
        // Avoid duplicates
        if (seenRepos.has(full_name)) return;
        seenRepos.add(full_name);
        
        const [owner, name] = full_name.split('/');
        
        if (!owner || !name || owner.length < 2 || name.length < 2) return;
        
        repos.push({
          full_name,
          owner,
          name,
          language: null, // Will be filled by snapshot collector
          description: null, // Will be filled by snapshot collector
          homepage: null,
          context: {
            source_detail: 'github_explore',
            explore_section: 'featured'
          }
        });
      } catch (error) {
        console.warn(`Failed to parse explore repo at index ${index}:`, error);
      }
    });
    
    return repos.slice(0, 50); // Limit to first 50 discovered repos
  }
}

/**
 * GitHub Search Discovery Module
 * Uses search API to find trending repositories
 */
class GitHubSearchModule implements DiscoveryModule {
  name = 'github_search';
  source_id = 3;
  rateLimitDelay = 4000; // 4 seconds - search API has stricter limits

  async discover(): Promise<DiscoveredRepo[]> {
    const repos: DiscoveredRepo[] = [];
    
    // Trending keywords and technologies
    const searchTerms = [
      'AI', 'machine learning', 'neural network', 'LLM', 'ChatGPT',
      'blockchain', 'cryptocurrency', 'web3', 'defi',
      'react', 'vue', 'angular', 'nextjs', 'svelte',
      'kubernetes', 'docker', 'microservices', 'serverless',
      'rust', 'go', 'typescript', 'python', 'wasm',
      'game engine', 'cli tool', 'framework', 'library'
    ];
    
    for (const term of searchTerms.slice(0, 10)) { // Limit to first 10 to respect rate limits
      try {
        console.log(`Searching for: ${term}`);
        
        const termRepos = await this.searchRepositories(term);
        repos.push(...termRepos);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
      } catch (error) {
        console.error(`Failed to search for "${term}":`, error);
      }
    }
    
    return repos;
  }

  private async searchRepositories(searchTerm: string): Promise<DiscoveredRepo[]> {
    // Use GitHub's search without API (scraping search results)
    const query = encodeURIComponent(`${searchTerm} sort:updated`);
    const url = `https://github.com/search?q=${query}&type=repositories`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GitHubTrendsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    
    if (!response.ok) {
      throw new Error(`GitHub search failed: ${response.status}`);
    }
    
    const html = await response.text();
    return this.parseSearchResults(html, searchTerm);
  }

  private parseSearchResults(html: string, searchTerm: string): DiscoveredRepo[] {
    const repos: DiscoveredRepo[] = [];
    
    // Look for repository links in search results
    const repoPattern = /href="\/([^/]+\/[^"]+)"/g;
    const matches = [...html.matchAll(repoPattern)];
    
    const seenRepos = new Set<string>();
    
    matches.forEach((match, index) => {
      try {
        const full_name = match[1];
        
        // Filter out non-repo links
        if (full_name.includes('/') && 
            full_name.split('/').length === 2 &&
            !full_name.includes('/settings') &&
            !full_name.includes('/orgs')) {
          
          if (seenRepos.has(full_name)) return;
          seenRepos.add(full_name);
          
          const [owner, name] = full_name.split('/');
          
          if (owner && name && owner.length > 1 && name.length > 1) {
            repos.push({
              full_name,
              owner,
              name,
              language: null,
              description: null,
              homepage: null,
              context: {
                search_term: searchTerm,
                source_detail: 'github_search'
              }
            });
          }
        }
      } catch (error) {
        console.warn(`Failed to parse search result at index ${index}:`, error);
      }
    });
    
    return repos.slice(0, 20); // Limit to first 20 per search term
  }
}

// ========== DISCOVERY ORCHESTRATOR ==========

/**
 * Store discovered repositories and create discovery events
 */
async function storeDiscoveredRepos(
  supabaseUrl: string,
  supabaseKey: string,
  repos: DiscoveredRepo[],
  sourceId: number
): Promise<{ inserted: number; existing: number; errors: string[] }> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  let inserted = 0;
  let existing = 0;
  const errors: string[] = [];
  
  for (const repo of repos) {
    try {
      // Check if repo already exists
      const { data: existingRepo } = await supabase
        .from('repos')
        .select('id')
        .eq('full_name', repo.full_name)
        .single();
      
      let repoId: number;
      
      if (existingRepo) {
        repoId = existingRepo.id;
        existing++;
      } else {
        // Insert new repo
        const { data: newRepo, error: insertError } = await supabase
          .from('repos')
          .insert({
            full_name: repo.full_name,
            owner: repo.owner,
            name: repo.name,
            language: repo.language,
            description: repo.description,
            homepage: repo.homepage,
            is_active: true
          })
          .select('id')
          .single();
        
        if (insertError) throw insertError;
        repoId = newRepo.id;
        inserted++;
      }
      
      // Create discovery event
      const { error: discoveryError } = await supabase
        .from('discovery_events')
        .insert({
          repo_id: repoId,
          source_id: sourceId,
          discovery_context: repo.context
        });
      
      if (discoveryError) {
        console.warn(`Failed to record discovery for ${repo.full_name}:`, discoveryError);
        errors.push(`Discovery event failed for ${repo.full_name}: ${discoveryError.message}`);
      }
      
    } catch (error) {
      console.error(`Failed to process repo ${repo.full_name}:`, error);
      errors.push(`Processing failed for ${repo.full_name}: ${error.message}`);
    }
  }
  
  return { inserted, existing, errors };
}

/**
 * Main discovery orchestrator function
 */
Deno.serve(async (req: Request) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }

    // Parse request parameters
    const url = new URL(req.url);
    const enabledSources = url.searchParams.get('sources')?.split(',') || [
      'github_trending', 
      'github_explore', 
      'github_search'
    ];
    
    console.log(`Starting discovery with sources: ${enabledSources.join(', ')}`);

    // Initialize discovery modules
    const modules: DiscoveryModule[] = [];
    
    if (enabledSources.includes('github_trending')) {
      modules.push(new GitHubTrendingModule());
    }
    if (enabledSources.includes('github_explore')) {
      modules.push(new GitHubExploreModule());
    }
    if (enabledSources.includes('github_search')) {
      modules.push(new GitHubSearchModule());
    }

    const results: DiscoveryResult[] = [];

    // Run discovery modules
    for (const module of modules) {
      try {
        console.log(`Running discovery module: ${module.name}`);
        
        const startTime = Date.now();
        const discoveredRepos = await module.discover();
        const discoveryTime = Date.now() - startTime;
        
        console.log(`${module.name} discovered ${discoveredRepos.length} repos in ${discoveryTime}ms`);

        // Store discovered repositories
        const storeResult = await storeDiscoveredRepos(
          supabaseUrl, 
          supabaseKey, 
          discoveredRepos, 
          module.source_id
        );

        results.push({
          source_name: module.name,
          discovered: discoveredRepos.length,
          inserted: storeResult.inserted,
          existing: storeResult.existing,
          errors: storeResult.errors
        });

        // Rate limiting between modules
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.error(`Discovery module ${module.name} failed:`, error);
        results.push({
          source_name: module.name,
          discovered: 0,
          inserted: 0,
          existing: 0,
          errors: [error.message]
        });
      }
    }

    // Calculate totals
    const totals = results.reduce((acc, result) => ({
      discovered: acc.discovered + result.discovered,
      inserted: acc.inserted + result.inserted,
      existing: acc.existing + result.existing,
      errors: acc.errors + result.errors.length
    }), { discovered: 0, inserted: 0, existing: 0, errors: 0 });

    console.log(`Discovery complete: ${totals.discovered} discovered, ${totals.inserted} new, ${totals.existing} existing`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      totals,
      results
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      }
    });

  } catch (error) {
    console.error('Discovery orchestrator error:', error);
    
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