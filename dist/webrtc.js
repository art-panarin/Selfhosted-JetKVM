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
exports.CreateTurnActivity = exports.CreateIceCredentials = exports.CreateSession = void 0;
const jose = __importStar(require("jose"));
const crypto = __importStar(require("crypto"));
const db_1 = require("./db");
const errors_1 = require("./errors");
const webrtc_signaling_1 = require("./webrtc-signaling");
// Build an HMAC-SHA256 identity token the KVM device can verify offline.
// The device already stores its secretToken, so it can recompute and compare.
function buildIdentityToken(secretToken, userId) {
    const ts = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(ts / 60); // 60-second window
    const mac = crypto
        .createHmac("sha256", secretToken)
        .update(`${userId}:${bucket}`)
        .digest("base64");
    return Buffer.from(JSON.stringify({ token: mac, userId, ts })).toString("base64");
}
// Generate coturn HMAC-SHA1 time-limited credentials
function buildTurnCredentials(userId) {
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
const CreateSession = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    const { id, sd } = req.body;
    if (!id)
        throw new errors_1.UnprocessableEntityError("Missing id");
    if (!sd)
        throw new errors_1.UnprocessableEntityError("Missing sd");
    const device = await db_1.prisma.device.findUnique({
        where: { id, user: { id: BigInt(sub) } },
        select: { id: true, secretToken: true },
    });
    if (!device) {
        throw new errors_1.NotFoundError("Device not found");
    }
    if (webrtc_signaling_1.inFlight.has(id)) {
        console.log(`Websocket for ${id} in-flight with another client`);
        throw new errors_1.UnprocessableEntityError(`Websocket for ${id} in-flight with another client`);
    }
    const wsTuple = webrtc_signaling_1.activeConnections.get(id);
    if (!wsTuple) {
        console.log("No socket for id", id);
        throw new errors_1.NotFoundError(`No socket for id found`, "kvm_socket_not_found");
    }
    const [ws, ip] = wsTuple;
    const identityToken = device.secretToken
        ? buildIdentityToken(device.secretToken, sub)
        : "";
    let timeout;
    let httpClose = null;
    try {
        webrtc_signaling_1.inFlight.add(id);
        const resp = await new Promise((res, rej) => {
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
            ws.send(JSON.stringify({
                sd,
                ip,
                iceServers: webrtc_signaling_1.iceServers,
                OidcGoogle: identityToken,
            }));
        });
        console.log("[CreateSession] got response from device", id);
        return res.json(JSON.parse(resp.data));
    }
    catch (e) {
        console.log(`Error sending data to kvm with ${id}`, e);
        return res
            .status(500)
            .json({ error: "There was an error sending and receiving data to the KVM" });
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        console.log("Removing in flight", id);
        webrtc_signaling_1.inFlight.delete(id);
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
exports.CreateSession = CreateSession;
const CreateIceCredentials = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    const data = buildTurnCredentials(sub);
    return res.json(data);
};
exports.CreateIceCredentials = CreateIceCredentials;
const CreateTurnActivity = async (req, res) => {
    const idToken = req.session?.id_token;
    const { sub } = jose.decodeJwt(idToken);
    const { bytesReceived, bytesSent } = req.body;
    await db_1.prisma.turnActivity.create({
        data: {
            bytesReceived,
            bytesSent,
            user: { connect: { id: BigInt(sub) } },
        },
    });
    return res.json({ success: true });
};
exports.CreateTurnActivity = CreateTurnActivity;
