/**
 * Shared GitHub GraphQL utility for batched API requests
 * Reduces API calls by fetching up to 100 repositories per request
 */

interface GraphQLResponse<T> {
  data: { [key: string]: T | null };
  errors?: Array<{ message: string; path?: string[] }>;
}

export async function fetchReposBatched<T = any>(
  fullNames: string[],
  githubToken: string,
  fields: string
): Promise<(T | null)[]> {
  if (fullNames.length === 0) return [];

  const batchSize = 100;
  const results: (T | null)[] = [];

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
      const response = await fetch('https://api.github.com/graphql', {
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
        batch.forEach(() => results.push(null));
        continue;
      }

      const json: GraphQLResponse<T> = await response.json();

      if (json.errors) {
        console.error('GraphQL errors:', json.errors);
        // Still process successful results, just log errors
      }

      // Process results for this batch
      batch.forEach((fullName, index) => {
        const data = json.data?.[`repo${index}`];
        if (data) {
          results.push(data);
        } else {
          console.warn(`No data returned for repo: ${fullName}`);
          results.push(null);
        }
      });

    } catch (error) {
      console.error(`Failed GraphQL batch fetch (batch ${Math.floor(i / batchSize) + 1}):`, error);
      batch.forEach(() => results.push(null));
    }

    // Rate limiting: wait between batches
    if (i + batchSize < fullNames.length) {
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }

  console.log(`GraphQL batch fetch completed: ${results.filter(r => r !== null).length}/${fullNames.length} successful`);
  return results;
}
