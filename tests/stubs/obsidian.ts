export class Notice {
  constructor(readonly message?: string) {}
}

export class TFile {
  constructor(readonly path: string) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl stub was not configured");
}
