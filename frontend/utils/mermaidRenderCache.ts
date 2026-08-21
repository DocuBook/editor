const CACHE_LIMIT = 100;

function withId<T extends { svg: string }>(
  result: T,
  from: string,
  to: string,
): T {
  return from === to
    ? result
    : { ...result, svg: result.svg.replaceAll(from, to) };
}

export function whenIdle<T>(run: () => Promise<T>): Promise<T> {
  if (typeof requestIdleCallback === "undefined")
    return new Promise((resolve) => setTimeout(resolve, 0)).then(run);
  return new Promise<T>((resolve, reject) =>
    requestIdleCallback(() => void run().then(resolve, reject), {
      timeout: 250,
    }),
  );
}

export function cacheMermaidRender<T extends { svg: string }>(
  render: (id: string, source: string) => Promise<T>,
) {
  const cache = new Map<string, Promise<{ id: string; result: T }>>();

  return async (id: string, source: string): Promise<T> => {
    let pending = cache.get(source);
    if (!pending) {
      pending = render(id, source).then((result) => ({ id, result }));
      cache.set(source, pending);
      pending.catch(() => cache.delete(source));
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    } else {
      cache.delete(source);
      cache.set(source, pending);
    }
    const cached = await pending;
    return withId(cached.result, cached.id, id);
  };
}
