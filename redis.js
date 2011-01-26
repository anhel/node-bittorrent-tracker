/*global Buffer require exports console setTimeout */

var net = require("net"),
    util,
    events = require("events"),
    default_port = 6379,
    default_host = "127.0.0.1";

// hilarious 0.2.x to 0.3.x API change
try {
    util = require("util");
} catch (err) {
    util = require("sys");
}

// can can set this to true to enable for all connections
exports.debug_mode = false;

function RedisReplyParser() {
    this.reset();
    events.EventEmitter.call(this);
}
util.inherits(RedisReplyParser, events.EventEmitter);

// Buffer.toString() is quite slow for small strings
function small_toString(buf) {
    var tmp = "", i, il;

    for (i = 0, il = buf.end; i < il; i += 1) {
        tmp += String.fromCharCode(buf[i]);
    }

    return tmp;
}

function to_array(args) {
    var len = args.length,
        arr = new Array(len), i;

    for (i = 0; i < len; i += 1) {
        arr[i] = args[i];
    }

    return arr;
}

// Reset parser to it's original state.
RedisReplyParser.prototype.reset = function () {
    this.state = "type";

    this.return_buffer = new Buffer(16384); // for holding replies, might grow
    this.tmp_buffer = new Buffer(128); // for holding size fields

    this.multi_bulk_length = 0;
    this.multi_bulk_replies = null;
    this.multi_bulk_nested_length = 0;
    this.multi_bulk_nested_replies = null;
};

