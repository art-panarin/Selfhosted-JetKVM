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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Delete = exports.Adopt = exports.Token = exports.Update = exports.Retrieve = exports.List = void 0;
const jose = __importStar(require("jose"));
const crypto = __importStar(require("crypto"));
const db_1 = require("./db");
const errors_1 = require("./errors");
const auth_1 = require("./auth");
const webrtc_signaling_1 = require("./webrtc-signaling");
// Build an HMAC-SHA256 identity token for the KVM device to verify offline.
function buildIdentityToken(secretToken, userId) {
    const ts = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(ts / 60);
    const mac = crypto
        .createHmac("sha256", secretToken)
        .update(`${userId}:${bucket}`)
        .digest("base64");
    return Buffer.from(JSON.stringify({ token: mac, userId, ts })).toString("base64");
}
const List = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    const devices = await db_1.prisma.device.findMany({
        where: { user: { id: BigInt(sub) } },
        select: { id: true, name: true, lastSeen: true },
    });
    return res.json({
        devices: devices.map(device => {
            const activeDevice = webrtc_signaling_1.activeConnections.get(device.id);
            const version = activeDevice?.[2] || null;
            return { ...device, online: !!activeDevice, version };
        }),
    });
};
exports.List = List;
const Retrieve = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    const { id } = req.params;
    if (!id)
        throw new errors_1.UnprocessableEntityError("Missing device id in params");
    const device = await db_1.prisma.device.findUnique({
        where: { id, user: { id: BigInt(sub) } },
        select: { id: true, name: true },
    });
    if (!device)
        throw new errors_1.NotFoundError("Device not found");
    return res.status(200).json({ device });
};
exports.Retrieve = Retrieve;
const Update = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    if (!sub)
        throw new errors_1.UnauthorizedError("Missing sub in token");
    const { id } = req.params;
    if (!id)
        throw new errors_1.UnprocessableEntityError("Missing device id in params");
    const { name } = req.body;
    if (!name)
        throw new errors_1.UnprocessableEntityError("Missing name in body");
    const device = await db_1.prisma.device.update({
        where: { id, user: { id: BigInt(sub) } },
        data: { name },
        select: { id: true },
    });
    return res.json(device);
};
exports.Update = Update;
// Called by the KVM device itself to exchange a tempToken for a secretToken.
// Used when the device is registering without the web adoption flow.
const Token = async (req, res) => {
    const { tempToken } = req.body;
    if (!tempToken)
        throw new errors_1.UnprocessableEntityError("Missing temp token in body");
    const device = await db_1.prisma.device.findFirst({ where: { tempToken } });
    if (!device?.tempToken)
        throw new errors_1.NotFoundError("Device not found");
    if ((device?.tempTokenExpiresAt || 0) < new Date())
        throw new errors_1.UnauthorizedError("Token expired");
    const secretToken = crypto.randomBytes(20).toString("hex");
    await db_1.prisma.device.update({
        where: { id: device.id },
        data: { secretToken, tempToken: null, tempTokenExpiresAt: null },
    });
    return res.json({ secretToken });
};
exports.Token = Token;
// Called by the authenticated web UI to adopt (claim) a KVM device.
// Body: { deviceId, deviceUrl }
//   deviceId  - the hardware ID shown on the KVM device screen
//   deviceUrl - the KVM device's local web address (e.g. http://192.168.1.100)
// Returns a redirectUrl pointing to the KVM device's /adopt page with all needed params.
const Adopt = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    if (!sub)
        throw new errors_1.UnauthorizedError("Missing sub in token");
    const { deviceId, deviceUrl } = req.body;
    if (!deviceId)
        throw new errors_1.UnprocessableEntityError("Missing deviceId in body");
    if (!deviceUrl)
        throw new errors_1.UnprocessableEntityError("Missing deviceUrl in body");
    // Check if device is already adopted by another user
    const existing = await db_1.prisma.device.findUnique({
        where: { id: deviceId },
        select: { userId: true },
    });
    if (existing && existing.userId !== BigInt(sub)) {
        throw new errors_1.BadRequestError("Device is already adopted by another user");
    }
    const secretToken = crypto.randomBytes(20).toString("hex");
    const identityToken = buildIdentityToken(secretToken, sub);
    const cloudApiUrl = process.env.API_HOSTNAME || "";
    // Upsert the device record and link it to the user
    await db_1.prisma.device.upsert({
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
exports.Adopt = Adopt;
const Delete = async (req, res) => {
    if (req.headers.authorization?.startsWith("Bearer ")) {
        const secretToken = req.headers.authorization.split("Bearer ")[1];
        const hasDevice = await db_1.prisma.device.findUnique({ where: { secretToken } });
        if (!hasDevice)
            throw new errors_1.NotFoundError("Device not found");
        await db_1.prisma.device.delete({ where: { secretToken } });
        return res.status(204).send();
    }
    // If the user doesn't have a secret token, we check their session cookie
    try {
        await new Promise(resolve => {
            (0, auth_1.authenticated)(req, res, () => {
                resolve();
            });
        });
    }
    catch (error) {
        throw new errors_1.BadRequestError("Unauthorized");
    }
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    if (!sub)
        throw new errors_1.UnauthorizedError("Missing sub in token");
    const { id } = req.params;
    if (!id)
        throw new errors_1.UnprocessableEntityError("Missing device id in params");
    await db_1.prisma.device.delete({ where: { id, user: { id: BigInt(sub) } } });
    const conn = webrtc_signaling_1.activeConnections.get(id);
    if (conn) {
        const [socket] = conn;
        socket.send("Deregistered from server");
        socket.close();
    }
    return res.status(204).send();
};
exports.Delete = Delete;
