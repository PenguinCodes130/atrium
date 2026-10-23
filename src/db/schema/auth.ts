// Owned by the auth subsystem (architecture v2 sections 5 and 9b).
// Better Auth core tables (user, session, account, verification, twoFactor) plus Atrium's
// allowlist, rate-limit buckets and auth metadata. Better Auth reads these through the Drizzle
// adapter, keyed by model name (see src/features/auth/server/auth.ts).
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role", { enum: ["owner", "member", "viewer"] }).notNull().default("viewer"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false),
  // Set when the user is demoted or their access is cut: agent tokens issued before it stop working.
  accessRevokedAt: ts("access_revoked_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const sessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Step-up (architecture section 5): when this session last proved it is the user again.
    stepUpAt: ts("step_up_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verifications = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const twoFactors = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: ts("locked_until"),
  },
  (t) => [index("two_factor_user_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);

// Allowlist (architecture section 5): exact email or "*@domain", each with the role given at first sign-in.
export const allowlistEntries = sqliteTable(
  "allowlist",
  {
    id: text("id").primaryKey(),
    pattern: text("pattern").notNull(),
    role: text("role", { enum: ["owner", "member", "viewer"] }).notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("allowlist_pattern_idx").on(t.pattern)],
);

// Atrium's own fixed-window limiter on SQLite (architecture section 5).
export const authRateLimits = sqliteTable("auth_rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
});

// ---- MCP OAuth (architecture section 9b): tables of @better-auth/oauth-provider 1.7.10 -------------
// Field names follow the plugin's schema exactly (Better Auth maps model fields to these keys).
// string[] and json fields are stored as JSON text (the SQLite adapter has no arrays or JSON type).
// Access tokens are opaque and stored only as their SHA-256 hash (base64url), never in clear.

export const oauthClients = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: text("scopes"),
    clientCredentialsScopes: text("client_credentials_scopes"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", { mode: "boolean" }),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", { mode: "boolean" }).default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
  },
  (t) => [index("oauth_client_user_idx").on(t.userId)],
);

export const oauthResources = sqliteTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes"),
  customClaims: text("custom_claims"),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", { mode: "boolean" }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata"),
});

export const oauthClientResources = sqliteTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: text("metadata"),
    createdAt: ts("created_at"),
  },
  (t) => [index("oauth_client_resource_client_idx").on(t.clientId), index("oauth_client_resource_resource_idx").on(t.resourceId), uniqueIndex("oauth_client_resource_pair_idx").on(t.clientId, t.resourceId)],
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at"),
    revoked: ts("revoked"),
    rotatedAt: ts("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: ts("rotation_replay_expires_at"),
    authTime: ts("auth_time"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_idx").on(t.clientId),
    index("oauth_refresh_token_session_idx").on(t.sessionId),
    index("oauth_refresh_token_user_idx").on(t.userId),
    index("oauth_refresh_token_code_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at"),
    revoked: ts("revoked"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
  },
  (t) => [
    index("oauth_access_token_client_idx").on(t.clientId),
    index("oauth_access_token_session_idx").on(t.sessionId),
    index("oauth_access_token_user_idx").on(t.userId),
    index("oauth_access_token_code_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_idx").on(t.refreshId),
  ],
);

export const oauthConsents = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    scopes: text("scopes").notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("oauth_consent_client_idx").on(t.clientId), index("oauth_consent_user_idx").on(t.userId)],
);

export const oauthClientAssertions = sqliteTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
});


// ---- Account links (architecture v3 Amendment 3): member invites and password resets ---------------
// The token (atr_i_...) is shown once; only its SHA-256 hash (hex) is stored. Only the owner makes them.
export const accountLinks = sqliteTable(
  "account_link",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["invite", "reset"] }).notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["member", "viewer"] }),
    // Reset only: the user whose password the link sets.
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    // Why it was revoked: manual, replaced, entry_removed, user_removed.
    revokedCause: text("revoked_cause"),
  },
  (t) => [index("account_link_email_idx").on(t.email)],
);