RedisReplyParser.prototype.execute = function (incoming_buf) {
    var pos = 0, bd_tmp, bd_str, i, il;
    //, state_times = {}, start_execute = new Date(), start_switch, end_switch, old_state;
    //start_switch = new Date();

    while (pos < incoming_buf.length) {
    //    old_state = this.state;
        // console.log("execute: " + this.state + ", " + pos + "/" + incoming_buf.length + ", " + String.fromCharCode(incoming_buf[pos]));

        switch (this.state) {
        case "type":
            this.type = incoming_buf[pos];
            pos += 1;

            switch (this.type) {
            case 43: // +
                this.state = "single line";
                this.return_buffer.end = 0;
                break;
            case 42: // *
                this.state = "multi bulk count";
                this.tmp_buffer.end = 0;
                break;
            case 58: // :
                this.state = "integer line";
                this.return_buffer.end = 0;
                break;
            case 36: // $
                this.state = "bulk length";
                this.tmp_buffer.end = 0;
                break;
            case 45: // -
                this.state = "error line";
                this.return_buffer.end = 0;
                break;
            default:
                this.state = "unknown type";
            }
            break;
        case "integer line":
            if (incoming_buf[pos] === 13) {
                this.send_reply(+small_toString(this.return_buffer));
                this.state = "final lf";
            } else {
                this.return_buffer[this.return_buffer.end] = incoming_buf[pos];
                this.return_buffer.end += 1;
            }
            pos += 1;
            break;
        case "error line":
            if (incoming_buf[pos] === 13) {
                this.send_error(this.return_buffer.toString("ascii", 0, this.return_buffer.end));
                this.state = "final lf";
            } else {
                this.return_buffer[this.return_buffer.end] = incoming_buf[pos];
                this.return_buffer.end += 1;
            }
            pos += 1;
            break;
        case "single line":
            if (incoming_buf[pos] === 13) {
                if (this.return_buffer.end > 10) {
                    bd_str = this.return_buffer.toString("utf8", 0, this.return_buffer.end);
                } else {
                    bd_str = small_toString(this.return_buffer);
                    
                }
                this.send_reply(bd_str);
                this.state = "final lf";
            } else {
                this.return_buffer[this.return_buffer.end] = incoming_buf[pos];
                this.return_buffer.end += 1;
                // TODO - check for return_buffer overflow and then grow, copy, continue, and drink.
            }
            pos += 1;
            break;
        case "multi bulk count":
            if (incoming_buf[pos] === 13) { // \r
                this.state = "multi bulk count lf";
            } else {
                this.tmp_buffer[this.tmp_buffer.end] = incoming_buf[pos];
                this.tmp_buffer.end += 1;
            }
            pos += 1;
            break;
        case "multi bulk count lf":
            if (incoming_buf[pos] === 10) { // \n
                if (this.multi_bulk_length) { // nested multi-bulk
                    this.multi_bulk_nested_length = this.multi_bulk_length;
                    this.multi_bulk_nested_replies = this.multi_bulk_replies;
                }
                this.multi_bulk_length = +small_toString(this.tmp_buffer);
                this.multi_bulk_replies = [];
                this.state = "type";
                if (this.multi_bulk_length < 0) {
                    this.send_reply(null);
                    this.multi_bulk_length = 0;
                } else if (this.multi_bulk_length === 0) {
                    this.send_reply([]);
                }
            } else {
                this.emit("error", new Error("didn't see LF after NL reading multi bulk count"));
                this.reset();
                return;
            }
            pos += 1;
            break;
        case "bulk length":
            if (incoming_buf[pos] === 13) { // \r
                this.state = "bulk lf";
            } else {
                this.tmp_buffer[this.tmp_buffer.end] = incoming_buf[pos];
                this.tmp_buffer.end += 1;
            }
            pos += 1;
            break;
        case "bulk lf":
            if (incoming_buf[pos] === 10) { // \n
                this.bulk_length = +small_toString(this.tmp_buffer);
                if (this.bulk_length === -1) {
                    this.send_reply(null);
                    this.state = "type";
                } else if (this.bulk_length === 0) {
                    this.send_reply(new Buffer(""));
                    this.state = "final cr";
                } else {
                    this.state = "bulk data";
                    if (this.bulk_length > this.return_buffer.length) {
                        if (exports.debug_mode) {
                            console.log("Growing return_buffer from " + this.return_buffer.length + " to " + this.bulk_length);
                        }
                        this.return_buffer = new Buffer(this.bulk_length);
                        // home the old one gets cleaned up somehow
                    }
                    this.return_buffer.end = 0;
                }
            } else {
                this.emit("error", new Error("didn't see LF after NL while reading bulk length"));
                this.reset();
                return;
            }
            pos += 1;
            break;
        case "bulk data":
            this.return_buffer[this.return_buffer.end] = incoming_buf[pos];
            this.return_buffer.end += 1;
            pos += 1;
            // TODO - should be faster to use Bufer.copy() here, especially if the response is large.
            // However, when the response is small, Buffer.copy() seems a lot slower.  Computers are hard.
            if (this.return_buffer.end === this.bulk_length) {
                bd_tmp = new Buffer(this.bulk_length);
                if (this.bulk_length > 10) {
                    this.return_buffer.copy(bd_tmp, 0, 0, this.bulk_length);
                } else {
                    for (i = 0, il = this.bulk_length; i < il; i += 1) {
                        bd_tmp[i] = this.return_buffer[i];
                    }
                }
                this.send_reply(bd_tmp);
                this.state = "final cr";
            }
            break;
        case "final cr":
            if (incoming_buf[pos] === 13) { // \r
                this.state = "final lf";
                pos += 1;
            } else {
                this.emit("error", new Error("saw " + incoming_buf[pos] + " when expecting final CR"));
                this.reset();
                return;
            }
            break;
        case "final lf":
            if (incoming_buf[pos] === 10) { // \n
                this.state = "type";
                pos += 1;
            } else {
                this.emit("error", new Error("saw " + incoming_buf[pos] + " when expecting final LF"));
                this.reset();
                return;
            }
            break;
        default:
            throw new Error("invalid state " + this.state);
        }
        // end_switch = new Date();
        // if (state_times[old_state] === undefined) {
        //     state_times[old_state] = 0;
        // }
        // state_times[old_state] += (end_switch - start_switch);
        // start_switch = end_switch;
    }
    // console.log("execute ran for " + (Date.now() - start_execute) + " ms, on " + incoming_buf.length + " Bytes. ");
    // Object.keys(state_times).forEach(function (state) {
    //     console.log("    " + state + ": " + state_times[state]);
    // });
};

RedisReplyParser.prototype.send_error = function (reply) {
    if (this.multi_bulk_length > 0 || this.multi_bulk_nested_length > 0) {
        // TODO - can this happen?  Seems like maybe not.
        this.add_multi_bulk_reply(reply);
    } else {
        this.emit("reply error", reply);
    }
};

RedisReplyParser.prototype.send_reply = function (reply) {
    if (this.multi_bulk_length > 0 || this.multi_bulk_nested_length > 0) {
        this.add_multi_bulk_reply(reply);
    } else {
        this.emit("reply", reply);
    }
};

