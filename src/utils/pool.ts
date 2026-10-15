/**
 * Like Promise.all over items.map(fn), but with at most `limit` calls in flight. Preserves order.
 * On the first rejection no further items are started; the promise rejects with that first error once
 * the calls already in flight have settled (their own rejections are absorbed, never left unhandled).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
