"use strict";
exports.__esModule = true;
var fs = require("fs");
var http = require("http");
var path = require("path");
var mkdirp = require("mkdirp");
var rimraf = require("rimraf");
var winston = require("winston");
var memorycache_1 = require("./memorycache");
var debug_1 = require("./debug");
// just the ones we need...
var StatusCode;
(function (StatusCode) {
    StatusCode[StatusCode["OK"] = 200] = "OK";
    StatusCode[StatusCode["Forbidden"] = 403] = "Forbidden";
    StatusCode[StatusCode["NotFound"] = 404] = "NotFound";
    StatusCode[StatusCode["MethodNotAllowed"] = 405] = "MethodNotAllowed";
})(StatusCode || (StatusCode = {}));
;
function logProps(req, res, attrs) {
    var endTime = new Date();
    var elapsedMillis = (endTime.getTime() - attrs.startTime.getTime());
    var loglineItems = [
        req.method,
        req.url,
        res.statusCode,
        attrs.responseLength,
        elapsedMillis + "ms",
        attrs.fromCache && "(from cache)",
        attrs.awsPaused && "(aws paused)",
        attrs.isBlockedGccDepfile && "(blocked gcc depfile)"
    ];
    var logline = loglineItems
        .filter(function (item) { return ["string", "number"].indexOf(typeof item) !== -1; })
        .join(" ");
    debug_1.debug(logline);
    winston.info(logline);
}
function sendResponse(req, res, body, attrs) {
    var responseLength;
    if (body instanceof Buffer) {
        responseLength = body.byteLength;
    }
    else if (typeof body === "string") {
        responseLength = body.length;
    }
    else if (typeof body === "number") {
        responseLength = body;
    }
    else {
        responseLength = 0;
    }
    logProps(req, res, {
        startTime: attrs.startTime,
        responseLength: responseLength,
        fromCache: attrs.fromCache,
        awsPaused: attrs.awsPaused,
        isBlockedGccDepfile: attrs.isBlockedGccDepfile
    });
    res.end.apply(res, (body instanceof Buffer || typeof body === "string") ? [body] : []);
}
function isIgnorableError(err) {
    // TODO add a comment explaining this
    return err.retryable === true;
}
function shouldIgnoreError(err, config) {
    return config.allowOffline && isIgnorableError(err);
}
function getHttpResponseStatusCode(err, codeIfIgnoringError, config) {
    if (shouldIgnoreError(err, config)) {
        return codeIfIgnoringError;
    }
    else {
        return err.statusCode || StatusCode.NotFound;
    }
}
function prepareErrorResponse(res, err, codeIfIgnoringError, config) {
    res.statusCode = getHttpResponseStatusCode(err, codeIfIgnoringError, config);
    res.setHeader("Content-Type", "application/json");
    res.write(JSON.stringify(err, null, "  "));
}
function pathToUploadCache(s3key, config) {
    return path.join(config.asyncUpload.cacheDir, s3key);
}
function startServer(s3, config, onDoneInitializing) {
    var cache = new memorycache_1.Cache(config); // in-memory cache
    var idleTimer;
    var awsPauseTimer;
    var awsErrors = 0;
    var awsPaused = false;
    var pendingUploadBytes = 0;
    function onAWSError(req, s3error) {
        var message = req.method + " " + req.url + ": " + (s3error.message || s3error.code);
        debug_1.debug(message);
        winston.error(message);
        winston.verbose(JSON.stringify(s3error, null, "  "));
        if (++awsErrors >= config.errorsBeforePausing) {
            winston.warn("Encountered " + awsErrors + " consecutive AWS errors; pausing AWS access for " + config.pauseMinutes + " minutes");
            awsPaused = true;
            awsPauseTimer = setTimeout(function () {
                winston.warn("Unpausing AWS access; attempting to resume normal caching");
                awsPaused = false;
                awsErrors = 0;
                awsPauseTimer = null;
            }, config.pauseMinutes * 60 * 1000);
            awsPauseTimer.unref(); // prevent this timer from delaying shutdown
        }
    }
    function onAWSSuccess() {
        awsErrors = 0;
    }
    function clearAsyncUploadCache() {
        rimraf.sync(config.asyncUpload.cacheDir);
    }
    function shutdown(logMessage) {
        if (logMessage) {
            winston.info(logMessage);
        }
        // Delete all temp files that are waiting to be uploaded
        clearAsyncUploadCache();
        // We have to forcefully shut down, because we were told to do so, and who knows
        // what other background tasks might currently be taking place, e.g. various
        // uploads to S3.
        process.exit();
    }
    function safeUnlinkSync(pth) {
        try {
            fs.unlinkSync(pth);
        }
        catch (e) {
            winston.error(e);
        }
    }
    function isGccDepfile(body) {
        return body.length <= 100000 && body.indexOf(".o: \\") >= 0;
    }
    // We are starting up; if there are any left-over temp files that were supposed to be
    // uploaded by the previous instance of the bazels3cache, delete them
    clearAsyncUploadCache();
    var server = http.createServer(function (req, res) {
        res.setTimeout(config.socketTimeoutSeconds * 1000, function () {
            // Oh well, we can't wait forever bail out on this request and close the socket
            winston.warn("Socket timeout reached. Returning NotFound");
            res.statusCode = StatusCode.NotFound;
            sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
        });
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        if (config.idleMinutes) {
            idleTimer = setTimeout(function () {
                shutdown("Idle for " + config.idleMinutes + " minutes; terminating");
            }, config.idleMinutes * 60 * 1000);
            idleTimer.unref(); // prevent this timer from delaying shutdown
        }
        var startTime = new Date();
        var s3key = req.url.slice(1); // remove leading "/"
        switch (req.method) {
            case "GET": {
                if (s3key === "ping") {
                    sendResponse(req, res, "pong", { startTime: startTime, awsPaused: awsPaused });
                }
                else if (s3key === "shutdown") {
                    sendResponse(req, res, "shutting down", { startTime: startTime, awsPaused: awsPaused });
                    shutdown("Received 'GET /shutdown'; terminating");
                }
                else if (cache.contains(s3key)) {
                    // we already have it in our in-memory cache
                    sendResponse(req, res, cache.get(s3key), {
                        startTime: startTime,
                        fromCache: true,
                        awsPaused: awsPaused
                    });
                }
                else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                }
                else {
                    var s3request = s3.getObject({
                        Bucket: config.bucket,
                        Key: s3key
                    }).promise();
                    s3request
                        .then(function (data) {
                        if (!config.allowGccDepfiles && isGccDepfile(data.Body)) {
                            res.statusCode = StatusCode.NotFound;
                            sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused, isBlockedGccDepfile: true });
                        }
                        else {
                            cache.maybeAdd(s3key, data.Body); // safe cast?
                            sendResponse(req, res, data.Body, {
                                startTime: startTime,
                                awsPaused: awsPaused
                            });
                        }
                        onAWSSuccess();
                    })["catch"](function (err) {
                        // 404 is not an error; it just means we successfully talked to S3
                        // and S3 told us there was no such item.
                        if (err.statusCode === StatusCode.NotFound) {
                            onAWSSuccess();
                        }
                        else {
                            onAWSError(req, err);
                        }
                        // If the error is an ignorable one (e.g. the user is offline), then
                        // return 404 Not Found.
                        prepareErrorResponse(res, err, StatusCode.NotFound, config);
                        sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                    });
                }
                break;
            }
            case "PUT": {
                if (req.url === "/") {
                    res.statusCode = StatusCode.Forbidden;
                    sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                }
                else {
                    var pth_1 = pathToUploadCache(s3key, config);
                    if (fs.existsSync(pth_1)) {
                        // We are apparently already uploading this file. Don't try to start a
                        // second upload of the same file.
                        res.statusCode = StatusCode.OK;
                        sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                        return;
                    }
                    mkdirp.sync(path.dirname(pth_1));
                    req.pipe(fs.createWriteStream(pth_1)).on("close", function () {
                        var size;
                        try {
                            size = fs.statSync(pth_1).size;
                        }
                        catch (e) {
                            // This should not happen, but we have seen it on testville
                            winston.error(e);
                            sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                            return;
                        }
                        if (awsPaused) {
                            res.statusCode = StatusCode.OK;
                            sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                            safeUnlinkSync(pth_1);
                        }
                        else if (config.maxEntrySizeBytes !== 0 && size > config.maxEntrySizeBytes) {
                            // The item is bigger than we want to allow in our S3 cache.
                            winston.info("Not uploading " + s3key + ", because size " + size + " exceeds maxEntrySizeBytes " + config.maxEntrySizeBytes);
                            res.statusCode = StatusCode.OK; // tell Bazel the PUT succeeded
                            sendResponse(req, res, size, { startTime: startTime, awsPaused: awsPaused });
                            safeUnlinkSync(pth_1);
                        }
                        else if (pendingUploadBytes + size > config.asyncUpload.maxPendingUploadMB * 1024 * 1024) {
                            winston.info("Not uploading " + s3key + ", because there are already too many pending uploads");
                            res.statusCode = StatusCode.OK; // tell Bazel the PUT succeeded
                            sendResponse(req, res, size, { startTime: startTime, awsPaused: awsPaused });
                            safeUnlinkSync(pth_1);
                        }
                        else {
                            pendingUploadBytes += size;
                            var streamedBody = fs.createReadStream(pth_1);
                            var s3request = s3.upload({
                                Bucket: config.bucket,
                                Key: s3key,
                                Body: streamedBody,
                                // Very important: The bucket owner needs full control of the uploaded
                                // object, so that they can share the object with all the appropriate
                                // users
                                ACL: "bucket-owner-full-control"
                            }).promise();
                            s3request
                                .then(function () {
                                if (!config.asyncUpload.enabled) {
                                    sendResponse(req, res, size, { startTime: startTime, awsPaused: awsPaused });
                                }
                                onAWSSuccess();
                            })["catch"](function (err) {
                                onAWSError(req, err);
                                if (!config.asyncUpload.enabled) {
                                    // If the error is an ignorable one (e.g. the user is offline), then
                                    // return 200 OK -- pretend the PUT succeeded.
                                    prepareErrorResponse(res, err, StatusCode.OK, config);
                                    sendResponse(req, res, size, { startTime: startTime, awsPaused: awsPaused });
                                }
                            })
                                .then(function () {
                                pendingUploadBytes -= size;
                                safeUnlinkSync(pth_1);
                            });
                            if (config.asyncUpload.enabled) {
                                // Send the response back immediately, even though the upload to S3 has not
                                // taken place yet. This allows Bazel to remain unblocked while large uploads
                                // take place.
                                //
                                // We don't know if the upload will succeed or fail; we just say it succeeded.
                                sendResponse(req, res, size, { startTime: startTime, awsPaused: awsPaused });
                            }
                        }
                    });
                }
                break;
            }
            case "HEAD": {
                if (cache.contains(s3key)) {
                    sendResponse(req, res, null, { startTime: startTime, fromCache: true, awsPaused: awsPaused });
                }
                else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                }
                else {
                    var s3request = s3.headObject({
                        Bucket: config.bucket,
                        Key: s3key
                    }).promise();
                    s3request
                        .then(function (data) {
                        sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                        onAWSSuccess();
                    })["catch"](function (err) {
                        onAWSError(req, err);
                        // If the error is an ignorable one (e.g. the user is offline), then
                        // return 404 Not Found.
                        prepareErrorResponse(res, err, StatusCode.NotFound, config);
                        sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                    });
                }
                break;
            }
            case "DELETE": {
                cache["delete"](s3key);
                var s3request = s3.deleteObject({
                    Bucket: config.bucket,
                    Key: s3key
                }).promise();
                s3request
                    .then(function () {
                    onAWSSuccess();
                    sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                })["catch"](function (err) {
                    onAWSError(req, err);
                    prepareErrorResponse(res, err, StatusCode.NotFound, config);
                    sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
                });
                break;
            }
            default: {
                res.statusCode = StatusCode.MethodNotAllowed;
                sendResponse(req, res, null, { startTime: startTime, awsPaused: awsPaused });
            }
        }
    });
    server.on("error", function (e) {
        var message = "could not start server: " + e.message;
        winston.error(message);
        console.error("bazels3cache: " + message);
        process.exitCode = 1;
    });
    server.listen(config.port, config.host, function () {
        var logfile = path.resolve(config.logging.file);
        debug_1.debug("started server at http://" + config.host + ":" + config.port + "/");
        winston.info("started server at http://" + config.host + ":" + config.port + "/");
        console.log("bazels3cache: started server at http://" + config.host + ":" + config.port + "/, logging to " + logfile);
        onDoneInitializing();
    });
}
exports.startServer = startServer;
