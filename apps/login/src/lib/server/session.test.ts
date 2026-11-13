import { Code } from "@connectrpc/connect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearSession, updateOrCreateSession } from "./session";

vi.mock("@zitadel/client", async () => {
  const { Code } = await import("@connectrpc/connect");
  return { Code, create: vi.fn((_schema: unknown, data: unknown) => data), Duration: {} };
});

vi.mock("@/lib/zitadel", () => ({
  deleteSession: vi.fn(),
  getLoginSettings: vi.fn(),
  getSecuritySettings: vi.fn(),
  humanMFAInitSkipped: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  listUsers: vi.fn(),
  searchUsers: vi.fn(),
}));

vi.mock("@/lib/server/cookie", () => ({
  createSessionAndUpdateCookie: vi.fn(),
  setSessionAndUpdateCookie: vi.fn(),
}));

vi.mock("../cookies", () => ({
  getMostRecentSessionCookie: vi.fn(),
  getSessionCookieById: vi.fn(),
  getSessionCookieByLoginName: vi.fn(),
  removeSessionFromCookie: vi.fn(),
}));

vi.mock("../service-url", () => ({
  getServiceConfig: vi.fn(() => ({ serviceConfig: { baseUrl: "https://example.com" } })),
}));

vi.mock("../client", () => ({
  completeFlowOrGetUrl: vi.fn(),
}));

vi.mock("../session", () => ({
  isSessionValid: vi.fn(),
}));

vi.mock("./host", () => ({
  getPublicHost: vi.fn(() => "test.com"),
}));

