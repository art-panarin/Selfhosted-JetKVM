import express from "express";
import * as jose from "jose";
import * as crypto from "crypto";
import { prisma } from "./db";
import { NotFoundError, UnprocessableEntityError } from "./errors";
import { activeConnections, iceServers, inFlight } from "./webrtc-signaling";

// Build an HMAC-SHA256 identity token the KVM device can verify offline.
// The device already stores its secretToken, so it can recompute and compare.
function buildIdentityToken(secretToken: string, userId: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(ts / 60); // 60-second window
  const mac = crypto
    .createHmac("sha256", secretToken)
    .update(`${userId}:${bucket}`)
    .digest("base64");

  return Buffer.from(
    JSON.stringify({ token: mac, userId, ts })
  ).toString("base64");
}

// Generate coturn HMAC-SHA1 time-limited credentials
function buildTurnCredentials(userId: string) {
  const ttl = 86400; // 24 hours
  const ts = Math.floor(Date.now() / 1000) + ttl;
  const username = `${ts}:${userId}`;
  const credential = crypto
    .createHmac("sha1", process.env.TURN_SECRET || "")
    .update(username)
    .digest("base64");

  const host = process.env.TURN_HOST || "localhost";
  const port = process.env.TURN_PORT || "3478";

  return {
    iceServers: {
      urls: [`turn:${host}:${port}`, `stun:${host}:${port}`],
      username,
      credential,
    },
  };
}

export const CreateSession = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);

  const { id, sd } = req.body;

  if (!id) throw new UnprocessableEntityError("Missing id");
  if (!sd) throw new UnprocessableEntityError("Missing sd");

  const device = await prisma.device.findUnique({
    where: { id, user: { id: BigInt(sub!) } },
    select: { id: true, secretToken: true },
  });

  if (!device) {
    throw new NotFoundError("Device not found");
  }

  if (inFlight.has(id)) {
    console.log(`Websocket for ${id} in-flight with another client`);
    throw new UnprocessableEntityError(
      `Websocket for ${id} in-flight with another client`,
    );
  }

  const wsTuple = activeConnections.get(id);
  if (!wsTuple) {
    console.log("No socket for id", id);
    throw new NotFoundError(`No socket for id found`, "kvm_socket_not_found");
  }

  const [ws, ip] = wsTuple;

  const identityToken = device.secretToken
    ? buildIdentityToken(device.secretToken, sub!)
    : "";

  let timeout: NodeJS.Timeout | undefined;
  let httpClose: (() => void) | null = null;

  try {
    inFlight.add(id);
    const resp: any = await new Promise((res, rej) => {
      timeout = setTimeout(() => {
        rej(new Error("Timeout waiting for response from ws"));
      }, 15000);

      ws.onerror = rej;
      ws.onclose = rej;
      ws.onmessage = res;

      httpClose = () => {
        rej(new Error("HTTP client closed the connection"));
      };

      req.socket.on("close", httpClose);

      ws.send(
        JSON.stringify({
          sd,
          ip,
          iceServers,
          OidcGoogle: identityToken,
        }),
      );
    });

    console.log("[CreateSession] got response from device", id);
    return res.json(JSON.parse(resp.data));
  } catch (e) {
    console.log(`Error sending data to kvm with ${id}`, e);
    return res
      .status(500)
      .json({ error: "There was an error sending and receiving data to the KVM" });
  } finally {
    if (timeout) clearTimeout(timeout);
    console.log("Removing in flight", id);
    inFlight.delete(id);

    if (httpClose) {
      console.log("Removing http close listener", id);
      req.socket.off("close", httpClose);
    }

    if (ws) {
      console.log("Removing ws listeners", id);
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
    }
  }
};

export const CreateIceCredentials = async (
  req: express.Request,
  res: express.Response,
) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);

  const data = buildTurnCredentials(sub!);
  return res.json(data);
};

export const CreateTurnActivity = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  const { bytesReceived, bytesSent } = req.body;

  await prisma.turnActivity.create({
    data: {
      bytesReceived,
      bytesSent,
      user: { connect: { id: BigInt(sub!) } },
    },
  });

  return res.json({ success: true });
};
