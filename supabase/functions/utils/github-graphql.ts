/**
 * Shared GitHub GraphQL utility for batched API requests
 * Reduces API calls by fetching up to 100 repositories per request
 */

interface GraphQLResponse<T> {
  data: { [key: string]: T | null };
  errors?: Array<{ message: string; path?: string[] }>;
}

/**
 * Retry a fetch operation with exponential backoff
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // If we get a temporary error, retry
      if (attempt < maxRetries && (response.status === 502 || response.status === 504 || response.status === 503)) {
        const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`GitHub API returned ${response.status}, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(`Network error, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1}):`, error);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
    }
  }

  throw lastError!;
}

/**
 * Update repository fetch status in database based on API results
 */
async function updateRepoFetchStatus(
  supabase: any,
  fullName: string,
  status: 'fetchable' | 'not_found' | 'access_denied' | 'server_error',
  error?: string
): Promise<void> {
  try {
    const updates: any = {
      fetch_status: status,
      last_fetch_attempt: new Date().toISOString(),
      last_fetch_error: error || null
    };

    if (status === 'fetchable') {
      // Reset failure count on success
      updates.fetch_failure_count = 0;
      updates.next_retry_after = null;
    } else {
      // Increment failure count and set retry backoff
      const { data: currentRepo } = await supabase
        .from('repos')
        .select('fetch_failure_count')
        .eq('full_name', fullName)
        .single();

      const failureCount = (currentRepo?.fetch_failure_count || 0) + 1;
      updates.fetch_failure_count = failureCount;

      // Exponential backoff: 1 hour, 6 hours, 24 hours, 7 days, then permanent
      const backoffHours = failureCount >= 4 ? 24 * 7 : Math.pow(2, failureCount - 1);
      if (failureCount < 5) {
        updates.next_retry_after = new Date(Date.now() + backoffHours * 60 * 60 * 1000).toISOString();
        updates.fetch_status = 'retry_later';
      }
    }

    await supabase
      .from('repos')
      .update(updates)
      .eq('full_name', fullName);

  } catch (dbError) {
    console.warn(`Failed to update fetch status for ${fullName}:`, dbError);
  }
}

export async function fetchReposBatched<T = any>(
  fullNames: string[],
  githubToken: string,
  fields: string,
  supabase?: any
): Promise<(T | null)[]> {
  if (fullNames.length === 0) return [];

    const batchSize = 100;
  const results: (T | null)[] = [];

  // Create a map to track results for all repos
  const resultMap = new Map<string, T | null>();

  for (let i = 0; i < fullNames.length; i += batchSize) {
    const batch = fullNames.slice(i, i + batchSize);

    // Build GraphQL query with aliases for each repo
    let query = 'query {';
    batch.forEach((fullName, index) => {
      const [owner, name] = fullName.split('/');
      if (!owner || !name) {
        console.warn(`Invalid repo format: ${fullName}`);
        return;
      }

      // Escape special characters in owner/name
      const escapedOwner = owner.replace(/"/g, '\\"');
      const escapedName = name.replace(/"/g, '\\"');

      query += `
        repo${index}: repository(owner: "${escapedOwner}", name: "${escapedName}") {
          ${fields}
        }
      `;
    });
    query += '}';

    try {
      const response = await fetchWithRetry('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'User-Agent': 'GitHubTrendsBot/1.0',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`GraphQL API error ${response.status}: ${errorText}`);
        batch.forEach(fullName => resultMap.set(fullName, null));
        continue;
      }

      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const errorText = await response.text();
        console.error(`GraphQL API returned non-JSON response: ${errorText}`);
        batch.forEach(fullName => resultMap.set(fullName, null));
        continue;
      }

      let json: GraphQLResponse<T>;
      try {
        json = await response.json();
      } catch (parseError) {
        console.error(`Failed to parse GraphQL response as JSON:`, parseError);
        batch.forEach(fullName => resultMap.set(fullName, null));
        continue;
      }

      if (json.errors) {
        console.error('GraphQL errors:', json.errors);
        // Still process successful results, just log errors
      }

      // Process results for this batch
      batch.forEach((fullName, index) => {
        const data = json.data?.[`repo${index}`];
        if (data) {
          resultMap.set(fullName, data);
          // Mark as successfully fetchable
          if (supabase) {
            updateRepoFetchStatus(supabase, fullName, 'fetchable').catch(err =>
              console.warn(`Failed to update status for ${fullName}:`, err)
            );
          }
        } else {
          console.warn(`No data returned for repo: ${fullName}`);
          resultMap.set(fullName, null);

          // Check if this was a NOT_FOUND error specifically
          const repoError = json.errors?.find(err =>
            err.path?.includes(`repo${index}`) && err.message?.includes('Could not resolve to a Repository')
          );

          if (repoError && supabase) {
            updateRepoFetchStatus(supabase, fullName, 'not_found', repoError.message).catch(err =>
              console.warn(`Failed to update status for ${fullName}:`, err)
            );
          }
        }
      });

    } catch (error) {
      console.error(`Failed GraphQL batch fetch (batch ${Math.floor(i / batchSize) + 1}):`, error);
      batch.forEach(fullName => {
        resultMap.set(fullName, null);
        // Mark as server error for retry later
        if (supabase) {
          updateRepoFetchStatus(supabase, fullName, 'server_error', error.message).catch(err =>
            console.warn(`Failed to update status for ${fullName}:`, err)
          );
        }
      });
    }

    // Rate limiting: wait between batches
    if (i + batchSize < fullNames.length) {
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }

  // Build final results array in original order
  const finalResults = fullNames.map(fullName => resultMap.get(fullName) || null);

  console.log(`GraphQL batch fetch completed: ${finalResults.filter(r => r !== null).length}/${fullNames.length} successful`);
  return finalResults;
}
