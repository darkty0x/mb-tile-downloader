import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "ptg_session";

export const DEFAULT_ADMIN_USER = {
  userId: "admin",
  email: "daisuke.hiroki.25@gmail.com",
  username: "daisukehiroki25",
  role: "Administrator",
  passwordHash: "scrypt:hlvkNLMgWOg81j4tnpB1DQ:XjHGToVRIfy4UPgx97noaCHotx64SwfDix-aVpdKiUA8N4piySYXJLatXh69hs5th6C9dCtiDGLeCm_lq11Wkg",
};

function iso(date = new Date()) {
  return date.toISOString();
}

function publicUser(user) {
  if (!user) return null;
  return {
    userId: user.userId,
    email: user.email,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function sessionHash(token) {
  return createHash("sha256").update(String(token || "")).digest("base64url");
}

function parseCookieHeader(header = "") {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

export function sessionTokenFromRequest(req) {
  return parseCookieHeader(req.headers.cookie || "").get(SESSION_COOKIE) || "";
}

export function setSessionCookie(res, token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = await scrypt(String(password || ""), salt, 64);
  return `scrypt:${salt}:${Buffer.from(hash).toString("base64url")}`;
}

export async function verifyPassword(password, storedHash) {
  const [kind, salt, expected] = String(storedHash || "").split(":");
  if (kind !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(String(password || ""), salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function normalizeUserInput(input = {}, current = {}) {
  const email = String(input.email ?? current.email ?? "").trim().toLowerCase();
  const username = String(input.username ?? current.username ?? "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("valid email is required");
  if (!username || !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error("username must be 3-64 letters, numbers, dots, underscores, or dashes");
  }
  return { email, username };
}

export function createMemoryAuthStore({ now = () => new Date(), idGenerator = () => randomBytes(16).toString("base64url") } = {}) {
  const users = new Map();
  const sessions = new Map();

  const store = {
    async seedDefaultAdmin(user = DEFAULT_ADMIN_USER) {
      const at = iso(now());
      const existing = users.get(user.userId);
      const record = {
        ...existing,
        userId: user.userId,
        email: user.email,
        username: user.username,
        role: user.role,
        passwordHash: user.passwordHash,
        createdAt: existing?.createdAt || at,
        updatedAt: at,
      };
      users.set(record.userId, record);
      return publicUser(record);
    },

    async authenticate({ login, password }) {
      const normalizedLogin = String(login || "").trim().toLowerCase();
      const user = [...users.values()].find((item) =>
        item.email.toLowerCase() === normalizedLogin || item.username.toLowerCase() === normalizedLogin
      );
      if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
      return publicUser(user);
    },

    async createSession(userId) {
      const user = users.get(userId);
      if (!user) throw new Error("user not found");
      const token = idGenerator();
      const at = now();
      const session = {
        tokenHash: sessionHash(token),
        userId,
        createdAt: iso(at),
        expiresAt: iso(new Date(at.getTime() + SESSION_TTL_MS)),
      };
      sessions.set(session.tokenHash, session);
      return { token, expiresAt: session.expiresAt, user: publicUser(user) };
    },

    async getSessionUser(token) {
      if (!token) return null;
      const hash = sessionHash(token);
      const session = sessions.get(hash);
      if (!session || Date.parse(session.expiresAt) <= now().getTime()) {
        sessions.delete(hash);
        return null;
      }
      return publicUser(users.get(session.userId));
    },

    async deleteSession(token) {
      if (token) sessions.delete(sessionHash(token));
    },

    async updateUser(userId, input = {}) {
      const current = users.get(userId);
      if (!current) throw new Error("user not found");
      if (input.currentPassword || input.password) {
        if (!(await verifyPassword(input.currentPassword, current.passwordHash))) {
          throw new Error("current password is incorrect");
        }
      }
      const profile = normalizeUserInput(input, current);
      const next = {
        ...current,
        ...profile,
        passwordHash: input.password ? await hashPassword(input.password) : current.passwordHash,
        updatedAt: iso(now()),
      };
      users.set(userId, next);
      return publicUser(next);
    },
  };
  return store;
}

function userFromRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    username: row.username,
    role: row.role,
    passwordHash: row.password_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createPostgresAuthStore({ db, now = () => new Date() } = {}) {
  if (!db?.query) throw new Error("db.query is required");

  async function firstRow(sql, params = []) {
    const result = await db.query(sql, params);
    return result.rows[0] || null;
  }

  return {
    async seedDefaultAdmin(user = DEFAULT_ADMIN_USER) {
      const row = await firstRow(
        `INSERT INTO dashboard_users (user_id, email, username, role, password_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (user_id) DO UPDATE SET
           email=excluded.email,
           username=excluded.username,
           role=excluded.role,
           password_hash=excluded.password_hash,
           updated_at=excluded.updated_at
         RETURNING *`,
        [user.userId, user.email, user.username, user.role, user.passwordHash, iso(now())]
      );
      return publicUser(userFromRow(row));
    },

    async authenticate({ login, password }) {
      const normalizedLogin = String(login || "").trim().toLowerCase();
      const row = await firstRow(
        "SELECT * FROM dashboard_users WHERE lower(email)=$1 OR lower(username)=$1 LIMIT 1",
        [normalizedLogin]
      );
      const user = userFromRow(row);
      if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
      return publicUser(user);
    },

    async createSession(userId) {
      const token = randomBytes(32).toString("base64url");
      const at = now();
      const row = await firstRow(
        `INSERT INTO dashboard_sessions (token_hash, user_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [sessionHash(token), userId, iso(at), iso(new Date(at.getTime() + SESSION_TTL_MS))]
      );
      const userRow = await firstRow("SELECT * FROM dashboard_users WHERE user_id=$1", [row.user_id]);
      return { token, expiresAt: iso(row.expires_at), user: publicUser(userFromRow(userRow)) };
    },

    async getSessionUser(token) {
      if (!token) return null;
      const row = await firstRow(
        `SELECT u.* FROM dashboard_sessions s
         JOIN dashboard_users u ON u.user_id=s.user_id
         WHERE s.token_hash=$1 AND s.expires_at>$2`,
        [sessionHash(token), iso(now())]
      );
      return publicUser(userFromRow(row));
    },

    async deleteSession(token) {
      if (!token) return;
      await db.query("DELETE FROM dashboard_sessions WHERE token_hash=$1", [sessionHash(token)]);
    },

    async updateUser(userId, input = {}) {
      const current = userFromRow(await firstRow("SELECT * FROM dashboard_users WHERE user_id=$1", [userId]));
      if (!current) throw new Error("user not found");
      if (input.currentPassword || input.password) {
        if (!(await verifyPassword(input.currentPassword, current.passwordHash))) {
          throw new Error("current password is incorrect");
        }
      }
      const profile = normalizeUserInput(input, current);
      const passwordHash = input.password ? await hashPassword(input.password) : current.passwordHash;
      const row = await firstRow(
        `UPDATE dashboard_users
         SET email=$2, username=$3, password_hash=$4, updated_at=$5
         WHERE user_id=$1
         RETURNING *`,
        [userId, profile.email, profile.username, passwordHash, iso(now())]
      );
      return publicUser(userFromRow(row));
    },
  };
}
