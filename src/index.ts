import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import * as jose from "jose";
import path from "path";
import 'dotenv/config';

import * as Devices from "./devices";
import * as EmailAuth from "./email-auth";
import * as Webrtc from "./webrtc";
import * as Releases from "./releases";

import { HttpError } from "./errors";
import { authenticated } from "./auth";
import { prisma } from "./db";
import { initializeWebRTCSignaling } from "./webrtc-signaling";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: "development" | "production";
      PORT: string;

      API_HOSTNAME: string;
      APP_HOSTNAME: string;
      COOKIE_SECRET: string;

      // JWT secret for our own auth
      JWT_SECRET: string;

      // Self-hosted TURN (coturn)
      TURN_SECRET: string;
      TURN_HOST: string;
      TURN_PORT: string;

      // We use R2 for storing releases
      R2_ENDPOINT: string;
      R2_ACCESS_KEY_ID: string;
      R2_SECRET_ACCESS_KEY: string;
      R2_BUCKET: string;
      R2_CDN_URL: string;

      CORS_ORIGINS: string;

      // Real IP
      REAL_IP_HEADER: string;
      ICE_SERVERS: string;

      ALLOWED_IDENTITIES?: string;
    }
  }
}

const PORT = process.env.PORT || 3000;

const app = express();
app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: process.env.CORS_ORIGINS?.split(",") || [
      "https://app.jetkvm.com",
      "http://localhost:5173",
    ],
    credentials: true,
  }),
);
export const cookieSessionMiddleware = cookieSession({
  name: "session",
  path: "/",
  httpOnly: true,
  keys: [process.env.COOKIE_SECRET],
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
});

app.use(cookieSessionMiddleware);

// express-session won't sent the cookie, as it's `secure` and `secureProxy` is set to true
app.set("trust proxy", true);

// SPA fallback must be before API routes
app.use(serveSPA);

app.get("/healthz", (req, res) => {
  return res.status(200).send({
    ready: true,
    time: new Date()
  })
});

app.get(
  "/me",
  authenticated,
  async (req: express.Request, res: express.Response) => {
    const idToken = req.session?.id_token;
    const payload = jose.decodeJwt(idToken);
    return res.json({ email: payload.email, sub: payload.sub });
  },
);

// Auth routes
app.post("/auth/register", EmailAuth.Register);
app.post("/auth/login", EmailAuth.Login);

app.post(
  "/logout",
  (req: express.Request, res: express.Response) => {
    req.session = null;
    return res.json({ message: "Logged out" });
  }
);

// Releases
app.get("/releases", Releases.Retrieve);
app.get(
  "/releases/system_recovery/latest",
  Releases.RetrieveLatestSystemRecovery,
);
app.get("/releases/app/latest", Releases.RetrieveLatestApp);

// Device management
app.get("/devices", authenticated, Devices.List);
app.get("/devices/:id", authenticated, Devices.Retrieve);
app.post("/devices/token", Devices.Token);
app.post("/devices/adopt", authenticated, Devices.Adopt);
app.put("/devices/:id", authenticated, Devices.Update);
app.delete("/devices/:id", Devices.Delete);

// WebRTC signaling
app.post("/webrtc/session", authenticated, Webrtc.CreateSession);
app.post("/webrtc/ice_config", authenticated, Webrtc.CreateIceCredentials);
app.post(
  "/webrtc/turn_activity",
  authenticated,
  Webrtc.CreateTurnActivity,
);

// Serve cloud UI static files
const uiDistPath = process.env.UI_DIST_PATH || path.join(__dirname, "../ui-dist");
app.use(express.static(uiDistPath));

// SPA fallback: serve index.html for browser navigation (Accept: text/html)
// This must be BEFORE API routes so that browser navigation gets the SPA,
// while fetch/XHR requests (Accept: application/json) fall through to API routes
function serveSPA(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method !== "GET") return next();
  const accept = req.headers.accept || "";
  // Browser navigation sends Accept: text/html; API calls send application/json
  if (!accept.includes("text/html")) return next();
  // Skip pure API paths that are never UI routes
  if (
    req.path.startsWith("/auth/") ||
    req.path.startsWith("/cloud/") ||
    req.path === "/me" ||
    req.path === "/healthz" ||
    req.path === "/logout"
  ) {
    return next();
  }
  res.sendFile(path.join(uiDistPath, "index.html"), (err) => {
    if (err) next();
  });
}

// Error-handling middleware
app.use(
  (
    err: HttpError | Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const isProduction = process.env.NODE_ENV === "production";
    const statusCode = err instanceof HttpError ? err.status : 500;

    const payload = {
      name: err.name,
      message: err.message,
      ...(isProduction ? {} : { stack: err.stack }),
    };

    console.error(err);

    res.status(statusCode).json(payload);
  },
);

const server = app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});

initializeWebRTCSignaling(server);
