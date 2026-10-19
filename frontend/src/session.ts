export class Session {
  private token = "";
  private generation = 0;
  private controller = new AbortController();
  constructor(private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  get version() {
    return this.generation;
  }
  login(token: string) {
    this.logout();
    this.token = token;
  }
  logout() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.token = "";
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const generation = this.generation;
    const response = await this.fetcher(`/api/v1${path}`, {
      signal: this.controller.signal,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value =
      response.status === 204
        ? undefined
        : await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (generation !== this.generation) throw new Error("Session changed; discarded previous response");
    if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
    return value as T;
  }
}
