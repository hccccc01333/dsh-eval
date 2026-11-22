/**
 * Shared case-id to temp-directory-segment normalization.
 *
 * The runner uses this to name each trial's private directory (and its replay
 * fixture); the benchmark loader uses the same function to reject ids that
 * would collapse onto one segment. One implementation keeps validation from
 * drifting away from the directories it protects.
 *
 * @module dsh-eval/segments
 */

/** Reduce a case id to one safe temp-directory segment. */
export function caseSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '')
  return safe === '' ? 'case' : safe
}
