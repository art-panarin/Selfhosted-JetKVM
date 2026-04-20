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
exports.Login = exports.Register = exports.verifyToken = exports.issueToken = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jose = __importStar(require("jose"));
const db_1 = require("./db");
const errors_1 = require("./errors");
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "change-me-32-chars-minimum-secret");
const JWT_ISSUER = "jetkvm-cloud";
const JWT_AUDIENCE = "jetkvm-app";
const JWT_TTL = "24h";
async function issueToken(userId, email) {
    return new jose.SignJWT({ email })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId.toString())
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(JWT_TTL)
        .sign(JWT_SECRET);
}
exports.issueToken = issueToken;
async function verifyToken(token) {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    });
    return payload;
}
exports.verifyToken = verifyToken;
async function Register(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new errors_1.HttpError(400, "Email and password are required");
        }
        if (typeof email !== "string" || typeof password !== "string") {
            throw new errors_1.HttpError(400, "Invalid input types");
        }
        if (password.length < 8) {
            throw new errors_1.HttpError(400, "Password must be at least 8 characters");
        }
        const existing = await db_1.prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw new errors_1.HttpError(409, "Email already registered");
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 12);
        const user = await db_1.prisma.user.create({
            data: { email, passwordHash },
        });
        const token = await issueToken(user.id, user.email);
        req.session.id_token = token;
        return res.status(201).json({ email: user.email });
    }
    catch (err) {
        next(err);
    }
}
exports.Register = Register;
async function Login(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new errors_1.HttpError(400, "Email and password are required");
        }
        const user = await db_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            throw new errors_1.HttpError(401, "Invalid email or password");
        }
        const valid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!valid) {
            throw new errors_1.HttpError(401, "Invalid email or password");
        }
        const token = await issueToken(user.id, user.email);
        req.session.id_token = token;
        return res.json({ email: user.email });
    }
    catch (err) {
        next(err);
    }
}
exports.Login = Login;
