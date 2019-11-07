"use strict";
exports.__esModule = true;
var fs = require("fs");
var winston = require("winston");
// We want the log file to be world-writable, to deal with the case where one user ran bazels3cache,
// and then later a different ran it. (This is a temporary hack; really we need to improve the way
// we do logging rather than just opening a file in /tmp with the permissions of some arbitrary
// user.)
function ensureLogFileWorldWritable(config) {
    var logfile = fs.openSync(config.logging.file, "a");
    fs.closeSync(logfile);
    var stat = fs.statSync(config.logging.file);
    try {
        fs.chmodSync(config.logging.file, stat.mode | 438);
    }
    catch (err) {
        // ignore
    }
}
function initLogging(config) {
    ensureLogFileWorldWritable(config);
    winston.configure({
        level: config.logging.level,
        transports: [
            new (winston.transports.File)({
                filename: config.logging.file,
                json: false
            })
        ],
        padLevels: true
    });
    winston.info("starting");
    process.on("exit", function (exitCode) { return winston.info("terminating with exit code " + exitCode); });
}
exports.initLogging = initLogging;
