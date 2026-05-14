"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetrieveLatestApp = exports.RetrieveLatestSystemRecovery = exports.Retrieve = exports.clearCaches = void 0;
const db_1 = require("./db");
const errors_1 = require("./errors");
const semver_1 = __importDefault(require("semver"));
const client_s3_1 = require("@aws-sdk/client-s3");
const lru_cache_1 = require("lru-cache");
const helpers_1 = require("./helpers");
const zod_1 = require("zod");
const DEFAULT_SKU = "jetkvm-v2";
/** Query param schema builders for common patterns */
const queryString = () => zod_1.z
    .string()
    .optional()
    .transform(v => v || undefined);
const queryBoolean = () => zod_1.z
    .string()
    .optional()
    .transform(v => v === "true");
const querySku = () => zod_1.z
    .string()
    .optional()
    .transform(v => v || DEFAULT_SKU);
/**
 * Schema for redirect endpoints (RetrieveLatestApp, RetrieveLatestSystemRecovery).
 * Only needs prerelease flag and SKU (defaults to jetkvm-v2).
 */
const latestQuerySchema = zod_1.z.object({
    prerelease: queryBoolean(),
    sku: querySku(),
});
/**
 * Schema for the main Retrieve endpoint.
 * Requires deviceId and includes version constraints and forceUpdate flag.
 */
const retrieveQuerySchema = zod_1.z.object({
    deviceId: zod_1.z.string({ error: "Device ID is required" }).min(1, "Device ID is required"),
    prerelease: queryBoolean(),
    appVersion: queryString(),
    systemVersion: queryString(),
    sku: querySku(),
    forceUpdate: queryBoolean(),
});
/**
 * Parses query parameters and converts ZodError to BadRequestError.
 */
function parseQuery(schema, req) {
    try {
        return schema.parse(req.query);
    }
    catch (error) {
        if (error instanceof zod_1.ZodError) {
            const message = error.issues.map((e) => e.message).join(", ");
            throw new errors_1.BadRequestError(message);
        }
        throw error;
    }
}
const s3Client = new client_s3_1.S3Client({
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    region: "auto",
});
const releaseCache = new lru_cache_1.LRUCache({
    max: 1000,
    ttl: 5 * 60 * 1000, // 5 minutes
});
const MISSING_SIG_URL = false;
const sigUrlCache = new lru_cache_1.LRUCache({
    max: 1000,
    ttl: 5 * 60 * 1000, // 5 minutes
});
const redirectCache = new lru_cache_1.LRUCache({
    max: 1000,
    ttl: 5 * 60 * 1000, // 5 minutes
});
/** Clear all caches - useful for testing */
function clearCaches() {
    releaseCache.clear();
    redirectCache.clear();
    sigUrlCache.clear();
}
exports.clearCaches = clearCaches;
const bucketName = process.env.R2_BUCKET;
const baseUrl = process.env.R2_CDN_URL;
/**
 * Checks if an object exists in S3/R2 by attempting a HeadObjectCommand.
 * Returns true if the object exists, false otherwise.
 */
