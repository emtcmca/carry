import { describe, it, expect } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { loadNamespaces, resolveToken, authenticate, type AuthContext } from "../src/auth.js";
import {
  loadOAuthConfig,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
  createJwtVerifier,
  type OAuthConfig,
} from "../src/oauth.js";

/**
 * OAuth read-path tests (B-2). Fully hermetic: no network, no real WorkOS. The JWT
 * verification tests mint tokens with an in-test keypair and inject a LOCAL JWKS via
 * the `createJwtVerifier(config, jwks)` seam, so signature/iss/aud/expiry are all
 * exercised against jose without ever fetching a remote key set.
 */

const ISSUER = "https://youthful-ginger-43.authkit.app";
const AUDIENCE = "https://carry-abxf.onrender.com/mcp";

const oneNs = loadNamespaces(
  '[{"namespace":"eric","readToken":"read-token-123","writeToken":"write-token-456"}]',
);
const twoNs = loadNamespaces(
  '[{"namespace":"eric","readToken":"r1","writeToken":"w1"},' +
    '{"namespace":"dana","readToken":"r2","writeToken":"w2"}]',
);

// --- loadOAuthConfig ---

describe("loadOAuthConfig", () => {
  it("returns null when CARRY_OAUTH_ISSUER is unset or empty", () => {
    expect(loadOAuthConfig({}, oneNs)).toBeNull();
    expect(loadOAuthConfig({ CARRY_OAUTH_ISSUER: "" }, oneNs)).toBeNull();
    expect(loadOAuthConfig({ CARRY_OAUTH_ISSUER: "   " }, oneNs)).toBeNull();
  });

  it("throws when issuer is set but audience is missing", () => {
    expect(() => loadOAuthConfig({ CARRY_OAUTH_ISSUER: ISSUER }, oneNs)).toThrow(
      /CARRY_OAUTH_AUDIENCE/,
    );
  });

  it("defaults namespace to the sole configured namespace", () => {
    const cfg = loadOAuthConfig(
      { CARRY_OAUTH_ISSUER: ISSUER, CARRY_OAUTH_AUDIENCE: AUDIENCE },
      oneNs,
    );
    expect(cfg?.namespace).toBe("eric");
  });

  it("requires CARRY_OAUTH_NAMESPACE when more than one namespace exists", () => {
    expect(() =>
      loadOAuthConfig({ CARRY_OAUTH_ISSUER: ISSUER, CARRY_OAUTH_AUDIENCE: AUDIENCE }, twoNs),
    ).toThrow(/CARRY_OAUTH_NAMESPACE is required/);
  });

  it("throws when CARRY_OAUTH_NAMESPACE names an unknown namespace", () => {
    expect(() =>
      loadOAuthConfig(
        {
          CARRY_OAUTH_ISSUER: ISSUER,
          CARRY_OAUTH_AUDIENCE: AUDIENCE,
          CARRY_OAUTH_NAMESPACE: "nobody",
        },
        twoNs,
      ),
    ).toThrow(/does not name any namespace/);
  });

  it("selects the requested namespace when it exists (multi-namespace)", () => {
    const cfg = loadOAuthConfig(
      {
        CARRY_OAUTH_ISSUER: ISSUER,
        CARRY_OAUTH_AUDIENCE: AUDIENCE,
        CARRY_OAUTH_NAMESPACE: "dana",
      },
      twoNs,
    );
    expect(cfg?.namespace).toBe("dana");
  });

  it("derives jwksUrl from the issuer by default", () => {
    const cfg = loadOAuthConfig(
      { CARRY_OAUTH_ISSUER: ISSUER, CARRY_OAUTH_AUDIENCE: AUDIENCE },
      oneNs,
    );
    expect(cfg?.jwksUrl).toBe(`${ISSUER}/oauth2/jwks`);
  });

  it("strips a trailing slash on the issuer when deriving jwksUrl", () => {
    const cfg = loadOAuthConfig(
      { CARRY_OAUTH_ISSUER: `${ISSUER}/`, CARRY_OAUTH_AUDIENCE: AUDIENCE },
      oneNs,
    );
    expect(cfg?.jwksUrl).toBe(`${ISSUER}/oauth2/jwks`);
  });

  it("respects an explicit CARRY_OAUTH_JWKS_URL override", () => {
    const override = "https://keys.example.com/jwks.json";
    const cfg = loadOAuthConfig(
      {
        CARRY_OAUTH_ISSUER: ISSUER,
        CARRY_OAUTH_AUDIENCE: AUDIENCE,
        CARRY_OAUTH_JWKS_URL: override,
      },
      oneNs,
    );
    expect(cfg?.jwksUrl).toBe(override);
  });
});

// --- protectedResourceMetadata ---

describe("protectedResourceMetadata", () => {
  it("returns the exact RFC 9728 shape and values", () => {
    const config: OAuthConfig = {
      issuer: ISSUER,
      audience: AUDIENCE,
      namespace: "eric",
      jwksUrl: `${ISSUER}/oauth2/jwks`,
    };
    expect(protectedResourceMetadata(config)).toEqual({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
    });
  });
});

