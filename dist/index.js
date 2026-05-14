"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cookieSessionMiddleware = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_session_1 = __importDefault(require("cookie-session"));
const jose = __importStar(require("jose"));
const path_1 = __importDefault(require("path"));
require("dotenv/config");
const Devices = __importStar(require("./devices"));
const EmailAuth = __importStar(require("./email-auth"));
const Webrtc = __importStar(require("./webrtc"));
const Releases = __importStar(require("./releases"));
const errors_1 = require("./errors");
const auth_1 = require("./auth");
const webrtc_signaling_1 = require("./webrtc-signaling");
const PORT = process.env.PORT || 3000;
const app = (0, express_1.default)();
app.disable("x-powered-by");
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cors_1.default)({
    origin: process.env.CORS_ORIGINS?.split(",") || [
        "https://app.jetkvm.com",
        "http://localhost:5173",
    ],
    credentials: true,
}));
exports.cookieSessionMiddleware = (0, cookie_session_1.default)({
    name: "session",
    path: "/",
    httpOnly: true,
    keys: [process.env.COOKIE_SECRET],
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
});
app.use(exports.cookieSessionMiddleware);
// express-session won't sent the cookie, as it's `secure` and `secureProxy` is set to true
app.set("trust proxy", true);
// SPA fallback must be before API routes
app.use(serveSPA);
app.get("/healthz", (req, res) => {
    return res.status(200).send({
        ready: true,
        time: new Date()
    });
});
app.get("/me", auth_1.authenticated, async (req, res) => {
    const idToken = req.session?.id_token;
    const payload = jose.decodeJwt(idToken);
    return res.json({ email: payload.email, sub: payload.sub });
});
// Auth routes
app.post("/auth/register", EmailAuth.Register);
app.post("/auth/login", EmailAuth.Login);
app.post("/logout", (req, res) => {
    req.session = null;
    return res.json({ message: "Logged out" });
});
// Releases
app.get("/releases", Releases.Retrieve);
app.get("/releases/system_recovery/latest", Releases.RetrieveLatestSystemRecovery);
app.get("/releases/app/latest", Releases.RetrieveLatestApp);
// Device management
app.get("/devices", auth_1.authenticated, Devices.List);
app.get("/devices/:id", auth_1.authenticated, Devices.Retrieve);
app.post("/devices/token", Devices.Token);
app.post("/devices/adopt", auth_1.authenticated, Devices.Adopt);
app.put("/devices/:id", auth_1.authenticated, Devices.Update);
app.delete("/devices/:id", Devices.Delete);
// WebRTC signaling
app.post("/webrtc/session", auth_1.authenticated, Webrtc.CreateSession);
app.post("/webrtc/ice_config", auth_1.authenticated, Webrtc.CreateIceCredentials);
app.post("/webrtc/turn_activity", auth_1.authenticated, Webrtc.CreateTurnActivity);
// Serve cloud UI static files
const uiDistPath = process.env.UI_DIST_PATH || path_1.default.join(__dirname, "../ui-dist");
app.use(express_1.default.static(uiDistPath));
// SPA fallback: serve index.html for browser navigation (Accept: text/html)
// This must be BEFORE API routes so that browser navigation gets the SPA,
// while fetch/XHR requests (Accept: application/json) fall through to API routes
function serveSPA(req, res, next) {
    if (req.method !== "GET")
        return next();
    const accept = req.headers.accept || "";
    // Browser navigation sends Accept: text/html; API calls send application/json
    if (!accept.includes("text/html"))
        return next();
    // Skip pure API paths that are never UI routes
    if (req.path.startsWith("/auth/") ||
        req.path.startsWith("/cloud/") ||
        req.path === "/me" ||
        req.path === "/healthz" ||
        req.path === "/logout") {
        return next();
    }
    res.sendFile(path_1.default.join(uiDistPath, "index.html"), (err) => {
        if (err)
            next();
    });
}
// Error-handling middleware
app.use((err, req, res, next) => {
    const isProduction = process.env.NODE_ENV === "production";
    const statusCode = err instanceof errors_1.HttpError ? err.status : 500;
    const payload = {
        name: err.name,
        message: err.message,
        ...(isProduction ? {} : { stack: err.stack }),
    };
    console.error(err);
    res.status(statusCode).json(payload);
});
const server = app.listen(PORT, () => {
    console.log("Server started on port " + PORT);
});
(0, webrtc_signaling_1.initializeWebRTCSignaling)(server);