RedisReplyParser.prototype.add_multi_bulk_reply = function (reply) {
    if (this.multi_bulk_replies) {
        this.multi_bulk_replies.push(reply);
        // use "less than" here because a nil mb reply claims "0 length", but we need 1 slot to hold it
        if (this.multi_bulk_replies.length < this.multi_bulk_length) {
            return;
        }
    } else {
        this.multi_bulk_replies = reply;
    }

    if (this.multi_bulk_nested_length > 0) {
        this.multi_bulk_nested_replies.push(this.multi_bulk_replies);
        this.multi_bulk_length = 0;
        delete this.multi_bulk_replies;
        if (this.multi_bulk_nested_length === this.multi_bulk_nested_replies.length) {
            this.emit("reply", this.multi_bulk_nested_replies);
            this.multi_bulk_nested_length = 0;
            this.multi_bulk_nested_replies = null;
        }
    } else {
        this.emit("reply", this.multi_bulk_replies);
        this.multi_bulk_length = 0;
        this.multi_bulk_replies = null;
    }
};

// Queue class adapted from Tim Caswell's pattern library
// http://github.com/creationix/pattern/blob/master/lib/pattern/queue.js
var Queue = function () {
    this.tail = [];
    this.head = to_array(arguments);
    this.offset = 0;
};

Queue.prototype.shift = function () {
    if (this.offset === this.head.length) {
        var tmp = this.head;
        tmp.length = 0;
        this.head = this.tail;
        this.tail = tmp;
        this.offset = 0;
        if (this.head.length === 0) {
            return;
        }
    }
    return this.head[this.offset++]; // sorry, JSLint
};

Queue.prototype.push = function (item) {
    return this.tail.push(item);
};

Queue.prototype.forEach = function (fn, thisv) {
    var array = this.head.slice(this.offset), i, il;

    array.push.apply(array, this.tail);

    if (thisv) {
        for (i = 0, il = array.length; i < il; i += 1) {
            fn.call(thisv, array[i], i, array);
        }
    } else {
        for (i = 0, il = array.length; i < il; i += 1) {
            fn(array[i], i, array);
        }
    }

    return array;
};

Object.defineProperty(Queue.prototype, 'length', {
    get: function () {
        return this.head.length - this.offset + this.tail.length;
    }
});

function RedisClient(stream, options) {
    events.EventEmitter.call(this);

    this.stream = stream;
    this.options = options;
    
    this.connected = false;
    this.connections = 0;
    this.attempts = 1;
    this.command_queue = new Queue(); // holds sent commands to de-pipeline them
    this.offline_queue = new Queue(); // holds commands issued but not able to be sent
    this.commands_sent = 0;
    this.retry_delay = 250;
    this.retry_backoff = 1.7;
    this.subscriptions = false;
    this.closing = false;

    var self = this;

    this.stream.on("connect", function () {
        if (exports.debug_mode) {
            console.log("Stream connected");
        }
        self.connected = true;
        self.connections += 1;
        self.command_queue = new Queue();
        self.emitted_end = false;

        self.reply_parser = new RedisReplyParser();
        // "reply error" is an error sent back by redis
        self.reply_parser.on("reply error", function (reply) {
            self.return_error(reply);
        });
        self.reply_parser.on("reply", function (reply) {
            self.return_reply(reply);
        });
        // "error" is bad.  Somehow the parser got confused.  It'll try to reset and continue.
        self.reply_parser.on("error", function (err) {
            self.emit("error", new Error("Redis reply parser error: " + err.stack));
        });

        self.retry_timer = null;
        self.retry_delay = 250;
        self.stream.setNoDelay();
        self.stream.setTimeout(0);

        // give connect listeners a chance to run first in case they need to auth
        self.emit("connect");

        var command_obj;
        while (self.offline_queue.length > 0) {
            command_obj = self.offline_queue.shift();
            if (exports.debug_mode) {
                console.log("Sending offline command: " + command_obj.command);
            }
            self.send_command(command_obj.command, command_obj.args, command_obj.callback);
        }
    });
    
    this.stream.on("data", function (buffer_from_socket) {
        self.on_data(buffer_from_socket);
    });

    this.stream.on("error", function (msg) {
        if (this.closing) {
            return;
        }
        
        var message = "Redis connection to " + self.host + ":" + self.port + " failed - " + msg.message;

        if (exports.debug_mode) {
            console.warn(message);
        }
        self.offline_queue.forEach(function (args) {
            if (typeof args[2] === "function") {
                args[2](message);
            }
        });
        
        self.connected = false;
        self.emit("error", new Error(message));
    });

    this.stream.on("close", function () {
        self.connection_gone("close");
    });

    this.stream.on("end", function () {
        self.connection_gone("end");
    });
    
    this.stream.on("drain", function () {
        self.emit("drain");
    });

    events.EventEmitter.call(this);
}
util.inherits(RedisClient, events.EventEmitter);
exports.RedisClient = RedisClient;

