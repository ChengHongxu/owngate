export interface HttpAdapterContext {
  http: { get(path: string): Promise<{ status: number; json: unknown; text: string }> };
  browser: undefined;
  log(message: string): void;
  signal: AbortSignal;
}
export interface HttpAdapter { run(capabilityId: string, input: unknown, context: HttpAdapterContext): Promise<unknown> }
/** Trusted adapters ship with the image; importing arbitrary code is disabled. */
export function defineHttpAdapter(adapter: HttpAdapter): HttpAdapter { return adapter; }
