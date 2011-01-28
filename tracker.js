var sys = require('sys'),http = require('http'),url = require('url'),qs = require('querystring'),client = require("./redis").createClient();
var conn,
  result,
  row,
  rows;
// CONFIG
var conf = new Object();
conf.mysql = new Object();
conf.tracker = new Object();
// Mysql config
conf.mysql.host = "localhost";
conf.mysql.user = "";
conf.mysql.password = "";
conf.mysql.database = "";
// Tracker config
conf.tracker.port = '/tmp/bt.sock'; // Port or path to socket
conf.tracker.user = 'nobody'; // User for socket
conf.tracker.group = 'nobody'; // Group for socket
conf.tracker.interval = 180; // Announce interval in seconds
conf.tracker.error_log = '/root/log.txt'; // Error log path
conf.tracker.redirect_url = 'http://yoursite.com'; // Redirect on wrong request
//
var conn = require('./mysql-libmysqlclient').createConnectionSync();
conn.initSync();
// Need to fix reconnect
conn.setOptionSync(conn.MYSQL_OPT_RECONNECT, 1);
conn.realConnectSync(conf.mysql.host, conf.mysql.user, conf.mysql.password, conf.mysql.database);
if (!conn.connectedSync()) {
  sys.puts("Connection error " + conn.connectionErrno + ": " + conn.connectionError);
  process.exit(1);
}
client.on("error", function (err) {
    console.log("Redis connection error to " + client.host + ":" + client.port + " - " + err);
});

var server = http.createServer(function (request, response) {
	var tokens = url.parse(request.url);
	var params = parse(tokens.query);
	//var params = qs.parse(tokens.query);
	//console.log("URL:", sys.inspect(tokens));
    //console.log("PARAMS:", sys.inspect(params));
    //console.log("HEADERS:", sys.inspect(request.headers));

	//sys.puts(request.headers.realip);

	var parts = tokens.pathname.split('/', 3);
	if(!parts[2] || parts[3]) handle404(response);
	//sys.puts(request.connection.remoteAddress)
	if(parts[2] == 'announce') announce(response, params, parts[1], request.headers.realip);
	else if(parts[2] == 'scrape') scrape(response, params, parts[1]);
	else handle404(response);
}).listen(conf.tracker.port, function() {
	// if its a socket then we need to change owner for frontend access
	if(isNaN(conf.tracker.port) && conf.tracker.user && conf.tracker.group)
		require('child_process').exec('chown '+conf.tracker.user+':'+conf.tracker.group+' '+conf.tracker.port);
});
// On error
process.on('uncaughtException', function(err) {
	var log = require('fs').createWriteStream(conf.tracker.error_log, {'flags': 'a'});
	log.write(err);
	console.log(err);
});