RedisClient.prototype.connection_gone = function (why) {
    var self = this;

    // If a retry is already in progress, just let that happen
    if (self.retry_timer) {
        return;
    }

    // Note that this may trigger another "close" or "end" event
    self.stream.destroy();

    if (exports.debug_mode) {
        console.warn("Redis connection is gone from " + why + " event.");
    }
    self.connected = false;
    self.subscriptions = false;

    // since we are collapsing end and close, users don't expect to be called twice
    if (! self.emitted_end) {
        self.emit("end");
        self.emitted_end = true;
    }
    
    self.command_queue.forEach(function (args) {
        if (typeof args[2] === "function") {
            args[2]("Server connection closed");
        }
    });

    // If this is a requested shutdown, then don't retry
    if (self.closing) {
        self.retry_timer = null;
        return;
    }
    
    if (exports.debug_mode) {
        console.log("Retry conneciton in " + self.retry_delay + " ms");
    }
    self.attempts += 1;
    self.emit("reconnecting", "delay " + self.retry_delay + ", attempt " + self.attempts);
    self.retry_timer = setTimeout(function () {
        if (exports.debug_mode) {
            console.log("Retrying connection...");
        }
        self.retry_delay = self.retry_delay * self.retry_backoff;
        self.stream.connect(self.port, self.host);
        self.retry_timer = null;
    }, self.retry_delay);
};

RedisClient.prototype.on_data = function (data) {
    if (exports.debug_mode) {
        console.log("on_data: " + data.toString());
    }
    
    try {
        this.reply_parser.execute(data);
    } catch (err) {
        this.emit("error", err);   // this needs to be a different event from connection error
    }
};

RedisClient.prototype.return_error = function (err) {
    var command_obj = this.command_queue.shift();

    if (this.subscriptions === false && this.command_queue.length === 0) {
        this.emit("idle");
    }
    
    if (command_obj && typeof command_obj.callback === "function") {
        command_obj.callback(err);
    } else {
        console.log("no callback to send error: " + util.inspect(err));
        // this will probably not make it anywhere useful, but we might as well throw
        throw new Error(err);
    }
};

RedisClient.prototype.return_reply = function (reply) {
    var command_obj = this.command_queue.shift(),
        obj, i, len, key, val, type;

    if (this.subscriptions === false && this.command_queue.length === 0) {
        this.emit("idle");
    }
    
    if (command_obj) {
        if (typeof command_obj.callback === "function") {
            // HGETALL special case replies with keyed Buffers
            if (reply && 'hgetall' === command_obj.command.toLowerCase()) {
                obj = {};
                for (i = 0, len = reply.length; i < len; i += 2) {
                    key = reply[i].toString();
                    val = reply[i + 1];
                    obj[key] = val;
                }
                reply = obj;
            }

            command_obj.callback(null, reply);
        } else if (exports.debug_mode) {
            console.log("no callback for reply: " + (reply && reply.toString && reply.toString()));
        }
    } else if (this.subscriptions) {
        if (Array.isArray(reply)) {
            type = reply[0].toString();

            if (type === "message") {
                this.emit("message", reply[1].toString(), reply[2]); // channel, message
            } else if (type === "pmessage") {
                this.emit("pmessage", reply[1].toString(), reply[2].toString(), reply[3]); // pattern, channel, message
            } else if (type === "subscribe" || type === "unsubscribe" || type === "psubscribe" || type === "punsubscribe") {
                if (reply[2] === 0) {
                    this.subscriptions = false;
                    if (this.debug_mode) {
                        console.log("All subscriptions removed, exiting pub/sub mode");
                    }
                }
                this.emit(type, reply[1].toString(), reply[2]); // channel, count
            } else {
                throw new Error("subscriptions are active but got unknown reply type " + type);
            }
        } else {
            throw new Error("subscriptions are active but got an invalid reply: " + reply);
        }
    }
};

