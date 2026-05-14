"use strict";
// src/webrtc-signaling.ts
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
exports.initializeWebRTCSignaling = exports.registerWebSocketRouter = exports.iceServers = exports.inFlight = exports.activeConnections = void 0;
const ws_1 = require("ws");
const jose = __importStar(require("jose"));
const crypto = __importStar(require("crypto"));
const db_1 = require("./db");
const _1 = require(".");
// Maintain the shared state
exports.activeConnections = new Map(); //  [deviceWs, ip, version]
exports.inFlight = new Set();
function toICEServers(str) {
    return str.split(",").filter(url => url.startsWith("stun:"));
}
exports.iceServers = toICEServers(process.env.ICE_SERVERS ||
    "stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:5349");
// Helper function to update device last seen timestamp
async function updateDeviceLastSeen(id) {
    const device = await db_1.prisma.device.findUnique({ where: { id } });
    if (device) {
        return db_1.prisma.device.update({ where: { id }, data: { lastSeen: new Date() } });
    }
}
const wssDevice = new ws_1.WebSocketServer({ noServer: true });
const wssClient = new ws_1.WebSocketServer({ noServer: true });
// WebSocket router - routes WebSocket connections based on URL path
function registerWebSocketRouter(server) {
    server.on("upgrade", async (req, socket, head) => {
        const url = new URL(req.url || "", "http://localhost"); // We don't care about the hostname, we're just using the path to route
        const path = url.pathname;
        // Route to appropriate handler based on path
        // This path should be something like /webrtc/signaling/device, but due to legacy reasons we have to use `/` for device ws regitstrations
        if (path === "/") {
            await handleDeviceSocketRequest(req, socket, head);
        }
        else if (path === "/webrtc/signaling/client") {
            await handleClientSocketRequest(req, socket, head);
        }
        else {
            console.log(`[Webrtc] Unrecognized path: ${path}`);
            return socket.destroy();
        }
    });
}
exports.registerWebSocketRouter = registerWebSocketRouter;
// ==========================================================================
// Device WebSocket handlers
// ==========================================================================
// Handle device WebSocket connection requests
async function handleDeviceSocketRequest(req, socket, head) {
    try {
        // Authenticate device
        const device = await authenticateDeviceRequest(req);
        if (!device) {
            return socket.destroy();
        }
        // Inflight means that the device has connected, a client has connected to that device via HTTP, and they're now doing the signaling dance
        if (exports.inFlight.has(device.id)) {
            console.log(`[Device] Device ${device.id} already has an inflight client connection.`);
            return socket.destroy();
        }
        // Handle existing connections for this device
        if (exports.activeConnections.has(device.id)) {
            console.log(`[Device] Device ${device.id} already connected. Terminating existing connection.`);
            const [existingDeviceWs] = exports.activeConnections.get(device.id);
            await new Promise(resolve => {
                console.log("[Device] Waiting for existing connection to close...");
                existingDeviceWs.on("close", () => {
                    exports.activeConnections.delete(device.id);
                    console.log("[Device] Existing connection closed.");
                    // Now we continue with the new connection
                    resolve(true);
                });
                existingDeviceWs.terminate();
            });
        }
        // Complete the WebSocket upgrade
        wssDevice.handleUpgrade(req, socket, head, ws => {
            setupDeviceWebSocket(ws, device, req);
        });
    }
    catch (error) {
        console.error("Error handling device socket request:", error);
        socket.destroy();
    }
}
// Authenticate the device connection
async function authenticateDeviceRequest(req) {
    const authHeader = req.headers["authorization"];
    const secretToken = authHeader?.split(" ")?.[1];
    if (!secretToken) {
        console.log("[Device] No authorization header provided.");
        return null;
    }
    try {
        const device = await db_1.prisma.device.findFirst({ where: { secretToken } });
        if (!device) {
            console.log("[Device] Invalid secret token provided.");
            return null;
        }
        const id = req.headers["x-device-id"];
        if (!id || id !== device.id) {
            console.log("[Device] Invalid device ID or ID/token mismatch.");
            return null;
        }
        return device;
    }
    catch (error) {
        console.error("[Device] Error authenticating device:", error);
        return null;
    }
}
// Setup the device WebSocket after authentication
function setupDeviceWebSocket(deviceWs, device, req) {
    const id = device.id;
    const ip = (process.env.REAL_IP_HEADER && req.headers[process.env.REAL_IP_HEADER]) ||
        req.socket.remoteAddress;
    const deviceVersion = req.headers["x-app-version"];
    // Store the connection
    exports.activeConnections.set(id, [deviceWs, `${ip}`, deviceVersion || null]);
    console.log(`[Device] New connection for device ${id}, with version ${deviceVersion || "unknown"}`);
    // Setup ping/pong for connection health checks
    // @ts-ignore
    deviceWs.isAlive = true;
    deviceWs.on("pong", function heartbeat() {
        // @ts-ignore
        this.isAlive = true;
    });
    const checkAliveInterval = setInterval(function checkAlive() {
        // @ts-ignore
        if (deviceWs.isAlive === false) {
            console.log(`[Device] ${id} is not alive. Terminating connection.`);
            return deviceWs.terminate();
        }
        // @ts-ignore
        deviceWs.isAlive = false;
        deviceWs.ping();
        // We check for aliveness every 10s
    }, 10000);
    // Handle errors and connection close
    deviceWs.on("error", async (error) => {
        console.log(`[Device] Error for ${id}:`, error);
        await cleanup();
    });
    deviceWs.on("close", async (code, reason) => {
        console.log(`[Device] Connection closed for ${id} with code ${code} and reason ${reason}`);
        await cleanup();
    });
    // Cleanup function
    async function cleanup() {
        console.log(`[Device] Cleanup for ${id}`);
        exports.activeConnections.delete(id);
        clearInterval(checkAliveInterval);
        await updateDeviceLastSeen(id);
    }
}
// ==========================================================================
// Client WebSocket handlers
// ==========================================================================
// Handle client WebSocket connection requests
async function handleClientSocketRequest(req, socket, head) {
    try {
        // Apply session middleware to access authentication
        (0, _1.cookieSessionMiddleware)(req, {}, async () => {
            try {
                // Authenticate client and get device ID
                const { deviceId, token, userId, secretToken } = await authenticateClientRequest(req);
                if (!deviceId) {
                    return socket.destroy();
                }
                // Check if device is connected
                if (!exports.activeConnections.has(deviceId)) {
                    console.log(`[Client] Device ${deviceId} not connected.`);
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    return socket.destroy();
                }
                // Complete the WebSocket upgrade
                wssClient.handleUpgrade(req, socket, head, ws => {
                    setupClientWebSocket(ws, deviceId, token, userId, secretToken);
                });
            }
            catch (error) {
                console.error("Error in client WebSocket setup:", error);
                socket.destroy();
            }
        });
    }
    catch (error) {
        console.error("Error handling client socket request:", error);
        socket.destroy();
    }
}
// Authenticate the client connection
async function authenticateClientRequest(req) {
    const session = req.session;
    const token = session?.id_token;
    if (!token) {
        console.log("[Client] No authentication token.");
        return { deviceId: null };
    }
    try {
        const { sub } = jose.decodeJwt(token);
        const url = new URL(req.url || "", "http://localhost");
        const deviceId = url.searchParams.get("id");
        if (!deviceId) {
            console.log("[Client] No device ID provided.");
            return { deviceId: null };
        }
        // Check if device exists and user has access
        const device = await db_1.prisma.device.findUnique({
            where: { id: deviceId, user: { id: BigInt(sub) } },
            select: { id: true, secretToken: true },
        });
        if (!device) {
            console.log("[Client] Device not found or user doesn't have access.");
            return { deviceId: null };
        }
        return { deviceId, token, userId: sub, secretToken: device.secretToken ?? "" };
    }
    catch (error) {
        console.error("[Client] Authentication error:", error);
        return { deviceId: null };
    }
}
function buildIdentityToken(secretToken, userId) {
    const ts = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(ts / 60);
    const mac = crypto
        .createHmac("sha256", secretToken)
        .update(`${userId}:${bucket}`)
        .digest("base64");
    return Buffer.from(JSON.stringify({ token: mac, userId, ts })).toString("base64");
}
// Setup the client WebSocket after authentication
function setupClientWebSocket(clientWs, deviceId, token, userId, secretToken) {
    console.log(`[Client] New connection for device ${deviceId}`);
    // Get device WebSocket
    const deviceConn = exports.activeConnections.get(deviceId);
    if (!deviceConn) {
        console.log(`[Client] No device connection for ${deviceId}`);
        return clientWs.close();
    }
    const [deviceWs, ip, version] = deviceConn;
    // If there's an active connection with this device, prevent a new one
    if (exports.inFlight.has(deviceId)) {
        console.log(`[Client] Device ${deviceId} already has an active client connection.`);
        return clientWs.close();
    }
    console.log("[Client] Sending client device-metadata, version:", version, " - ", deviceId);
    clientWs.send(JSON.stringify({
        type: "device-metadata",
        data: { deviceVersion: version },
    }));
    // Handle message forwarding from client to device
    clientWs.on("message", data => {
        // Handle ping/pong
        if (data.toString() === "ping")
            return clientWs.send("pong");
        try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
                case "offer":
                    console.log(`[Client] Sending offer to device ${deviceId}`);
                    deviceWs.send(JSON.stringify({
                        type: "offer",
                        data: {
                            sd: msg.data.sd,
                            ip,
                            iceServers: exports.iceServers,
                            OidcGoogle: secretToken ? buildIdentityToken(secretToken, userId) : "",
                        },
                    }));
                    break;
                case "new-ice-candidate":
                    console.log(`[Client] Sending ICE candidate to device ${deviceId}`);
                    deviceWs.send(JSON.stringify({
                        type: "new-ice-candidate",
                        data: msg.data,
                    }));
                    break;
            }
        }
        catch (error) {
            console.error(`[Client] Error processing message for ${deviceId}:`, error);
        }
    });
    // Handle message forwarding from device to client
    const deviceMessageHandler = (event) => {
        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case "answer":
                    console.log(`[Device] Sending answer to client for ${deviceId}`);
                    clientWs.send(JSON.stringify({ type: "answer", data: msg.data }));
                    break;
                case "new-ice-candidate":
                    console.log(`[Device] Sending ICE candidate to client for ${deviceId}`);
                    clientWs.send(JSON.stringify({ type: "new-ice-candidate", data: msg.data }));
                    break;
            }
        }
        catch (error) {
            console.error(`[Device] Error processing message for ${deviceId}:`, error);
        }
    };
    // Store original handlers so we can restore them
    const originalHandlers = {
        onmessage: deviceWs.onmessage,
        onerror: deviceWs.onerror,
        onclose: deviceWs.onclose,
    };
    // Set up device -> client message handling
    deviceWs.onmessage = deviceMessageHandler;
    // Handle device errors and disconnections
    deviceWs.onerror = () => {
        console.log(`[Device] Error, closing client connection for ${deviceId}`);
        cleanup();
        clientWs.close();
    };
    deviceWs.onclose = () => {
        console.log(`[Device] Closed, terminating client connection for ${deviceId}`);
        cleanup();
        clientWs.terminate();
    };
    // Handle client disconnection
    clientWs.on("close", () => {
        console.log(`[Client] Connection closed for ${deviceId}`);
        cleanup();
    });
    // Cleanup function
    function cleanup() {
        // Restore original device handlers
        deviceWs.onmessage = originalHandlers.onmessage;
        deviceWs.onerror = originalHandlers.onerror;
        deviceWs.onclose = originalHandlers.onclose;
        // Remove from in-flight set
        exports.inFlight.delete(deviceId);
    }
}
// Export a single initialization function
function initializeWebRTCSignaling(server) {
    registerWebSocketRouter(server);
}
exports.initializeWebRTCSignaling = initializeWebRTCSignaling;
