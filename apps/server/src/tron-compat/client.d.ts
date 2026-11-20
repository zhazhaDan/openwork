/** Server-facing boundary of the generated upstream native client. */
export type Result = { data?: unknown; error?: unknown; request: Request; response: Response; nextCursor?: string | null; pagination?: unknown };
export type Operation = (parameters?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Result>;
export type Event = { type: string; properties?: unknown };
export function createClientV2(baseUrl: string, directory: string | undefined, auth: { token?: string }, transport: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): {
  session: Record<string, Operation>;
  config: Record<string, Operation>;
  provider: Record<string, Operation>;
  app: Record<string, Operation>;
  command: Record<string, Operation>;
  permission: Record<string, Operation>;
  question: Record<string, Operation>;
  mcp: Record<string, Operation>;
  find: Record<string, Operation>;
  global: Record<string, Operation>;
  event: { subscribe(parameters?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ stream: AsyncGenerator<Event> }> };
};
export function createV2EventTranslationState(): object;
export function translateV2Event(value: unknown, state: object): Event[] | null;
