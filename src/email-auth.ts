import express from "express";
import bcrypt from "bcryptjs";
import * as jose from "jose";
import { prisma } from "./db";
import { HttpError } from "./errors";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-me-32-chars-minimum-secret"
);
const JWT_ISSUER = "jetkvm-cloud";
const JWT_AUDIENCE = "jetkvm-app";
const JWT_TTL = "24h";

export async function issueToken(userId: bigint, email: string): Promise<string> {
  return new jose.SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId.toString())
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string) {
  const { payload } = await jose.jwtVerify(token, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return payload;
}

export async function Register(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new HttpError(400, "Email and password are required");
    }

    if (typeof email !== "string" || typeof password !== "string") {
      throw new HttpError(400, "Invalid input types");
    }

    if (password.length < 8) {
      throw new HttpError(400, "Password must be at least 8 characters");
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new HttpError(409, "Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash },
    });

    const token = await issueToken(user.id, user.email);
    req.session!.id_token = token;

    return res.status(201).json({ email: user.email });
  } catch (err) {
    next(err);
  }
}

export async function Login(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new HttpError(400, "Email and password are required");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new HttpError(401, "Invalid email or password");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, "Invalid email or password");
    }

    const token = await issueToken(user.id, user.email);
    req.session!.id_token = token;

    return res.json({ email: user.email });
  } catch (err) {
    next(err);
  }
}
