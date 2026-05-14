"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeviceRolloutBucket = exports.toSemverRange = exports.verifyHash = exports.streamToBuffer = exports.streamToString = void 0;
const crypto_1 = require("crypto");
const errors_1 = require("./errors");
const semver_1 = require("semver");
// Helper function to convert stream to string
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    const result = Buffer.concat(chunks).toString("utf-8");
    return result.trimEnd();
}
exports.streamToString = streamToString;
// Helper function to convert stream to buffer
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
exports.streamToBuffer = streamToBuffer;
async function verifyHash(file, hashFile, exception) {
    const content = await streamToBuffer(file.Body);
    const remoteHash = await streamToString(hashFile.Body);
    const localHash = (0, crypto_1.createHash)("sha256")
        .update(new Uint8Array(content))
        .digest("hex");
    const matches = remoteHash.trim() === localHash;
    if (!matches && exception) {
        throw new errors_1.InternalServerError(exception);
    }
    return matches;
}
exports.verifyHash = verifyHash;
function toSemverRange(range) {
    if (!range)
        return "*";
    return (0, semver_1.validRange)(range) || "*";
}
exports.toSemverRange = toSemverRange;
/**
 * Computes a deterministic rollout bucket (0-99) for a device ID.
 * Used to decide if a device is eligible for a staged rollout.
 */
function getDeviceRolloutBucket(deviceId) {
    const hash = (0, crypto_1.createHash)("md5").update(deviceId).digest("hex");
    const hashPrefix = hash.substring(0, 8);
    return parseInt(hashPrefix, 16) % 100;
}
exports.getDeviceRolloutBucket = getDeviceRolloutBucket;
