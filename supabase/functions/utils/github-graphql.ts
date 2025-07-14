import { GitHubRepoStats } from '../snapshot-collector/index.ts';  // Adjust types as needed

type GraphQLFields = string;

interface GraphQLResponse<T> {
  data: { [key: string]: T | null };
  errors?: Array<{ message: string }>;
}

export async function fetchReposBatched<T>(
  fullNames: string[],
  githubToken: string,
  fields: GraphQLFields
): Promise<(T | null)[]> {
  // ... (implement batching logic here, similar to previous getReposFromGitHubBatched, but generic with dynamic fields)
  // Build query using 'fields'
  // Map results to T
}