RedisClient.prototype.send_command = function () {
    var command, callback, arg, args, this_args, command_obj, i, il,
        elem_count, stream = this.stream, buffer_args, command_str = "";

    this_args = to_array(arguments);

    if (this_args.length === 0) {
        throw new Error("send_command: not enough arguments");
    }

    if (typeof this_args[0] !== "string") {
        throw new Error("First argument of send_command must be the command name");
    }
    command = this_args[0].toLowerCase();

    if (this_args[1] && Array.isArray(this_args[1])) { 
        args = this_args[1];
        if (typeof this_args[2] === "function") {
            callback = this_args[2];
        }
    } else {
        if (typeof this_args[this_args.length - 1] === "function") {
            callback = this_args[this_args.length - 1];
            args = this_args.slice(1, this_args.length - 1);
        } else {
            args = this_args.slice(1, this_args.length);
        }
    }
    
    command_obj = {
        command: command,
        args: args,
        callback: callback
    };

    if (! this.connected) {
        if (exports.debug_mode) {
            console.log("Queueing " + command + " for next server connection.");
        }
        this.offline_queue.push(command_obj);
        return;
    }

    if (command === "subscribe" || command === "psubscribe" || command === "unsubscribe" || command === "punsubscribe") {
        if (this.subscriptions === false && exports.debug_mode) {
            console.log("Entering pub/sub mode from " + command);
        }
        this.subscriptions = true;
    } else {
        if (command === "quit") {
            this.closing = true;
        } else if (this.subscriptions === true) {
            throw new Error("Connection in pub/sub mode, only pub/sub commands may be used");
        }
        this.command_queue.push(command_obj);
    }
    this.commands_sent += 1;

    elem_count = 1;
    buffer_args = false;

    elem_count += args.length;
    // Probably should just scan this like a normal person
    buffer_args = args.some(function (arg) {
        // this is clever, but might be slow
        return arg instanceof Buffer;
    });

    // Always use "Multi bulk commands", but if passed any Buffer args, then do multiple writes, one for each arg
    // This means that using Buffers in commands is going to be slower, so use Strings if you don't need binary.

    command_str = "*" + elem_count + "\r\n$" + command.length + "\r\n" + command + "\r\n";

    if (! stream.writable && exports.debug_mode) {
        console.log("send command: stream is not writeable, should get a close event next tick.");
        return;
    }
    
    if (! buffer_args) { // Build up a string and send entire command in one write
        for (i = 0, il = args.length, arg; i < il; i += 1) {
            arg = args[i];
            if (typeof arg !== "string") {
                arg = String(arg);
            }
            command_str += "$" + Buffer.byteLength(arg) + "\r\n" + arg + "\r\n";
        }
        if (exports.debug_mode) {
            console.log("send command: " + command_str);
        }
        stream.write(command_str);
    } else {
        if (exports.debug_mode) {
            console.log("send command: " + command_str);
            console.log("send command has Buffer arguments");
        }
        stream.write(command_str);

        for (i = 0, il = args.length, arg; i < il; i += 1) {
            arg = args[i];
            if (arg.length === undefined) {
                arg = String(arg);
            }

            if (arg instanceof Buffer) {
                if (arg.length === 0) {
                    if (exports.debug_mode) {
                        console.log("Using empty string for 0 length buffer");
                    }
                    stream.write("$0\r\n\r\n");
                } else {
                    stream.write("$" + arg.length + "\r\n");
                    stream.write(arg);
                    stream.write("\r\n");
                }
            } else {
                stream.write("$" + Buffer.byteLength(arg) + "\r\n" + arg + "\r\n");
            }
        }
    }
};

RedisClient.prototype.end = function () {
    this.stream._events = {};
    this.connected = false;
    return this.stream.end();
};


function Multi(client, args) {
    this.client = client;
    this.queue = [["MULTI"]];
    if (Array.isArray(args)) {
        this.queue = this.queue.concat(args);
    }
}


