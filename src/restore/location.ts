/** 1-based line range a parsed statement's SQL text occupies in its source. */
export interface StatementSourceLocation {
  readonly startLine: number;
  readonly endLine: number;
}
