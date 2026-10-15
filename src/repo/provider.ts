/** Read-only access to the repository at the revision under review. Paths are repo-relative with '/' separators. */
export interface RepoFileProvider {
  /** Source files the impact analyzer can parse. */
  listFiles(): Promise<string[]>;
  /** File content, or null when missing, too large, or outside the repository. */
  readFile(path: string): Promise<string | null>;
  /** Identifies the revision (commit sha when known) so results can be cached. */
  repoHash(): Promise<string>;
  /** Project review-rule documents (`.review/*.md`, `.github/code-review.md`). */
  listRuleFiles(): Promise<{ path: string; content: string }[]>;
  cleanup?(): Promise<void>;
}
