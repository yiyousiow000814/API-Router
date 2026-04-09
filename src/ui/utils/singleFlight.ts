export function runSingleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const promise = Promise.resolve().then(run)
  inFlight.set(key, promise)
  const clear = () => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
    }
  }
  void promise.then(clear, clear)
  return promise
}
