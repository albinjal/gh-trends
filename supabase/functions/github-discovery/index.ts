import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Extract GitHub repository URLs from HTML content
 */
function extractGitHubRepoUrls(html: string): string[] {
  const repoPattern = /github\.com\/([a-zA-Z0-9][-a-zA-Z0-9]*\/[a-zA-Z0-9][-a-zA-Z0-9._]*)/g;
  const matches = [...html.matchAll(repoPattern)];
  const repos = new Set<string>();

  matches.forEach(match => {
    const fullName = match[1];
    const parts = fullName.split('/');

    if (parts.length === 2 &&
        parts[0].length > 0 &&
        parts[1].length > 0 &&
        !fullName.includes('/settings') &&
        !fullName.includes('/orgs') &&
        !fullName.includes('/users') &&
        !fullName.includes('.')) {
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
      const stubs = newRepoUrls.map(url => ({
        full_name: url,
        discovered_at: new Date().toISOString(),
        discovery_context: repoContexts.get(url) || {}
      }));

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
