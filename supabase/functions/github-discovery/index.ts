import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Extract GitHub repository URLs from HTML content
 */
function extractGitHubRepoUrls(html: string): string[] {
  // Pattern for full github.com URLs
  const fullUrlPattern = /github\.com\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;

  // Pattern for relative GitHub URLs (since we're on github.com already)
  const relativeUrlPattern = /href=["']\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;

  // Additional specific patterns for trending pages
  const trendingLinkPattern = /<a[^>]*href=["']\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;
  const exploreRepoPattern = /data-hovercard-url="\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;

  const repos = new Set<string>();

  // Extract from all patterns
  const patterns = [fullUrlPattern, relativeUrlPattern, trendingLinkPattern, exploreRepoPattern];

  patterns.forEach(pattern => {
    const matches = [...html.matchAll(pattern)];
    matches.forEach(match => {
      const fullName = match[1];
      if (isValidRepoName(fullName)) {
        repos.add(fullName);
      }
    });
  });

  return Array.from(repos);
}

/**
 * Validate if a repo name looks legitimate
 */
function isValidRepoName(fullName: string): boolean {
  const parts = fullName.split('/');

  if (parts.length !== 2) return false;

  const [owner, repo] = parts;

  // Basic validation
  if (owner.length === 0 || repo.length === 0) return false;

  // Exclude common non-repo paths
  const excludePatterns = [
    '/settings', '/orgs', '/users', '/search', '/login', '/signup',
    '/notifications', '/security', '/about', '/pricing', '/features',
    '/enterprise', '/team', '/contact', '/help', '/docs', '/blog',
    '/explore', '/trending', '/collections', '/topics', '/marketplace',
    '/sponsors', '/advisories', '/pulls', '/issues', '/actions',
    '/projects', '/wiki', '/releases', '/tags', '/branches', '/commits'
  ];

  const fullPath = `/${fullName}`;
  if (excludePatterns.some(pattern => fullPath.includes(pattern))) {
    return false;
  }

  // Exclude if contains dots (likely file extensions or subdomains)
  if (fullName.includes('.') && !repo.endsWith('.git')) {
    return false;
  }

  return true;
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

    // Log a sample of the HTML to debug
    console.log(`HTML sample from ${url}:`);
    console.log('First 1000 chars:', html.substring(0, 1000));

    // Look for specific patterns in trending pages
    if (url.includes('trending')) {
      const trendingRepoPattern = /<h2[^>]*class="[^"]*h3[^"]*"[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>/g;
      console.log('Trending repo patterns found:', [...html.matchAll(trendingRepoPattern)].length);
    }

    const repos = extractGitHubRepoUrls(html);

    console.log(`Found ${repos.length} repos on ${url}: ${repos.slice(0, 5).join(', ')}${repos.length > 5 ? '...' : ''}`);
    return { repos, context };

  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return { repos: [], context };
  }
}

/**
 * Main discovery function - API-free scraping that creates repo stubs
 */
Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }

    // Import Supabase client
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const scrapeTargets = [
      { url: 'https://github.com/trending', context: { source: 'trending', period: 'daily' } },
      { url: 'https://github.com/trending?since=weekly', context: { source: 'trending', period: 'weekly' } },
      { url: 'https://github.com/trending?since=monthly', context: { source: 'trending', period: 'monthly' } },
      { url: 'https://github.com/explore', context: { source: 'explore' } },
    ];

    console.log('Starting GitHub discovery...');

    // Scrape all target pages
    const allRepoUrls = new Set<string>();
    const repoContexts = new Map<string, Record<string, any>>();

    for (const target of scrapeTargets) {
      const result = await scrapePage(target.url, target.context);

      result.repos.forEach(repoUrl => {
        allRepoUrls.add(repoUrl);
        repoContexts.set(repoUrl, result.context);
      });

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`Found ${allRepoUrls.size} unique repos across all sources`);

    // Check which repos already exist in database
    const repoArray = Array.from(allRepoUrls);
    const { data: existingRepos, error } = await supabase
      .from('repos')
      .select('full_name')
      .in('full_name', repoArray);

    if (error) {
      console.error('Failed to check existing repos:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    const existingRepoNames = new Set(existingRepos?.map(row => row.full_name) || []);
    const newRepoUrls = repoArray.filter(repoUrl => !existingRepoNames.has(repoUrl));
    const skippedCount = repoArray.length - newRepoUrls.length;

    console.log(`${newRepoUrls.length} new repos to add as stubs, ${skippedCount} already exist`);

    // Insert new repo stubs
    let insertedCount = 0;
    let errorCount = 0;

    if (newRepoUrls.length > 0) {
      const stubs = newRepoUrls.map(fullName => {
        const [owner, name] = fullName.split('/');
        return {
          full_name: fullName,
          owner: owner,
          name: name,
          discovered_at: new Date().toISOString(),
          discovery_context: repoContexts.get(fullName) || {}
        };
      });

      const { error: insertError } = await supabase
        .from('repos')
        .insert(stubs);

      if (insertError) {
        console.error('Failed to insert stubs:', insertError);
        errorCount = stubs.length;
      } else {
        insertedCount = stubs.length;
        console.log(`Successfully inserted ${insertedCount} repo stubs`);
      }
    }

    console.log(`Discovery complete: ${insertedCount} stubs inserted, ${errorCount} errors`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      stats: {
        pages_scraped: scrapeTargets.length,
        unique_repos_found: allRepoUrls.size,
        existing_repos_skipped: skippedCount,
        new_stubs_added: insertedCount,
        api_calls_made: 0,
        inserted: insertedCount,
        errors: errorCount
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
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