// --- wwwAuthenticateChallenge ---

describe("wwwAuthenticateChallenge", () => {
  it("returns the exact challenge with the PRM URL at the audience origin", () => {
    const config: OAuthConfig = {
      issuer: ISSUER,
      audience: AUDIENCE,
      namespace: "eric",
      jwksUrl: `${ISSUER}/oauth2/jwks`,
    };
    expect(wwwAuthenticateChallenge(config)).toBe(
      'Bearer error="unauthorized", error_description="Authorization needed", ' +
        'resource_metadata="https://carry-abxf.onrender.com/.well-known/oauth-protected-resource"',
    );
  });
});

// --- createJwtVerifier (injected local JWKS) ---

describe("createJwtVerifier", () => {
  const config: OAuthConfig = {
    issuer: ISSUER,
    audience: AUDIENCE,
    namespace: "eric",
    jwksUrl: `${ISSUER}/oauth2/jwks`,
  };

  /**
   * Mint an ES256 keypair, expose its public half as a local JWKS, and return both
   * a signer and the injectable key set. Everything stays in-process.
   */
  async function makeKeys() {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] };
    const keyResolver = createLocalJWKSet(jwks);
    return { privateKey, keyResolver };
  }

  function sign(
    privateKey: CryptoKey | Uint8Array,
    claims: { iss: string; aud: string; exp?: string | number },
  ): Promise<string> {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setIssuedAt();
    if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
    return jwt.sign(privateKey);
  }

  it("accepts a valid token and maps it to { namespace, read }", async () => {
    const { privateKey, keyResolver } = await makeKeys();
    const token = await sign(privateKey, { iss: ISSUER, aud: AUDIENCE, exp: "5m" });
    const verify = createJwtVerifier(config, keyResolver);
    expect(await verify(token)).toEqual({ namespace: "eric", scope: "read" });
  });

  it("rejects a token with the wrong issuer -> null", async () => {
    const { privateKey, keyResolver } = await makeKeys();
    const token = await sign(privateKey, {
      iss: "https://evil.example.com",
      aud: AUDIENCE,
      exp: "5m",
    });
    expect(await createJwtVerifier(config, keyResolver)(token)).toBeNull();
  });

  it("rejects a token with the wrong audience -> null", async () => {
    const { privateKey, keyResolver } = await makeKeys();
    const token = await sign(privateKey, {
      iss: ISSUER,
      aud: "https://someone-else/mcp",
      exp: "5m",
    });
    expect(await createJwtVerifier(config, keyResolver)(token)).toBeNull();
  });

  it("rejects an expired token -> null", async () => {
    const { privateKey, keyResolver } = await makeKeys();
    // Expired one hour ago (setExpirationTime accepts a relative string).
    const token = await sign(privateKey, { iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await createJwtVerifier(config, keyResolver)(token)).toBeNull();
  });

  it("rejects tampered / garbage tokens -> null (never throws)", async () => {
    const { keyResolver } = await makeKeys();
    const verify = createJwtVerifier(config, keyResolver);
    expect(await verify("not-a-jwt")).toBeNull();
    expect(await verify("a.b.c")).toBeNull();
    expect(await verify("")).toBeNull();
  });
});

// --- authenticate orchestrator (static-first, JWT fallback) ---

describe("authenticate", () => {
  // A trivial verifier that "accepts" exactly one opaque token, for wiring tests.
  const stubVerifier = async (token: string): Promise<AuthContext | null> =>
    token === "good-jwt" ? { namespace: "eric", scope: "read" } : null;

  it("resolves a valid static WRITE token to write scope without consulting the JWT verifier", async () => {
    let consulted = false;
    const verify = async (t: string) => {
      consulted = true;
      return stubVerifier(t);
    };
    expect(await authenticate("write-token-456", oneNs, verify)).toEqual({
      namespace: "eric",
      scope: "write",
    });
    expect(consulted).toBe(false);
  });

  it("resolves a valid static READ token to read scope", async () => {
    expect(await authenticate("read-token-123", oneNs, stubVerifier)).toEqual({
      namespace: "eric",
      scope: "read",
    });
  });

  it("falls back to the JWT verifier for an unknown token", async () => {
    expect(await authenticate("good-jwt", oneNs, stubVerifier)).toEqual({
      namespace: "eric",
      scope: "read",
    });
  });

  it("returns null for a null token", async () => {
    expect(await authenticate(null, oneNs, stubVerifier)).toBeNull();
  });

  it("returns null for an unknown token when OAuth is disabled (verifyJwt=null)", async () => {
    expect(await authenticate("unknown", oneNs, null)).toBeNull();
  });

  it("keeps the static path identical to resolveToken for known tokens", async () => {
    // Sanity: the orchestrator must not alter static resolution semantics.
    expect(await authenticate("read-token-123", oneNs, null)).toEqual(
      resolveToken("read-token-123", oneNs),
    );
  });
});
