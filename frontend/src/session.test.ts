import { describe, expect, it } from "vitest";
import { Session } from "./session";

describe("session response isolation", () => {
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
