"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InternalServerError = exports.UnprocessableEntityError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthorizedError = exports.BadRequestError = exports.HttpError = void 0;
class HttpError extends Error {
    status;
    code;
    constructor(status, m) {
        super(m);
        this.status = status;
    }
}
exports.HttpError = HttpError;
class BadRequestError extends HttpError {
    constructor(message, code) {
        super(400, message);
        this.name = "BadRequestError";
        this.code = code;
    }
}
exports.BadRequestError = BadRequestError;
class UnauthorizedError extends HttpError {
    constructor(message, code) {
        super(401, message);
        this.name = "Unauthorized";
        this.code = code;
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ForbiddenError extends HttpError {
    constructor(message, code) {
        super(403, message);
        this.name = "Forbidden";
    }
}
exports.ForbiddenError = ForbiddenError;
class NotFoundError extends HttpError {
    constructor(message, code) {
        super(404, message);
        this.name = "NotFoundError";
    }
}
exports.NotFoundError = NotFoundError;
class UnprocessableEntityError extends HttpError {
    constructor(message, code) {
        super(422, message);
        this.code = code;
        this.name = "UnprocessableEntityError";
    }
}
exports.UnprocessableEntityError = UnprocessableEntityError;
class InternalServerError extends HttpError {
    constructor(message, code) {
        super(500, message);
        this.code = code;
        this.name = "InternalServerError";
    }
}
exports.InternalServerError = InternalServerError;
