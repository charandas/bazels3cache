"use strict";
exports.__esModule = true;
var fs = require("fs");
var child_process = require("child_process");
var https = require("https");
var AWS = require("aws-sdk");
var minimist = require("minimist");
var winston = require("winston");
var config_1 = require("./config");
var server_1 = require("./server");
var logging_1 = require("./logging");
function fatalError(error) {
    console.error("bazels3cache: " + error); // the user should see this
    winston.error(error); // this goes to the log
    process.exitCode = 1;
}
function daemonMain(args, onDoneInitializing) {
    process.on("uncaughtException", function (err) {
        fatalError("" + err);
        process.exit(1); // hard stop; can't rely on just process.exitCode
    });
    var config = config_1.getConfig(args);
    logging_1.initLogging(config); // Do this early, because when logging doesn't work, we're flying blind
    config_1.validateConfig(config); // throws if config is invalid
    var chain = new AWS.CredentialProviderChain(null);
    chain.resolvePromise()
        .then(function (credentials) {
        AWS.config.update({
            httpOptions: {
                agent: new https.Agent({
                    keepAlive: true,
                    keepAliveMsecs: 60000
                })
            },
            credentials: credentials
        });
        return new AWS.S3({
            apiVersion: "2006-03-01",
            credentials: credentials
        });
    })["catch"](function (err) {
        var message = "Could not resolve AWS credentials: " + err.message;
        fatalError(message);
    })
        .then(function (s3) {
        if (s3) {
            server_1.startServer(s3, config, onDoneInitializing);
        }
    })["catch"](function (err) {
        var message = err.message || "" + err;
        fatalError(message);
    });
}
function main(args) {
    var DONE_INITIALIZING = "done_initializing";
    // When bazels3cache launches, it spawns a child bazels3cache with "--daemon"
    // added to the command line.
    //
    // The parent process then waits until that child process either exits, or sends
    // us a "done_initializing" message. Then the parent process exits.
    if (args.indexOf("--daemon") === -1) {
        // We are parent process
        var devnull = fs.openSync("/dev/null", "r+");
        // As described here https://github.com/nodejs/node/issues/17592, although
        // child_process.fork() doesn't officially support `detached: true`, it works
        var child_1 = child_process.fork(__filename, ["--daemon"].concat(args), { detached: true });
        // This is so that if we terminate *without* receiving a "done_initializig"
        // message from the child process, that's because the child process
        // terminated unexpectedly, so we should exit with an error code.
        //
        // While we're waiting, the child process still has stdout and stderr, and
        // can send any messages to there.
        process.exitCode = 1;
        child_1.on("message", function (msg) {
            if (msg === DONE_INITIALIZING) {
                child_1.unref(); // don't wait for the child process to terminate
                child_1.disconnect(); // don't wait on the ipc channel any more
                process.exitCode = 0; // now we can exit cleanly
            }
        });
    }
    else {
        // child process
        daemonMain(minimist(args), function () {
            // Now that the daemon has finished initializing, we need to:
            // - close stdin, stdout, and stderr, so that we don't keep these handles
            //   open cause problems
            // - open /dev/null for all three of those
            // - send a "done_initializing" message to our parent process.
            fs.closeSync(0);
            fs.closeSync(1);
            fs.closeSync(2);
            // Odd: If I don't do the following, then sometimes writes such as
            // console.log() still show up on the screen. I don't get it.
            process.stdout.write = process.stderr.write = function () { return undefined; };
            fs.openSync("/dev/null", "r+"); // stdin
            fs.openSync("/dev/null", "r+"); // stdout
            fs.openSync("/dev/null", "r+"); // stderr
            // Tells the parent that we initialized successfully and it can exit
            process.send(DONE_INITIALIZING);
        });
    }
}
main(process.argv.slice(2));
