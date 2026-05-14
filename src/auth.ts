import { type NextFunction, type Request, type Response } from "express";
import { UnauthorizedError } from "./errors";
import { verifyToken } from "./email-auth";

const ALLOWED_IDENTITIES = process.env.ALLOWED_IDENTITIES?.split(",")
    .map((identity) => identity.trim().toLowerCase())
    .filter(Boolean);

const getAllowedIdentities = () => {
  if (!ALLOWED_IDENTITIES) return null;
  return ALLOWED_IDENTITIES.length > 0 ? new Set(ALLOWED_IDENTITIES) : null;
};

export const isIdentityAllowed = (identity?: string | null) => {
  const allowedIdentities = getAllowedIdentities();
  const identityNormalized = identity?.trim().toLowerCase();
  if (!allowedIdentities) return true;
  if (!identityNormalized) return false;
  return allowedIdentities.has(identityNormalized);
};

export const authenticated = async (req: Request, res: Response, next: NextFunction) => {
  const idToken = req.session?.id_token;
  if (!idToken) throw new UnauthorizedError();

  let payload: Awaited<ReturnType<typeof verifyToken>>;
  try {
    payload = await verifyToken(idToken);
  } catch {
    throw new UnauthorizedError();
  }

  if (!payload.exp) throw new UnauthorizedError();

  if (new Date(payload.exp * 1000) < new Date()) {
    throw new UnauthorizedError();
  }

  const email = payload.email as string | undefined;
  if (!isIdentityAllowed(email)) {
    throw new UnauthorizedError("Account is not in the allowlist", "account_not_allowed");
  }

  next();
};
