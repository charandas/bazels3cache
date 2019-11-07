"use strict";
exports.__esModule = true;
var debug_ = require("debug");
var debugCache = debug_("bazels3cache:cache");
;
var Cache = /** @class */ (function () {
    function Cache(config) {
        this.config = config;
        this.size = 0;
        this.head = null; // the newest element in the cache
        this.tail = null; // the oldest
        this.entries = {};
    }
    Cache.prototype.contains = function (s3key) {
        return this.entries.hasOwnProperty(s3key);
    };
    Cache.prototype.get = function (s3key) {
        var node = this.entries[s3key];
        if (node) {
            this._moveNodeToHead(node);
            return node.buffer;
        }
        else {
            return null;
        }
    };
    Cache.prototype["delete"] = function (s3key) {
        if (this.entries.hasOwnProperty(s3key)) {
            this._deleteNode(this.entries[s3key]);
            return true;
        }
        else {
            return false;
        }
    };
    Cache.prototype.maybeAdd = function (s3key, buffer) {
        if (this.config.cache.enabled) {
            this["delete"](s3key);
            if (buffer.byteLength < this.config.cache.maxEntrySizeBytes) {
                this._makeSpace(buffer.byteLength);
                var node = {
                    s3key: s3key,
                    buffer: buffer,
                    prev: null,
                    next: this.head
                };
                if (node.next)
                    node.next.prev = node;
                this.head = node;
                if (!this.tail)
                    this.tail = node;
                this.entries[s3key] = node;
                this.size += buffer.byteLength;
                debugCache("Added " + s3key + " size=" + buffer.byteLength + ", total size = " + this.size);
            }
        }
    };
    Cache.prototype._makeSpace = function (newItemLength) {
        if (this.config.cache.enabled) {
            while (this.size > 0 && this.size + newItemLength > this.config.cache.maxTotalSizeBytes) {
                this._deleteNode(this.tail);
            }
        }
    };
    Cache.prototype._moveNodeToHead = function (node) {
        this._deleteNode(node);
        this.maybeAdd(node.s3key, node.buffer);
    };
    Cache.prototype._deleteNode = function (node) {
        if (node.prev) {
            node.prev.next = node.next;
        }
        else {
            this.head = node.next;
        }
        if (node.next) {
            node.next.prev = node.prev;
        }
        else {
            this.tail = node.prev;
        }
        this.size -= node.buffer.byteLength;
        delete this.entries[node.s3key];
        debugCache("Removed " + node.s3key + " size=" + node.buffer.byteLength + ", total size = " + this.size);
    };
    return Cache;
}());
exports.Cache = Cache;
