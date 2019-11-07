"use strict";
exports.__esModule = true;
var path = require("path");
var fs = require("fs");
var os = require("os");
var commentJson = require("comment-json");
var VError = require("verror");
// Merges zero or more JSON objects.
// Not type-safe, alas. And not fancy ES6, alas.
// There is no good way to use the "..." (spread) operator here,
// because we don't want to clobber entire sub-objects.For example,
// Suppose sources[0] is:
//
//     {
//         "port": 1234,
//         ...,
//         "cache": {
//             "enabled": "false",
//             "maxEntrySizeBytes": 1000000,
//             "maxTotalSizeBytes": 50000000
//         },
//     }
//
// And we want to only override maxEntrySizeBytes, nothing else,
// with this:
//
//     {
//         "cache": {
//             "maxEntrySizeBytes": 1000
//         }
//     }
//
// The spread operator would clobber the entire "cache" object, thus
// deleting cache.enabled and cache.maxTotalSizeBytes.
function merge() {
    var sources = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        sources[_i] = arguments[_i];
    }
    var target = {};
    sources.forEach(function (source) {
        Object.keys(source).forEach(function (key) {
            var value = source[key];
            if (typeof value === "object" && value !== null) {
                target[key] = merge(target[key] || {}, value);
            }
            else {
                if (value === "true")
                    value = true;
                if (value === "false")
                    value = false;
                target[key] = value;
            }
        });
    });
    return target;
}
function readConfigFile(pth) {
    var configJsonText = fs.readFileSync(pth, "utf8");
    try {
        return commentJson.parse(configJsonText);
    }
    catch (e) {
        throw new VError(e, "Error reading configuration file " + pth);
    }
}
function ensureInteger(name, value) {
    if (typeof value === "string") {
        if (!value.match(/^[0-9]+$/)) {
            throw "Expected '" + name + "' to be an integer; got '" + value + "'";
        }
        value = parseInt(value);
    }
    if (typeof value === "number") {
        if (Math.floor(value) !== value) {
            throw "Expected '" + name + "' to be an integer; got '" + value + "'";
        }
    }
    else {
        throw "Expected '" + name + "' to be an integer; got '" + value + "'";
    }
    return value;
}
// When this function is called, logging has not yet been set up (because
// the logging depends on the configuration). So don't make any winston
// logging calls from here.
function getConfig(args) {
    var defaultConfig = readConfigFile(path.join(__dirname, "../config.default.json"));
    var userConfigPath = path.join(process.env.HOME, ".config/bazels3cache/config.json");
    var userConfig = fs.existsSync(userConfigPath)
        ? readConfigFile(userConfigPath)
        : {};
    var commandLineConfig = (args.config)
        ? readConfigFile(args.config)
        : {};
    // Merge the different configs in order -- the later ones override the earlier ones:
    var mergedConfig = merge(defaultConfig, // .../config.default.json
    userConfig, // ~/.config/bazels3cache/config.json
    commandLineConfig, // --config myconfig.json
    args // rest of command line, e.g. --port 1234
    );
    mergedConfig.asyncUpload.cacheDir = mergedConfig.asyncUpload.cacheDir.replace(/^~/, os.homedir());
    mergedConfig.logging.file = mergedConfig.logging.file.replace(/^~/, os.homedir());
    return mergedConfig;
}
exports.getConfig = getConfig;
// If any validation fails, returns a string which should be displayed as an error message.
// If validation succeeds, returns null.
function validateConfig(config) {
    if (!config.bucket) {
        throw "S3 bucket is required, e.g. 'bazels3cache --bucket=<bucketname>'";
    }
    config = merge(config, { port: ensureInteger("port", config.port) });
    if (config.port < 1024 || config.port > 65535) {
        throw "Port must be in the range 1024..65535";
    }
    if (config.cache.maxEntrySizeBytes > config.cache.maxTotalSizeBytes) {
        throw "max entry size (" + config.cache.maxEntrySizeBytes + ") must be <= max total size (" + config.cache.maxTotalSizeBytes + ")";
    }
    return config;
}
exports.validateConfig = validateConfig;
