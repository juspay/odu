export interface ClaimWindow extends Disposable {
  close(): void;
}

export interface ClaimWindows {
  open(platform: string): ClaimWindow;
  any(): boolean;
  has(platform: string): boolean;
}

export function createClaimWindows(): ClaimWindows {
  const open = new Map<string, number>();
  return {
    open: (platform) => {
      open.set(platform, (open.get(platform) ?? 0) + 1);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        const left = (open.get(platform) ?? 0) - 1;
        if (left > 0) open.set(platform, left);
        else open.delete(platform);
      };
      return { close, [Symbol.dispose]: close };
    },
    any: () => open.size > 0,
    has: (platform) => open.has(platform),
  };
}
