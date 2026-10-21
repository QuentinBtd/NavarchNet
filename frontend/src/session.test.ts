import { describe, expect, it } from "vitest";
import { Session } from "./session";

describe("session response isolation", () => {
  it("retires ignored-abort view responses without losing the in-memory identity", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const headers: string[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const session = new Session(async (_input, init) => {
      headers.push(new Headers(init?.headers).get("Authorization") ?? "");
      signals.push(init?.signal);
      return headers.length === 1 ? pending : new Response("{}");
    });
    session.login("in-memory-reader");
    const old = session.request("/audit");
    session.retireRequests();
    expect(signals[0]?.aborted).toBe(true);
    resolve(new Response('{"retired":true}'));
    await expect(old).rejects.toThrow("Session changed");
    await session.request("/snapshot");
    expect(headers).toEqual(["Bearer in-memory-reader", "Bearer in-memory-reader"]);
    expect(signals[1]?.aborted).toBe(false);
  });
  it("discards responses from a signed-out session even when fetch ignores abort", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const deferred = new Promise<Response>((r) => {
      resolve = r;
    });
    const session = new Session(() => deferred);
    session.login("old-token");
    const pending = session.request<{ secret: string }>("/snapshot");
    session.logout();
    resolve?.(new Response(JSON.stringify({ secret: "old-session-data" }), { status: 200 }));
    await expect(pending).rejects.toThrow("Session changed");
  });
  it("never sends the old token after switching identities", async () => {
    const headers: string[] = [];
    const session = new Session(async (_input, init) => {
      headers.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response("{}", { status: 200 });
    });
    session.login("admin");
    await session.request("/snapshot");
    session.login("reader");
    await session.request("/snapshot");
    expect(headers).toEqual(["Bearer admin", "Bearer reader"]);
  });
});
