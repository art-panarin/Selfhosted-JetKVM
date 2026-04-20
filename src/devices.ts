import * as jose from "jose";
import * as crypto from "crypto";
import { prisma } from "./db";
import express from "express";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
} from "./errors";
import { authenticated } from "./auth";
import { activeConnections } from "./webrtc-signaling";

// Build an HMAC-SHA256 identity token for the KVM device to verify offline.
function buildIdentityToken(secretToken: string, userId: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(ts / 60);
  const mac = crypto
    .createHmac("sha256", secretToken)
    .update(`${userId}:${bucket}`)
    .digest("base64");
  return Buffer.from(JSON.stringify({ token: mac, userId, ts })).toString("base64");
}

export const List = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);

  const devices = await prisma.device.findMany({
    where: { user: { id: BigInt(sub!) } },
    select: { id: true, name: true, lastSeen: true },
  });

  return res.json({
    devices: devices.map(device => {
      const activeDevice = activeConnections.get(device.id);
      const version = activeDevice?.[2] || null;
      return { ...device, online: !!activeDevice, version };
    }),
  });
};

export const Retrieve = async (
  req: express.Request<{ id: string }>,
  res: express.Response
) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  const { id } = req.params;
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  const device = await prisma.device.findUnique({
    where: { id, user: { id: BigInt(sub!) } },
    select: { id: true, name: true },
  });

  if (!device) throw new NotFoundError("Device not found");
  return res.status(200).json({ device });
};

export const Update = async (
  req: express.Request<{ id: string }>,
  res: express.Response
) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  if (!sub) throw new UnauthorizedError("Missing sub in token");

  const { id } = req.params;
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  const { name } = req.body as { name: string };
  if (!name) throw new UnprocessableEntityError("Missing name in body");

  const device = await prisma.device.update({
    where: { id, user: { id: BigInt(sub) } },
    data: { name },
    select: { id: true },
  });

  return res.json(device);
};

// Called by the KVM device itself to exchange a tempToken for a secretToken.
// Used when the device is registering without the web adoption flow.
export const Token = async (req: express.Request, res: express.Response) => {
  const { tempToken } = req.body as { tempToken: string };
  if (!tempToken) throw new UnprocessableEntityError("Missing temp token in body");

  const device = await prisma.device.findFirst({ where: { tempToken } });
  if (!device?.tempToken) throw new NotFoundError("Device not found");
  if ((device?.tempTokenExpiresAt || 0) < new Date())
    throw new UnauthorizedError("Token expired");

  const secretToken = crypto.randomBytes(20).toString("hex");

  await prisma.device.update({
    where: { id: device.id },
    data: { secretToken, tempToken: null, tempTokenExpiresAt: null },
  });

  return res.json({ secretToken });
};

// Called by the authenticated web UI to adopt (claim) a KVM device.
// Body: { deviceId, deviceUrl }
//   deviceId  - the hardware ID shown on the KVM device screen
//   deviceUrl - the KVM device's local web address (e.g. http://192.168.1.100)
// Returns a redirectUrl pointing to the KVM device's /adopt page with all needed params.
export const Adopt = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  if (!sub) throw new UnauthorizedError("Missing sub in token");

  const { deviceId, deviceUrl } = req.body as { deviceId: string; deviceUrl: string };
  if (!deviceId) throw new UnprocessableEntityError("Missing deviceId in body");
  if (!deviceUrl) throw new UnprocessableEntityError("Missing deviceUrl in body");

  // Check if device is already adopted by another user
  const existing = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { userId: true },
  });
  if (existing && existing.userId !== BigInt(sub)) {
    throw new BadRequestError("Device is already adopted by another user");
  }

  const secretToken = crypto.randomBytes(20).toString("hex");
  const identityToken = buildIdentityToken(secretToken, sub);
  const cloudApiUrl = process.env.API_HOSTNAME || "";

  // Upsert the device record and link it to the user
  await prisma.device.upsert({
    where: { id: deviceId },
    create: {
      id: deviceId,
      secretToken,
      user: { connect: { id: BigInt(sub) } },
    },
    update: {
      secretToken,
      user: { connect: { id: BigInt(sub) } },
    },
  });

  const adoptUrl = new URL("/adopt", deviceUrl);
  adoptUrl.searchParams.set("token", secretToken);
  adoptUrl.searchParams.set("identityToken", identityToken);
  adoptUrl.searchParams.set("cloudApi", cloudApiUrl);
  adoptUrl.searchParams.set("deviceId", deviceId);

  return res.json({ redirectUrl: adoptUrl.toString(), deviceId });
};

export const Delete = async (
  req: express.Request<{ id: string }>,
  res: express.Response
) => {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    const secretToken = req.headers.authorization.split("Bearer ")[1];

    const hasDevice = await prisma.device.findUnique({ where: { secretToken } });
    if (!hasDevice) throw new NotFoundError("Device not found");

    await prisma.device.delete({ where: { secretToken } });
    return res.status(204).send();
  }

  // If the user doesn't have a secret token, we check their session cookie
  try {
    await new Promise<void>(resolve => {
      authenticated(req, res, () => {
        resolve();
      });
    });
  } catch (error) {
    throw new BadRequestError("Unauthorized");
  }

  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  if (!sub) throw new UnauthorizedError("Missing sub in token");

  const { id } = req.params;
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  await prisma.device.delete({ where: { id, user: { id: BigInt(sub) } } });

  const conn = activeConnections.get(id);
  if (conn) {
    const [socket] = conn;
    socket.send("Deregistered from server");
    socket.close();
  }

  return res.status(204).send();
};
