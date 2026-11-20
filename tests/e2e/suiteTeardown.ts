let registered: (() => void) | null = null;

export function registerSuiteTeardown(teardown: () => void): void {
  registered = teardown;
}

export function runSuiteTeardown(): void {
  const teardown = registered;
  registered = null;
  if (teardown !== null) teardown();
}