var announce = function(response, params, uid, ip) {
	console.log('announce');
	if(params.info_hash == undefined) {error(response, "Invalid request");return false;}
	if(params.port == undefined || params.peer_id == undefined) {error(response, "Invalid request");return false;}
	//
	 var info_hash = bufferHex(qs.unescapeBuffer(params.info_hash));
	var peer_id = bufferHex(qs.unescapeBuffer(params.peer_id));
	if(params.numwant) var numwant = parseInt(params.numwant, 10) || 50; else var numwant = 50;
	if(params.compact) var compact = parseInt(params.compact, 10) || 0; else var compact = 0;
	if(params.no_peer_id) var no_peer_id = parseInt(params.no_peer_id, 10) || 0; else var no_peer_id = 0;
	if(params.downloaded) var downloaded = parseInt(params.downloaded, 10); else var downloaded = 0;
	if(params.uploaded) var uploaded = parseInt(params.uploaded, 10); else var uploaded = 0;
	if(params.left) var left = parseInt(params.left, 10); else var left = 0;
	if(params.event) {
		if(params.event == "started") var event = params.event;
		else if(params.event == "completed") var event = params.event;
		else if(params.event == "stopped") var event = params.event;
		else var event = 0;
	} else var event = 0;
	var port = parseInt(params.port, 10);
	uid = parseInt(uid, 10);
	// checks
	if(info_hash.length != 40 || downloaded < 0 || (event == 'completed' && left) || left < -1 || peer_id.length < 20 || peer_id.length > 50  || port <= 0 || uploaded < 0) {
		console.log(info_hash)
		console.log(info_hash.length)
		error(response, "Invalid request"); return false;
	}
	var req = {
		response: response, numwant: numwant, compact: compact, no_peer_id: no_peer_id, downloaded: downloaded, uploaded: uploaded, left: left, event: event, port: port, uid: uid,
		info_hash: info_hash, peer_id: peer_id, ip:ip
	};
	loadTorrent(req, loadUser);
}
var loadTorrent = function(req, callback) {
	console.log('Load torrent'+"t:"+req.info_hash)
	client.hmget(["t:"+req.info_hash, "l", "s", "d"], function (err, replies) {
		console.log(err)
		if(replies.length && replies[0] != null) {
			console.log('Found in cache')
			torrent = { leechers: replies[0], seeders: replies[1], downloads: replies[2]}
    		callback(req, torrent, checkPier)
    	} else {
    		console.log('Check from db')
    		result = conn.querySync("SELECT completed FROM torrents WHERE info_hash = '"+conn.escapeSync(req.info_hash)+"'");
    		console.log('Checked from db')
			if(result == false) {
				console.log('Not found in db')
				error(req.response, "No such torrent");return false;
			}
			var rows = result.fetchAllSync();
			if(!rows[0]) {
				error(req.response, "No such torrent");return false;
			}
			torrent = { leechers: 0, seeders: 0, downloads: rows[0].completed };
			client.hmset(["t:"+req.info_hash, "l", 0, "s", 0, "d", rows[0].completed], client.print);
			console.log('Found in db')
			callback(req, torrent, checkPier)
    	}
    });
}
var loadUser = function(req, torrent, callback) {
	console.log('Load user')
	client.sismember('u', req.uid, function(err, replies) {
		if(replies) {
			console.log('Found in cache')
			callback(req, torrent, sendPeers)
		} else {
			console.log('Not found in cache')
    		result = conn.querySync("SELECT NULL FROM users WHERE userid = '"+req.uid+"'");
    		if(result == false) {
    			console.log('No user!!')
				error(req.response, "No such user");return false;
			}
    		var rows = result.fetchAllSync();
			if(!rows[0]) {
				console.log('No user')
				error(req.response, "No such user");return false;
			}
			client.sadd("u", req.uid);
			callback(req, torrent, sendPeers)
		}
	});
}
var checkPier = function(req, torrent, callback) {
	console.log('Check Peer')
	client.hget('p:'+req.peer_id, 's'+req.info_hash, function(err,replies) {
		if(replies && req.event != 'started') {
			client.hmset(['p:'+req.peer_id, 'u', req.uid, 'ip', req.ip, 'p', parseInt(req.port, 10), 'l'+req.info_hash, +new Date]);
		} else {
			client.hmset(['p:'+req.peer_id, 'u', req.uid, 'ip', req.ip, 'p', parseInt(req.port, 10), 'l'+req.info_hash, +new Date, 's'+req.info_hash, +new Date]);
			client.sadd('tp:'+req.info_hash, req.peer_id+':'+req.ip+':'+req.port);
		}
		callback(req, torrent)
	});
}
var sendPeers = function(req, torrent, callback) {
	console.log('Send Peers')
	client.smembers('tp:'+req.info_hash, function(err,replies) {
		if(replies.length && replies[0] != null) {
			if(req.compact) {
				console.log(err+'compact to '+req.ip+':'+req.port)
				var i = 0;
				var bufs = [];
				for (var k in replies) {
					console.log(i)
					if(i >= req.numwant) break;
    				var parts = replies[k].toString().split(':');
    				if(parts[0] == req.peer_id) {console.log('duplicate');continue;}
    				var octets = parts[1].split('.');

    				bufs[i] =  new Buffer(6);
    				bufs[i][0] = parseInt(octets[0], 10);
					bufs[i][1] = parseInt(octets[1], 10);
					bufs[i][2] = parseInt(octets[2], 10);
					bufs[i][3] = parseInt(octets[3], 10);
					var n = 4;
					for (var g = 8; g >= 0; g -= 8) {
                    	bufs[i][n++] = (parseInt(parts[2]) >> g, 10) & 0xff;
                	}
                	//bufs[i]=ipBuf;
    				console.log('sending '+parts[1]+':'+parts[2])
    				console.log(bufs[i]);
    				i++;
    			}
    			if(bufs.length) {
					req.response.writeHead(200, {"Content-Type": "text/plain"});
					//req.response.write('d8:intervali10e8:intervali10e5:peers'+buf.length+':')
					req.response.write('d8:intervali'+conf.tracker.interval+'e5:peers'+i * 6+':')
					for(var ki in bufs) {
						req.response.write(bufs[ki]);
					}
					req.response.write('e');
					req.response.end();
					return;
				} else {
					req.response.writeHead(200, {"Content-Type": "text/plain"});
    				req.response.write(encode({ interval: conf.tracker.interval, complete: i, incomplete: i, peers: []}));
    				req.response.end();
				}
			} else {
				console.log('not compact')
				var wantedPeers = [];
				for (var k in replies) {
					console.log(replies[k].toString());
    				if(wantedPeers.length >= req.numwant) break;
    				var parts = replies[k].toString().split(':');
    				console.log('parts '+sys.inspect(parts));
    				if(parts[0] == req.peer_id) continue;
    				if(req.no_peer_id)
    					wantedPeers.push({ ip: parts[1], port: parts[2] });
    				else
    					wantedPeers.push({ id: parts[0], ip: parts[1], port: parts[2] });
    				console.log('pushed ');
    			}
    			console.log('sending '+sys.inspect(wantedPeers));
    			req.response.writeHead(200, {"Content-Type": "text/plain"});
    			req.response.write(encode({ interval: conf.tracker.interval, complete: 1, incomplete: 22, peers: wantedPeers}));
    			req.response.end();
    		}
		}
	});
}
// Scrape functions - http://wiki.theory.org/BitTorrentSpecification#Tracker_.27scrape.27_Convention
var scrape = function(response, params, uid) {
	console.log('scrape');
	if(!params.info_hash || !params.info_hash.length) {error(response, "Invalid request");return false;}
	var info_hashes = Array();
	if (params.info_hash instanceof Array) {
		for (var k in params.info_hash) {
			info_hashes[k] = bufferHex(qs.unescapeBuffer(params.info_hash[k]));
			if(info_hashes[k].length != 40) {error(response, "Invalid request");return false;}
		}
	} else {
		info_hashes[0] = bufferHex(qs.unescapeBuffer(params.info_hash));
		if(info_hashes[0].length != 40) {error(response, "Invalid request");return false;}
	}
	uid = parseInt(uid, 10);
	console.log(info_hashes)
	// Needs competing
	if(!loadTorrent(info_hash)) {error(response, "No such torrent");return false;}
	if(!uid || !loadUser(uid)) {error(response, "No such user");return false;}
	info = torInfo(info_hash);
	if(!info) {error(response, "No such torrent1");return false;}
	var buf = new Buffer(info_hash);
	response.writeHead(200, {"Content-Type": "text/plain"});
	response.write('d5:filesd20:')
	response.write(buf);
	response.write('d8:completei'+info.seeds+'e10:downloadedi'+info.downloads+'e10:incompletei'+info.leechs+'eeee');
	response.end();
}
// Needs rewrite
var addCompleted = function(info_hash, peer_id, ip, port) {
	client.hincrby("t:"+info_hash, "d", 1);
	client.hincrby("t:"+info_hash, "l", -1);
	client.hset("p:"+peer_id, 't', 0);
	result = conn.querySync("UPDATE torrents SET completed=completed+1 WHERE info_hash = '"+info_hash+"'");
}
// Send failure message to client
var error = function(response, msg) {
	response.writeHead(200, {"Content-Type": "text/plain"});
    response.write("d14:failure reason"+msg.length+":"+msg+"e");
    response.end();
}
// Redirect to url
var handle404 = function(response) {
  response.writeHead(302, { 'Content-Type': 'text/plain', 'Location': conf.tracker.redirect_url });
  response.end();
};
// Copyright ???
var encode = function(input) {
  var tokens = [];
  if (typeof input == "number") {
    tokens.push('i');
    tokens.push(input.toString());
    tokens.push('e');
  } else if (typeof input == "string") {
    tokens.push(input.length.toString());
    tokens.push(':');
    tokens.push(input);
  } else if (input instanceof Array) {
    tokens.push('l');
    for (var i = 0; i < input.length; i++) {
      tokens.push(encode(input[i]));
    }
    tokens.push('e');
  } else if (typeof input == "object") {
    tokens.push('d');
    var keys = [];
    for (var k in input) {
      keys.push(k);
    }
    keys.sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = input[k];
      tokens.push(encode(k));
      tokens.push(encode(v));
    }
    tokens.push('e');
  } else {
    throw new Error("Unknown type for bencode.");
  }
  return tokens.join('');
};

function bufferHex (b) {
var s = '';
for (var i = 0; i < b.length; i++) {
 if(b[i] < 16) s+='0';
 s += b[i].toString(16);
 }
 return s;
}
// Copyright ???
parse = function (qs, sep, eq) {
  sep = sep || "&";
  eq = eq || "=";
  var obj = {};

  if (typeof qs !== 'string') {
    return obj;
  }

  qs.split(sep).forEach(function(kvp) {
    var x = kvp.split(eq);
    var k = x[0];
    var v = x.slice(1).join(eq);
	//var v = x[1];
    if (!(k in obj)) {
        obj[k] = v;
    } else if (!Array.isArray(obj[k])) {
        obj[k] = [obj[k], v];
    } else {
        obj[k].push(v);
    }
  });

  return obj;
};

process.on('exit', function () {
  conn.closeSync();
});