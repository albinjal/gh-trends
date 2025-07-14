import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface TrendingRepo {
  full_name: string;
  owner: string;
  name: string;
  language: string | null;
  description: string | null;
  homepage: string | null;
  rank: number;
}

interface DiscoveryResult {
  period: 'daily' | 'weekly' | 'monthly';
  language: string | null;
  repos: TrendingRepo[];
}

/**
 * Parse GitHub trending page HTML to extract repository information
 */
function parseTrendingRepos(html: string): TrendingRepo[] {
  const repos: TrendingRepo[] = [];
  
  // Extract repo items using updated regex patterns for new GitHub structure
  const repoPattern = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>(.*?)<\/article>/gs;
  const repoMatches = html.match(repoPattern) || [];
  
  console.log(`Found ${repoMatches.length} repository articles`);
  
  repoMatches.forEach((repoHtml, index) => {
    try {
      // Extract repo full name from href within h2 section
      // Pattern: href="/owner/repo" inside h2 > a tag
      const nameMatch = repoHtml.match(/href="\/([^/]+\/[^"]+)"[^>]*class="Link"/s);
      if (!nameMatch) {
        console.warn(`No repo link found in article ${index}`);
        return;
      }
      
      const full_name = nameMatch[1].trim();
      const [owner, name] = full_name.split('/');
      
      if (!owner || !name) {
        console.warn(`Invalid repo name format: ${full_name}`);
        return;
      }
      
      // Extract language from itemprop="programmingLanguage"
      const langMatch = repoHtml.match(/<span[^>]*itemprop="programmingLanguage"[^>]*>([^<]+)<\/span>/);
      const language = langMatch ? langMatch[1].trim() : null;
      
      // Extract description from p tag with col-9 class
      const descMatch = repoHtml.match(/<p[^>]*class="[^"]*col-9[^"]*color-fg-muted[^"]*"[^>]*>\s*([^<]+)/s);
      const description = descMatch ? descMatch[1].trim() : null;
      
      console.log(`Parsed repo ${index + 1}: ${full_name} (${language || 'unknown'})`);
      
      repos.push({
        full_name,
        owner,
        name,
        language,
        description,
        homepage: null, // Will be filled by snapshot collector
        rank: index + 1
      });
    } catch (error) {
      console.warn(`Failed to parse repo at index ${index}:`, error);
    }
  });
  
  console.log(`Successfully parsed ${repos.length} repositories`);
  return repos;
}

/**
 * Fetch trending repositories for a specific period and language
 */
async function fetchTrendingRepos(
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  language?: string
): Promise<DiscoveryResult> {
  const params = new URLSearchParams();
  if (period !== 'daily') params.set('since', period);
  if (language) params.set('l', language);
  
  const url = `https://github.com/trending?${params.toString()}`;
  
  try {
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
    const repos = parseTrendingRepos(html);
    
    return {
      period,
      language: language || null,
      repos
    };
  } catch (error) {
    console.error(`Failed to fetch trending repos for ${period}/${language}:`, error);
    throw error;
  }
}

/**
 * Store discovered repositories in the database
 */
async function storeDiscoveredRepos(
  supabaseUrl: string,
  supabaseKey: string,
  result: DiscoveryResult
): Promise<{ inserted: number; existing: number }> {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  let inserted = 0;
  let existing = 0;
  
  for (const repo of result.repos) {
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
      
      // Record the trending discovery
      const { error: discoveryError } = await supabase
        .from('trending_discoveries')
        .insert({
          repo_id: repoId,
          period: result.period,
          rank: repo.rank,
          language: result.language
        });
      
      if (discoveryError) {
        console.warn(`Failed to record discovery for ${repo.full_name}:`, discoveryError);
      }
      
    } catch (error) {
      console.error(`Failed to process repo ${repo.full_name}:`, error);
    }
  }
  
  return { inserted, existing };
}

Deno.serve(async (req: Request) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }
    
    // Parse request for specific periods/languages
    const url = new URL(req.url);
    const periods = url.searchParams.get('periods')?.split(',') || ['daily'];
    const languages = url.searchParams.get('languages')?.split(',') || ['']; // Empty string = all languages
    
    const results = [];
    
    // Fetch trending repos for each period/language combination
    for (const period of periods) {
      for (const language of languages) {
        try {
          console.log(`Fetching trending repos: ${period}/${language || 'all'}`);
          
          const result = await fetchTrendingRepos(
            period as 'daily' | 'weekly' | 'monthly',
            language || undefined
          );
          
          const stats = await storeDiscoveredRepos(supabaseUrl, supabaseKey, result);
          
          results.push({
            period,
            language: language || 'all',
            discovered: result.repos.length,
            ...stats
          });
          
          // Rate limiting: small delay between requests
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`Failed to process ${period}/${language}:`, error);
          results.push({
            period,
            language: language || 'all',
            error: error.message
          });
        }
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      results
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      }
    });
    
  } catch (error) {
    console.error('Trending scraper error:', error);
    
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