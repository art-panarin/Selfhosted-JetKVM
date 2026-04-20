"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticated = exports.isIdentityAllowed = void 0;
const errors_1 = require("./errors");
const email_auth_1 = require("./email-auth");
const ALLOWED_IDENTITIES = process.env.ALLOWED_IDENTITIES?.split(",")
    .map((identity) => identity.trim().toLowerCase())
    .filter(Boolean);
const getAllowedIdentities = () => {
    if (!ALLOWED_IDENTITIES)
        return null;
    return ALLOWED_IDENTITIES.length > 0 ? new Set(ALLOWED_IDENTITIES) : null;
};
const isIdentityAllowed = (identity) => {
    const allowedIdentities = getAllowedIdentities();
    const identityNormalized = identity?.trim().toLowerCase();
    if (!allowedIdentities)
        return true;
    if (!identityNormalized)
        return false;
    return allowedIdentities.has(identityNormalized);
};
exports.isIdentityAllowed = isIdentityAllowed;
const authenticated = async (req, res, next) => {
    const idToken = req.session?.id_token;
    if (!idToken)
        throw new errors_1.UnauthorizedError();
    let payload;
    try {
        payload = await (0, email_auth_1.verifyToken)(idToken);
    }
    catch {
        throw new errors_1.UnauthorizedError();
    }
    if (!payload.exp)
        throw new errors_1.UnauthorizedError();
    if (new Date(payload.exp * 1000) < new Date()) {
        throw new errors_1.UnauthorizedError();
    }
    const email = payload.email;
    if (!(0, exports.isIdentityAllowed)(email)) {
        throw new errors_1.UnauthorizedError("Account is not in the allowlist", "account_not_allowed");
    }
    next();
};
exports.authenticated = authenticated;