async function s3ObjectExists(key) {
    try {
        await s3Client.send(new client_s3_1.HeadObjectCommand({ Bucket: bucketName, Key: key }));
        return true;
    }
    catch (error) {
        // HeadObjectCommand throws NotFound, but some S3-compatible stores (like R2) may throw NoSuchKey
        if (error.name === "NotFound" ||
            error.name === "NoSuchKey" ||
            error.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw error;
    }
}
/**
 * Checks if a version was uploaded with SKU folder structure.
 * Returns true if any skus/ subfolder exists for this version.
 */
async function versionHasSkuSupport(prefix, version) {
    const response = await s3Client.send(new client_s3_1.ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${prefix}/${version}/skus/`,
        MaxKeys: 1,
    }));
    return (response.Contents?.length ?? 0) > 0;
}
/**
 * Resolves the artifact path for a given version and SKU.
 *
 * For versions with SKU support (skus/ folder exists):
 *   - Uses the provided SKU
 *   - Fails if the requested SKU is not available
 *
 * For legacy versions (no skus/ folder):
 *   - Returns legacy path for default SKU
 *   - Fails for non-default SKUs because legacy firmware predates
 *     that hardware and may not be compatible
 *
 * @param prefix - The prefix folder ("app" or "system")
 * @param version - The version string
 * @param sku - SKU identifier (defaults to jetkvm-v2 from schema)
 * @param artifactOverride - Optional artifact name override (defaults based on prefix)
 */
async function resolveArtifactPath(prefix, version, sku, artifactOverride) {
    const artifact = artifactOverride ?? (prefix === "app" ? "jetkvm_app" : "system.tar");
    if (await versionHasSkuSupport(prefix, version)) {
        const skuPath = `${prefix}/${version}/skus/${sku}/${artifact}`;
        if (await s3ObjectExists(skuPath)) {
            return skuPath;
        }
        throw new errors_1.NotFoundError(`SKU "${sku}" is not available for version ${version}`);
    }
    // SKU defaults to "jetkvm-v2" via zod schema when not provided.
    //
    // For legacy versions (pre-SKU folder structure), we only serve the default SKU.
    // This prevents newer hardware variants from rolling back to old firmware
    // that may not have compatible binaries for their hardware.
    if (sku === DEFAULT_SKU) {
        return `${prefix}/${version}/${artifact}`;
    }
    throw new errors_1.NotFoundError(`Version ${version} predates SKU support and cannot serve SKU "${sku}"`);
}
/**
 * Resolves the signature URL for a given version if a .sig file exists in S3.
 * Results are cached for 5 minutes.
 */
async function resolveSigUrl(prefix, version, sku) {
    const cacheKey = `${prefix}-${version}-${sku}`;
    const cached = sigUrlCache.get(cacheKey);
    if (cached !== undefined)
        return cached === MISSING_SIG_URL ? undefined : cached;
    try {
        const path = await resolveArtifactPath(prefix, version, sku);
        const sigKey = `${path}.sig`;
        if (await s3ObjectExists(sigKey)) {
            const url = `${baseUrl}/${sigKey}`;
            sigUrlCache.set(cacheKey, url);
            return url;
        }
    }
    catch (error) {
        if (error instanceof errors_1.NotFoundError) {
            // Version doesn't exist for this SKU — cache as absent
            sigUrlCache.set(cacheKey, MISSING_SIG_URL);
            return undefined;
        }
        // Don't cache transient errors (network, permissions, etc.)
        throw error;
    }
    sigUrlCache.set(cacheKey, MISSING_SIG_URL);
    return undefined;
}
/**
 * Enriches a Release response with signature URLs by checking S3 for .sig files.
 * Transient S3 errors are logged but don't block the response — sigUrl is optional.
 */
async function enrichWithSigUrls(release, sku) {
    const [appSigUrl, systemSigUrl] = await Promise.all([
        release.appVersion
            ? resolveSigUrl("app", release.appVersion, sku).catch(e => {
                console.error(`Failed to resolve app sig URL for ${release.appVersion}:`, e);
                return undefined;
            })
            : undefined,
        release.systemVersion
            ? resolveSigUrl("system", release.systemVersion, sku).catch(e => {
                console.error(`Failed to resolve system sig URL for ${release.systemVersion}:`, e);
                return undefined;
            })
            : undefined,
    ]);
    if (appSigUrl)
        release.appSigUrl = appSigUrl;
    if (systemSigUrl)
        release.systemSigUrl = systemSigUrl;
}
async function getLatestVersion(prefix, includePrerelease, maxSatisfying = "*", sku) {
    const cacheKey = `${prefix}-${includePrerelease}-${maxSatisfying}-${sku}`;
    const cached = releaseCache.get(cacheKey);
    if (cached)
        return cached;
    const listCommand = new client_s3_1.ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix + "/",
        Delimiter: "/",
    });
    const response = await s3Client.send(listCommand);
    if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
        throw new errors_1.NotFoundError(`No versions found under prefix ${prefix}`);
    }
    // Extract version folder names
    let versions = response.CommonPrefixes.map(cp => cp.Prefix.split("/")[1])
        .filter(Boolean)
        .filter(v => semver_1.default.valid(v));
    if (versions.length === 0) {
        throw new errors_1.NotFoundError(`No valid versions found under prefix ${prefix}`);
    }
    // Get the latest version, optionally including prerelease versions
    const latestVersion = semver_1.default.maxSatisfying(versions, maxSatisfying, {
        includePrerelease,
    });
    if (!latestVersion) {
        throw new errors_1.NotFoundError(`No version found under prefix ${prefix} that satisfies ${maxSatisfying}`);
    }
    const selectedPath = await resolveArtifactPath(prefix, latestVersion, sku);
    const url = `${baseUrl}/${selectedPath}`;
    const hashResponse = await s3Client.send(new client_s3_1.GetObjectCommand({
        Bucket: bucketName,
        Key: `${selectedPath}.sha256`,
    }));
    const hash = await (0, helpers_1.streamToString)(hashResponse.Body);
    // Cache the release metadata
    const release = {
        version: latestVersion,
        url,
        hash,
        _cachedAt: Date.now(),
        _maxSatisfying: maxSatisfying,
    };
    releaseCache.set(cacheKey, release);
    return release;
}
function setAppRelease(release, appRelease) {
    release.appVersion = appRelease.version;
    release.appUrl = appRelease.url;
    release.appHash = appRelease.hash;
    release.appCachedAt = appRelease._cachedAt;
    release.appMaxSatisfying = appRelease._maxSatisfying;
}
function setSystemRelease(release, systemRelease) {
    release.systemVersion = systemRelease.version;
    release.systemUrl = systemRelease.url;
    release.systemHash = systemRelease.hash;
    release.systemCachedAt = systemRelease._cachedAt;
    release.systemMaxSatisfying = systemRelease._maxSatisfying;
}
function toRelease(appRelease, systemRelease) {
    const release = {};
    if (appRelease)
        setAppRelease(release, appRelease);
    if (systemRelease)
        setSystemRelease(release, systemRelease);
    return release;
}
async function getReleaseFromS3(includePrerelease, { appVersion, systemVersion, sku, }) {
    const [appRelease, systemRelease] = await Promise.all([
        getLatestVersion("app", includePrerelease, appVersion, sku),
        getLatestVersion("system", includePrerelease, systemVersion, sku),
    ]);
    return toRelease(appRelease, systemRelease);
}
async function isDeviceEligibleForLatestRelease(rolloutPercentage, deviceId) {
    if (rolloutPercentage === 100)
        return true;
    return (0, helpers_1.getDeviceRolloutBucket)(deviceId) < rolloutPercentage;
}
async function getDefaultRelease(type) {
    const rolledOutReleases = await db_1.prisma.release.findMany({
        where: { rolloutPercentage: 100, type },
        select: { version: true, url: true, hash: true },
    });
    if (rolledOutReleases.length === 0) {
        throw new errors_1.InternalServerError(`No default release found for type ${type}`);
    }
    // Get the latest default version from the rolled out releases
    const latestVersion = semver_1.default.maxSatisfying(rolledOutReleases.map(r => r.version), "*");
    // Get the release with the latest default version
    const latestDefaultRelease = rolledOutReleases.find(r => r.version === latestVersion);
    if (!latestDefaultRelease) {
        throw new errors_1.InternalServerError(`No default release found for type ${type}`);
    }
    return latestDefaultRelease;
}
async function Retrieve(req, res) {
    const query = parseQuery(retrieveQuerySchema, req);
    const appVersion = (0, helpers_1.toSemverRange)(query.appVersion);
    const systemVersion = (0, helpers_1.toSemverRange)(query.systemVersion);
    const skipRollout = appVersion !== "*" || systemVersion !== "*";
    // Get the latest release from S3
    let remoteRelease;
    try {
        remoteRelease = await getReleaseFromS3(query.prerelease, {
            appVersion,
            systemVersion,
            sku: query.sku,
        });
    }
    catch (error) {
        console.error(error);
        if (error instanceof errors_1.NotFoundError) {
            throw error;
        }
        throw new errors_1.InternalServerError(`Failed to get the latest release from S3: ${error}`);
    }
    // If the request is for prereleases, ignore the rollout percentage and just return the latest release
    // This is useful for the OTA updater to get the latest prerelease version
    // This also prevents us from storing the rollout percentage for prerelease versions
    // If the version isn't a wildcard, we skip the rollout percentage check
    if (query.prerelease || skipRollout) {
        await enrichWithSigUrls(remoteRelease, query.sku);
        return res.json(remoteRelease);
    }
    // Fetch or create the latest app release
    const latestAppRelease = await db_1.prisma.release.upsert({
        where: { version_type: { version: remoteRelease.appVersion, type: "app" } },
        update: {},
        create: {
            version: remoteRelease.appVersion,
            rolloutPercentage: 10,
            url: remoteRelease.appUrl,
            type: "app",
            hash: remoteRelease.appHash,
        },
        select: { version: true, url: true, rolloutPercentage: true, hash: true },
    });
    // Fetch or create the latest system release
    const latestSystemRelease = await db_1.prisma.release.upsert({
        where: { version_type: { version: remoteRelease.systemVersion, type: "system" } },
        update: {},
        create: {
            version: remoteRelease.systemVersion,
            rolloutPercentage: 10,
            url: remoteRelease.systemUrl,
            type: "system",
            hash: remoteRelease.systemHash,
        },
        select: { version: true, url: true, rolloutPercentage: true, hash: true },
    });
    /*
      Return the latest release if forceUpdate is true, bypassing rollout rules.
      This occurs when a user manually checks for updates in the app UI.
      Background update checks follow the normal rollout percentage rules, to ensure controlled, gradual deployment of updates.
    */
    let responseJson;
    if (query.forceUpdate) {
        responseJson = toRelease(latestAppRelease, latestSystemRelease);
    }
    else {
        const defaultAppRelease = await getDefaultRelease("app");
        const defaultSystemRelease = await getDefaultRelease("system");
        responseJson = toRelease(defaultAppRelease, defaultSystemRelease);
        if (await isDeviceEligibleForLatestRelease(latestAppRelease.rolloutPercentage, query.deviceId)) {
            setAppRelease(responseJson, latestAppRelease);
        }
        if (await isDeviceEligibleForLatestRelease(latestSystemRelease.rolloutPercentage, query.deviceId)) {
            setSystemRelease(responseJson, latestSystemRelease);
        }
    }
    // DB records don't store sigUrl. Resolve from S3 for the versions being served.
    // The device requires sigUrl for stable (non-prerelease) GPG signature verification.
    await enrichWithSigUrls(responseJson, query.sku);
    return res.json(responseJson);
}
exports.Retrieve = Retrieve;
function cachedRedirect(cachedKey, callback) {
    return async (req, res) => {
        const query = parseQuery(latestQuerySchema, req);
        const cacheKey = cachedKey(query);
        let result = redirectCache.get(cacheKey);
        if (!result) {
            result = await callback(query);
            redirectCache.set(cacheKey, result);
        }
        return res.redirect(302, result);
    };
}
/**
 * Generates a cache key for release endpoints based on prefix, prerelease flag, and SKU.
 */
function releaseCacheKey(prefix, query) {
    return `${prefix}-${query.prerelease ? "pre" : "stable"}-${query.sku}`;
}
exports.RetrieveLatestSystemRecovery = cachedRedirect(query => releaseCacheKey("system-recovery", query), async (query) => {
    // Get the latest system recovery image from S3. It's stored in the system/ folder.
    const listCommand = new client_s3_1.ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: "system/",
        Delimiter: "/",
    });
    const response = await s3Client.send(listCommand);
    // Extract version folder names
    if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
        throw new errors_1.NotFoundError(`No versions found under prefix system recovery image`);
    }
    // Get the latest version
    const versions = response.CommonPrefixes.map(cp => cp.Prefix.split("/")[1])
        .filter(Boolean)
        .filter(v => semver_1.default.valid(v));
    const latestVersion = semver_1.default.maxSatisfying(versions, "*", {
        includePrerelease: query.prerelease,
    });
    if (!latestVersion) {
        throw new errors_1.NotFoundError("No valid system recovery versions found");
    }
    // Resolve the artifact path with SKU support (using update.img for recovery)
    const artifactPath = await resolveArtifactPath("system", latestVersion, query.sku, "update.img");
    const [firmwareFile, hashFile] = await Promise.all([
        // TODO: store file hash using custom header to avoid extra request
        s3Client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucketName,
            Key: artifactPath,
        })),
        s3Client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucketName,
            Key: `${artifactPath}.sha256`,
        })),
    ]);
    if (!firmwareFile.Body || !hashFile.Body) {
        throw new errors_1.NotFoundError(`No system recovery image or hash file not found for version ${latestVersion}`);
    }
    await (0, helpers_1.verifyHash)(firmwareFile, hashFile, "system recovery image hash does not match");
    console.log("system recovery image hash matches", latestVersion);
    return `${baseUrl}/${artifactPath}`;
});
exports.RetrieveLatestApp = cachedRedirect(query => releaseCacheKey("app", query), async (query) => {
    // Get the latest version
    const listCommand = new client_s3_1.ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: "app/",
        Delimiter: "/",
    });
    const response = await s3Client.send(listCommand);
    if (!response.CommonPrefixes || response.CommonPrefixes.length === 0) {
        throw new errors_1.NotFoundError("No app versions found");
    }
    const versions = response.CommonPrefixes.map(cp => cp.Prefix.split("/")[1]).filter(v => semver_1.default.valid(v));
    const latestVersion = semver_1.default.maxSatisfying(versions, "*", {
        includePrerelease: query.prerelease,
    });
    if (!latestVersion) {
        throw new errors_1.NotFoundError("No valid app versions found");
    }
    // Resolve the artifact path with SKU support
    const artifactPath = await resolveArtifactPath("app", latestVersion, query.sku);
    // Get the app file and its hash
    const [appFile, hashFile] = await Promise.all([
        s3Client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucketName,
            Key: artifactPath,
        })),
        s3Client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucketName,
            Key: `${artifactPath}.sha256`,
        })),
    ]);
    if (!appFile.Body || !hashFile.Body) {
        throw new errors_1.NotFoundError(`App or hash file not found for version ${latestVersion}`);
    }
    await (0, helpers_1.verifyHash)(appFile, hashFile, "app hash does not match");
    console.log("App hash matches", latestVersion);
    return `${baseUrl}/${artifactPath}`;
});