vi.mock("./loginname", () => ({
  sendLoginname: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

vi.mock("@/lib/grpc/interceptors/error-classification", () => ({
  isClassifiedError: (error: unknown) => error !== null && typeof error === "object" && "code" in error,
}));

const cookie = { id: "session-1", token: "token-1", loginName: "user@example.com" };

describe("clearSession", () => {
  let deleteSession: any;
  let getSecuritySettings: any;
  let getSessionCookieById: any;
  let removeSessionFromCookie: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const zitadel = await import("@/lib/zitadel");
    const cookies = await import("../cookies");
    deleteSession = vi.mocked(zitadel.deleteSession);
    getSecuritySettings = vi.mocked(zitadel.getSecuritySettings);
    getSessionCookieById = vi.mocked(cookies.getSessionCookieById);
    removeSessionFromCookie = vi.mocked(cookies.removeSessionFromCookie);

    getSessionCookieById.mockResolvedValue(cookie);
    getSecuritySettings.mockResolvedValue({ embeddedIframe: { enabled: true } });
  });

  test("deletes the session and prunes the cookie entry on success", async () => {
    deleteSession.mockResolvedValue({ details: {} });

    const res = await clearSession({ sessionId: "session-1" });

    expect(res).toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", sessionToken: "token-1" }));
    expect(removeSessionFromCookie).toHaveBeenCalledWith({ session: cookie, iFrameEnabled: true });
  });

  test("prunes the cookie entry when the server rejects the cookie token (session gone or token stale)", async () => {
    deleteSession.mockRejectedValue({ code: Code.PermissionDenied });

    const res = await clearSession({ sessionId: "session-1" });

    expect(res).toBeUndefined();
    expect(removeSessionFromCookie).toHaveBeenCalledWith({ session: cookie, iFrameEnabled: true });
  });

  test("keeps the cookie entry and reports an error on any other failure", async () => {
    deleteSession.mockRejectedValue({ code: Code.Unavailable });

    const res = await clearSession({ sessionId: "session-1" });

    expect(res).toEqual({ error: "couldNotClearSession" });
    expect(removeSessionFromCookie).not.toHaveBeenCalled();
  });

  test("attempts the server-side delete even when security settings cannot be loaded", async () => {
    deleteSession.mockResolvedValue({ details: {} });
    getSecuritySettings.mockRejectedValue(new Error("settings unavailable"));

    await expect(clearSession({ sessionId: "session-1" })).rejects.toThrow("settings unavailable");

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(removeSessionFromCookie).not.toHaveBeenCalled();
  });

  test("does nothing when the session id is not in the cookie", async () => {
    getSessionCookieById.mockResolvedValue(undefined);

    const res = await clearSession({ sessionId: "unknown" });

    expect(res).toBeUndefined();
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe("updateOrCreateSession without a session cookie", () => {
  const ORG = "org-1";
  const passkeyChallenge = { webAuthN: { domain: "", userVerificationRequirement: 1 } } as any;
  const user = {
    userId: "user-1",
    preferredLoginName: "jane@example.com@org.example.com",
    details: { resourceOwner: ORG },
    type: { case: "human", value: { email: { email: "jane@example.com" }, phone: { phone: "" } } },
  };

  let getLoginSettings: any;
  let searchUsers: any;
  let createSessionAndUpdateCookie: any;
  let setSessionAndUpdateCookie: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const zitadel = await import("@/lib/zitadel");
    const cookies = await import("../cookies");
    const cookie = await import("@/lib/server/cookie");
    getLoginSettings = vi.mocked(zitadel.getLoginSettings);
    searchUsers = vi.mocked(zitadel.searchUsers);
    createSessionAndUpdateCookie = vi.mocked(cookie.createSessionAndUpdateCookie);
    setSessionAndUpdateCookie = vi.mocked(cookie.setSessionAndUpdateCookie);

    vi.mocked(cookies.getSessionCookieByLoginName).mockResolvedValue(undefined);
    getLoginSettings.mockResolvedValue({ ignoreUnknownUsernames: true });
    createSessionAndUpdateCookie.mockResolvedValue({ sessionCookie: { id: "session-1", token: "token-1" } });
    setSessionAndUpdateCookie.mockResolvedValue({
      id: "session-1",
      factors: { user: { id: "user-1" } },
      challenges: { webAuthN: { publicKeyCredentialRequestOptions: {} } },
    });
  });

  test("starts the session by user id when the typed email belongs to exactly one user of the org", async () => {
    // Given the loginname page passed on the raw email, as it does while ignoreUnknownUsernames applies
    searchUsers.mockResolvedValue({ result: [user] });

    // When the passkey page requests its challenge
    const res = await updateOrCreateSession({
      loginName: "Jane@Example.com",
      organization: ORG,
      challenges: passkeyChallenge,
    });

    // Then the session is created for the resolved user, not by the raw input as a login name
    expect(searchUsers).toHaveBeenCalledWith(
      expect.objectContaining({ searchValue: "Jane@Example.com", organizationId: ORG }),
    );
    expect(createSessionAndUpdateCookie).toHaveBeenCalledWith(
      expect.objectContaining({ checks: { user: { search: { case: "userId", value: "user-1" } } } }),
    );
    expect(res).toEqual(expect.objectContaining({ sessionId: "session-1", challenges: expect.anything() }));
  });

  test("keeps the login name search when no user matches, so unknown users fail as before", async () => {
    // Given nobody matches the input
    searchUsers.mockResolvedValue({ result: [] });
    createSessionAndUpdateCookie.mockRejectedValue({ code: Code.NotFound, isUserError: true });

    // When the passkey page requests its challenge
    const res = await updateOrCreateSession({
      loginName: "nobody@example.com",
      organization: ORG,
      challenges: passkeyChallenge,
    });

    // Then the session is tried by login name and the generic error comes back
    expect(createSessionAndUpdateCookie).toHaveBeenCalledWith(
      expect.objectContaining({ checks: { user: { search: { case: "loginName", value: "nobody@example.com" } } } }),
    );
    expect(res).toEqual({ error: "couldNotFindSession" });
  });

  test("does not resolve an email when the user's org disallows login with email", async () => {
    // Given the user's org disables email login
    searchUsers.mockResolvedValue({ result: [user] });
    getLoginSettings.mockResolvedValue({ ignoreUnknownUsernames: true, disableLoginWithEmail: true });
    createSessionAndUpdateCookie.mockRejectedValue({ code: Code.NotFound, isUserError: true });

    // When the passkey page requests its challenge with the email
    const res = await updateOrCreateSession({
      loginName: "jane@example.com",
      organization: ORG,
      challenges: passkeyChallenge,
    });

    // Then the email is not used to find the user
    expect(createSessionAndUpdateCookie).toHaveBeenCalledWith(
      expect.objectContaining({ checks: { user: { search: { case: "loginName", value: "jane@example.com" } } } }),
    );
    expect(res).toEqual({ error: "couldNotFindSession" });
  });
});