// Official source is: http://code.google.com/p/redis/wiki/CommandReference 
// This list is taken from src/redis.c
[
    // string commands
    "get", "set", "setnx", "setex", "append", "substr", "strlen", "del", "exists", "incr", "decr", "mget", 
    // list commands
    "rpush", "lpush", "rpushx", "lpushx", "linsert", "rpop", "lpop", "brpop", "blpop", "llen", "lindex", "lset", "lrange", "ltrim", "lrem", "rpoplpush",
    // set commands
    "sadd", "srem", "smove", "sismember", "scard", "spop", "srandmember", "sinter", "sinterstore", "sunion", "sunionstore", "sdiff", "sdiffstore", "smembers",
    // sorted set commands
    "zadd", "zincrby", "zrem", "zremrangebyscore", "zremrangebyrank", "zunionstore", "zinterstore", "zrange", "zrangebyscore", "zrevrangebyscore", 
    "zcount", "zrevrange", "zcard", "zscore", "zrank", "zrevrank",
    // hash commands
    "hset", "hsetnx", "hget", "hmset", "hmget", "hincrby", "hdel", "hlen", "hkeys", "hgetall", "hexists", "incrby", "decrby",
    // misc
    "getset", "mset", "msetnx", "randomkey", "select", "move", "rename", "renamenx", "expire", "expireat", "keys", "dbsize", "auth", "ping", "echo",
    "save", "bgsave", "bgwriteaof", "shutdown", "lastsave", "type", "sync", "flushdb", "flushall", "sort", "info", 
    "monitor", "ttl", "persist", "slaveof", "debug", "config", "subscribe", "unsubscribe", "psubscribe", "punsubscribe", "publish", "watch", "unwatch",
    "quit"
].forEach(function (command) {
    RedisClient.prototype[command] = function () {
        var args = to_array(arguments);
        args.unshift(command); // put command at the beginning
        this.send_command.apply(this, args);
    };
    RedisClient.prototype[command.toUpperCase()] = RedisClient.prototype[command];

    Multi.prototype[command] = function () {
        var args = to_array(arguments);
        args.unshift(command);
        this.queue.push(args);
        return this;
    };
    Multi.prototype[command.toUpperCase()] = Multi.prototype[command];
});

Multi.prototype.exec = function (callback) {
    var self = this;

    // drain queue, callback will catch "QUEUED" or error
    // Can't use a for loop here, as we need closure around the index.
    this.queue.forEach(function (args, index) {
        var command = args[0];
        if (typeof args[args.length - 1] === "function") {
            args = args.slice(1, -1);
        } else {
            args = args.slice(1);
        }
        if (args.length === 1 && Array.isArray(args[0])) {
            args = args[0];
        }
        this.client.send_command(command, args, function (err, reply) {
            if (err) {
                var cur = self.queue[index];
                if (typeof cur[cur.length - 1] === "function") {
                    cur[cur.length - 1](err);
                } else {
                    throw new Error(err);
                }
                self.queue.splice(index, 1);
            }
        });
    }, this);

    this.client.send_command("EXEC", function (err, replies) {
        if (err) {
            if (callback) {
                callback(new Error(err));
            } else {
                throw new Error(err);
            }
        }

        var i, il, j, jl, reply, args, obj, key, val;

        if (replies) {
            for (i = 1, il = self.queue.length; i < il; i += 1) {
                reply = replies[i - 1];
                args = self.queue[i];
                
                // Convert HGETALL reply to object
                if (reply && args[0].toLowerCase() === "hgetall") {
                    obj = {};
                    for (j = 0, jl = reply.length; j < jl; j += 2) {
                        key = reply[j].toString();
                        val = reply[j + 1];
                        obj[key] = val;
                    }
                    replies[i - 1] = reply = obj;
                }
                
                if (typeof args[args.length - 1] === "function") {
                    args[args.length - 1](null, reply);
                }
            }
        }

        if (callback) {
            callback(null, replies);
        }
    });
};

RedisClient.prototype.multi = function (args) {
    return new Multi(this, args);
};
RedisClient.prototype.MULTI = function (args) {
    return new Multi(this, args);
};

exports.createClient = function (port_arg, host_arg, options) {
    var port = port_arg || default_port,
        host = host_arg || default_host,
        red_client, net_client;

    net_client = net.createConnection(port, host);
        
    red_client = new RedisClient(net_client, options);

    red_client.port = port;
    red_client.host = host;

    return red_client;
};

exports.print = function (err, reply) {
    if (err) {
        console.log("Error: " + err);
    } else {
        console.log("Reply: " + reply);
    }
};
