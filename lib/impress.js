(function(impress) {

	require('./global');
	require('./impress.constants');
	require('./impress.log');
	global.async = global.async || require('async');

	impress.dir = process.cwd().replace(/\\/g, '/');

	impress.os = require('os');
	impress.http = require('http');
	impress.https = require('https');
	impress.url = require('url');
	impress.path = require('path');
	impress.fs = require('fs');
	impress.util = require('util');
	impress.net = require('net'),
	impress.dns = require('dns'),
	impress.cluster = require('cluster');
	impress.qs = require('querystring');
	impress.colors = require('colors');
	impress.readline = require('readline');
	impress.mkdirp = require('mkdirp');
	impress.zlib = require('zlib');
	impress.multiparty = require('multiparty');
	impress.iconv = require('iconv-lite');

	var configFile = impress.dir+'/config.js',
		configTimer = null;
	impress.config = require(configFile);

	// Loading plugins
	if (impress.config.plugins && impress.config.plugins.require) {
		for (var i in impress.config.plugins.require) {
			var pluginName = impress.config.plugins.require[i];
			require('./'+pluginName+'.js');
		}
	}

	impress.cache = {
		templates: [], // template body cache indexed by file name
		files:     [], // file override/inherited cache indexed by file name
		watchers:  [], // directory watchers indexed by directory name
		static:    [], // static files cache
		pages:     [], // rendered pages cache
	};

	impress.sse = {
		_counter: 1,         // counter to be used as connection identifier
		channels: {},        // sse channels indexed by channel name
		statistics: {
			incoming: 0,     // incoming connection count from server start
			active: 0,       // active connection count
			disconnected: 0, // disconnected connection count from server start
			errors: 0        // connection error count from server start
		}
	};

	// Open databases
	//
	impress.openDatabases = function(callback) {
		var databases = impress.config.databases,
			cbCount = Object.keys(databases).length, cbIndex = 0;
		for (var databaseName in databases) {
			var database = databases[databaseName],
				schema = database.url.substr(0, database.url.indexOf(':')),
				driver = db[schema];
			database.slowTime = database.slowTime || 1500;
			database.name = databaseName;
			driver.open([database], function() {
				cbIndex++;
				if (cbIndex>=cbCount && callback) callback();
			});
		}
	}

	// Preprocess configuration
	//
	function preprocessConfiguration() {

		// Prepare cluster
		impress.workerId = impress.cluster.isMaster ? 0 : process.env['WORKER_ID'];
		impress.nodeId = impress.config.cluster.name+'N'+impress.workerId;
		impress.serverName = process.env['WORKER_SERVER_NAME'];

		// Prepare routes
		var routes = impress.config.routes;
		for (var routeName in routes) {
			var route = routes[routeName];
			route.urlRx = new RegExp('^'+route.url.replace(/(\/|\?|\.)/g, "\\$1").replace(/\(\\\.\*\)/, "(.*)")+'$');
		}

		// Prepare virtual hosts
		var hosts = impress.config.hosts;
		for (var hostName in hosts) {
			var host = hosts[hostName];
			host.nameRx = new RegExp('^('+host.name.replace(/\*/g, ".*")+')$');
			if (host.static) host.staticRx = staticRegExp(host.static);
		}
	}

	var isFirstStart = true;

	// Start servers
	//
	impress.start = function() {
		if (global.cms && db.system) cms.init(db.system);
		var servers = impress.config.servers,
			workerId = 0;
		for (var serverName in servers) {
			var server = servers[serverName],
				single = impress.config.cluster.strategy == "single",
				specialization = impress.config.cluster.strategy == "specialization",
				cloned = impress.config.cluster.strategy == "multiple" || impress.config.cluster.strategy == "sticky",
				master = impress.cluster.isMaster;
			if (server.protocol == "https") var certificate = {
				key:  impress.fs.readFileSync(impress.dir+'/server.key'),
				cert: impress.fs.readFileSync(impress.dir+'/server.cer')
			};
			if (server.static) server.staticRx = staticRegExp(server.static);
			if (master) {
				console.log('  listen on '+server.address+':'+server.port);
				if (single) {
					if (server.protocol == "https")
						server.listener = impress.https.createServer(certificate, dispatcher);
					else server.listener = impress.http.createServer(dispatcher);
				} else if (cloned) {
					if (impress.config.cluster.strategy == "sticky")
						server.listener = impress.net.createServer(balancer);
					else server.listener = {
						close: function(callback) { callback(); },
						on: function() { },
						listen: function() { }
					};
					//else server.listener = impress.net.createServer();
					//server.listener = impress.net.createServer(balancer);
				} else if (specialization) {
					if (isFirstStart) impress.spawn(workerId, serverName);
					workerId++;
				}
			} else if (cloned || impress.serverName == serverName) {
				if (server.protocol == "https")
					server.listener = impress.https.createServer(certificate, dispatcher);
				else server.listener = impress.http.createServer(dispatcher);
			}
			if (server.listener) {
				server.listener.on('error', function(e) {
					if (e.code == 'EADDRINUSE') {
						console.log('Can not bind to host/port');
						process.exit(1);
					}
				});
				server.listener.serverName = serverName;
				if ((master && !specialization) || (!master && !cloned)) {
					if (!impress.config.nagle) {
						server.listener.on('connection', function(socket) {
							socket.setNoDelay();
						});
					}
					server.listener.listen(server.port, server.address);
				} else {
					if (impress.config.cluster.strategy == "sticky") server.listener.listen(null);
					else server.listener.listen(server.port, server.address);
				}
			}
		}
		isFirstStart = false;
	}

	// Convert array of static files masks e.g. ['/css/*', '/index.html'] into one RegExps
	//
	function staticRegExp(static) {
		if (static && static.length) {
			static = static.map(function(item) {
				item = escapeRegExp(item);
				return item.replace(/\\\*/g,".*");
			});
			return new RegExp('^(('+static.join(")|(")+'))$');
		} else return null;
	}

	// Unload configuration and shutdown server
	//
	impress.stop = function(callback) {
		var servers = impress.config.servers,
			cbCount = Object.keys(servers).length, cbIndex = 0;
		for (var serverName in servers) {
			var server = servers[serverName];
			if (server.listener) server.listener.close(function() {
				cbIndex++;
				if (cbIndex>=cbCount && callback) {
					delete require.cache[require.resolve(configFile)];
					delete impress.config;

					// Unwatch folders and clear cache
					for (var watcherPath in impress.cache.watchers) impress.cache.watchers[watcherPath].close();
					impress.cache.templates = [];
					impress.cache.files = [];
					impress.cache.watchers = [];
					impress.cache.pages = [];

					callback();
				}
			});
		}
	}

	// Reload configuration and restart server
	//
	impress.restart = function() {
		if (impress.config) impress.stop(function() {
			var nid = impress.nodeId+'=';
			try {
				impress.config = require(configFile);
				if (impress.cluster.isMaster) console.log('Reloading server configuration'.green);
				preprocessConfiguration();
			} catch(e) {
				console.log('Error requiring config file');
				process.exit(1);
			}
			impress.start();
		});
	}

	// Impress initialization
	//   cbInstance       - callback after any instance initialization
	//   cbMasterInstance - callback after master instance initialization
	//   cbWorkerInstance - callback after worker instance initialization
	//
	impress.init = function(cbMasterInstance, cbWorkerInstance, cbInstance) {
		if (impress.cluster.isMaster && impress.config.startup && impress.config.startup.check) {
			console.log('Startup check: '.green+impress.config.startup.check);
			impress.http.get(impress.config.startup.check, function(res) {
				if (res.statusCode == 404) startup(afterInit);
				else {
					console.log('Status: server is already started'.green);
					process.exit(1);
				}
			}).on('error', function(e) {
				startup(afterInit);
			});
		} else startup(afterInit);

		function afterInit() {
			if (cbInstance) cbInstance();
			/**/ if (impress.cluster.isMaster && cbMasterInstance) cbMasterInstance();
			else if (impress.cluster.isWorker && cbWorkerInstance) cbWorkerInstance();
		}

		function startup(callback) {
			if (impress.cluster.isMaster) console.log('Impress Application Server starting'.bold.green+', reading configuration'.green);
			impress.log.open();
			if (impress.config.databases) impress.openDatabases(callback);
			
			// Config initialization
			preprocessConfiguration();
			impress.fs.watch(configFile, function(event, fileName) {
				// Prevent multiple watch events generated on one file change
				if (configTimer) clearTimeout(configTimer);
				configTimer = setTimeout(function() {
					configTimer = null;
					impress.restart();
				}, 2000);
			});

			// Start workers
			if (impress.cluster.isMaster) {
				impress.workers = [];
				if (impress.config.cluster.strategy == "multiple" || impress.config.cluster.strategy == "sticky") {
					for (var workerId = 0; workerId < impress.config.cluster.workers; workerId++) {
						if (isFirstStart) impress.spawn(workerId);
					}
				}
				process.on('SIGINT', impress.shutdown);
				process.on('SIGTERM', impress.shutdown);
			} else {
				process.on('message', function(message, socket) {
					if (message.name == 'impress:socket') {
						var servers = impress.config.servers;
						for (var serverName in servers) {
							var server = servers[serverName];
							if (server.address == message.address && server.port == message.port) {
								socket.server = server.listener;
								server.listener.emit('connection', socket);
							}
						}
					} else if (message.name == 'impress:sse') {
						// Retranslated SSE from master to worker
						//console.dir({workerRetranslated:{message:message, id:impress.workerId}});

						if (message.user) impress.sse.userEvent(message.user, message.eventName, message.data, true);
						else if (message.channel) impress.sse.channelEvent(message.channel, message.eventName, message.data, true);
						else if (message.global) impress.sse.globalEvent(message.eventName, message.data, true);
					}
				});
			}

			impress.start();

			// Set garbage collection interval
			var gcInterval = duration(impress.config.cluster.gc);
			if (typeof(global.gc) === 'function' && gcInterval > 0) {
				setInterval(function() {
					global.gc();
				}, gcInterval*1000);
			}
		}
	}

	// Final shutdown
	//
	impress.shutdown = function() {
		// Stop workers
		if (impress.cluster.isMaster) {
			for (var workerId in impress.workers) {
				impress.workers[workerId].kill();
			}
		}

		impress.stop();
		impress.log.close();

		setTimeout(function() {
			console.log('Impress shutting down'.bold.green);
			process.exit(0);
		}, 500);

	}

	// Spawn new worker
	// bind worker to serverName from config if serverName defined
	//
	impress.spawn = function(workerId, serverName) {
		var worker, env = {};
		env["WORKER_ID"] = workerId;
		if (typeof(serverName) !== "undefined") env["WORKER_SERVER_NAME"] = serverName;
		var worker = impress.cluster.fork(env);
		impress.workers[workerId] = worker;
		worker.on('exit', function(worker, code, signal) {
			if (!worker.suicide) impress.spawn(workerId);
		});
	
		// Initialize IPC for interprocess SSE routing, from worker to master
		worker.on('message', function(msg) {
			// propagate to all workers except of original sender
			for (var id in impress.workers) {
				if (id != workerId) {
					//console.dir({masterPropagate:{workerId:id,msg:msg}});
					impress.workers[id].send(msg);
				}
			}
		});
	}

	// Dispatch requests
	//
	function dispatcher(req, res) {
		// Prepare impress structures
		req.impress = {};
		res.impress = {};
		req.impress.startTime = new Date().getTime();
		req.impress.slowTime = 1500;
		req.impress.access = {
			guests: true,
			logged: true,
			http:   true,
			https:  true,
			groups: []
		};
		var server = (req.connection.server)
				? impress.config.servers[req.connection.server.serverName]
				: impress.config.servers[req.connection.pair.server.serverName],
			staticRx = server.staticRx,
			url = impress.url.parse(req.url);
		req.query = impress.qs.parse(url.query);
		req.impress.schema = (!req.connection.server) ? "https" : "http";
		req.impress.url = url.pathname,
		req.impress.path = req.impress.url,
		req.impress.hostDir = impress.dir+server.process.replace("[host]",req.headers.host);
		req.impress.ext = fileExt(req.impress.url) || 'html';
		if (!req.headers.host) req.headers.host = 'no-host-name-in-http-headers';

		if (server.slowTime) req.impress.slowTime = server.slowTime;
		impress.log.access(
			req.connection.remoteAddress+'\t'+
			req.method+'\t'+
			req.impress.schema+'://'+req.headers.host+req.impress.url+'\t'+
			req.headers['user-agent']
		);
		
		var isDispatched = false,
			isRouted = false;

		for (var iHost = 0; iHost < server.hosts.length; ++iHost) { // --- FOREACH HOSTS ---
			var hostName = server.hosts[iHost],
				host = impress.config.hosts[hostName],
				portOffset = req.headers.host.indexOf(':');
			req.impress.host = (portOffset >= 0) ? req.headers.host.substr(0, portOffset) : req.headers.host;
			if (host.nameRx.test(req.impress.host)) {
				if (host.static) staticRx = host.staticRx;
				if (host.slowTime) req.impress.slowTime = host.slowTime;
				if (staticRx) {
					if (host.process) req.impress.hostDir = impress.dir+host.process;
					if (staticRx.test(req.impress.url)) {
						static(req, res);
						return;
					} else {
						if (host.routes) {
							for (var iRoute = 0; iRoute < host.routes.length; ++iRoute) { // --- FOREACH ROUTE ---
								var routeName = host.routes[iRoute],
									route = impress.config.routes[routeName],
									match = req.url.match(route.urlRx);
								if (match) {
									if (route.slowTime) req.impress.slowTime = route.slowTime;
									var urlRoute = req.url;
									if (route.rewrite && match.length > 1) {
										urlRoute = route.rewrite.replace(/\[([0-9]+)\]/g, function(s, key) {
											return match[key] || s;
										});
									} else urlRoute = route.rewrite;
									proxy(req, res, route.host, route.port, urlRoute);
									return;
								}
							} // --- END FOREACH ROUTE ---
							if (!isRouted) impress.error(req, res, 404);
						}
						if (host.process) {
							// Read POST parameters
							if (req.method === "POST") {
								var contentType = req.headers['content-type'];
								if (contentType && contentType.startsWith('multipart')) {
									var form = new impress.multiparty.Form();
									form.parse(req, function(err, fields, files) {
										if (err) {
											impress.error(req, res, 400);
											return;
										} else {
											req.impress.files = files;
											restoreSession(req, res);
										}
									});
								} else {
									req.impress.data = "";
									req.on("data", function(chunk) {
										req.impress.data += chunk;
									});
									req.on("end", function() {
										req.post = impress.qs.parse(req.impress.data);
										restoreSession(req, res);
									});
								}
							} else restoreSession(req, res);
							return;
						}
					}
				}
			}
		} // --- END FOREACH HOSTS ---
		if (!isDispatched) impress.error(req, res, 404);
	}

	// Start session
	//
	impress.startSession = function(req, res) {
		if (!req.impress.session) {
			var sid = impress.generateSID();
			req.impress.session = sid;
			req.impress.user = {};
			impress.setCookie(req, res, impress.config.session.cookie, sid);
			if (impress.config.cluster.cookie) impress.setCookie(req, res, impress.config.cluster.cookie, impress.nodeId);
			impress.sessions[sid] = {
				sessionModified: true,
				sessionCreated: true
			};
		}
	}

	// Destroy session
	//
	impress.destroySession = function(req, res) {
		if (req.impress.session) {
			impress.deleteCookie(req, res, impress.config.session.cookie);
			impress.deleteCookie(req, res, impress.config.cluster.cookie);
			// clear other structures
			var userId = impress.sessions[req.impress.session].userId;
			if (userId && impress.users[userId]) delete impress.users[userId].sessions[req.impress.session];
			delete impress.sessions[req.impress.session];
			req.impress.session = null;
			req.impress.user = null;
			// !!! delete session from MongoDB persistent session storage
			if (impress.security) impress.security.deletePersistentSession(req.impress.session);
		};
	}

	// Set cookie name=value, host is optional
	//
	impress.setCookie = function(req, res, name, value, host) {
		var expires = new Date(2100,01,01).toUTCString(),
		host = host || req.headers.host;
		res.impress.cookies.push(name+"="+value+"; expires="+expires+"; Path=/; Domain="+host+"; HttpOnly");
	}

	// Delete cookie by name
	//
	impress.deleteCookie = function(req, res, name) {
		res.impress.cookies.push(name+"=deleted; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Path=/; Domain=."+req.headers.host);
	}

	// Send cookies prepared in res.impress.cookies
	//
	impress.sendCookie = function(req, res) {
		if (res.impress.cookies && res.impress.cookies.length && !res.headersSent)
			res.setHeader("Set-Cookie", res.impress.cookies);
	}

	// Generate SID
	//
	impress.generateSID = function() {
		var key = generateKey(
				impress.config.session.length-2,
				impress.config.session.characters
			);
		return key+impress.crcSID(key);
	}

	impress.crcSID = function(key) {
		var c1 = key.indexOf(key.charAt(key.length-1)),
			c2 = key.indexOf(key.charAt(key.length-2)),
			s1 = impress.config.session.characters.charAt(c1),
			s2 = impress.config.session.characters.charAt(c2);
		return s1+s2;
	}

	impress.validateSID = function(sid) {
		if (!sid) return false;
		var crc = sid.substr(sid.length-2);
			key = sid.substr(0, sid.length-2);
		return impress.crcSID(key) == crc;
	}

	// Balancer for sticky mode
	//
	function balancer(socket) {
		var ip;
		if (impress.config.cluster.strategy == "sticky") ip = ip2int(socket.remoteAddress);
		else if (impress.config.cluster.strategy == "multiple") ip = ~~(Math.random()*impress.workers.length);

		var worker = impress.workers[Math.abs(ip) % impress.workers.length],
			server = impress.config.servers[socket.server.serverName];
		worker.send({
			name: 'impress:socket',
			address: server.address,
			port: server.port
		}, socket);
	}

	// Route request to external HTTP server
	//
	function proxy(req, res, host, port, url) {
		impress.http.request({
			host: host,
			port: port,
			path: url,
			method: req.method
		},
		function(response) {
			res.writeHead(response.statusCode, response.headers);
			response.on('data', function(chunk) { res.write(chunk); });
			response.on('end', function() { res.end(); });
		}).on("error", function(err) {
			impress.error(req, res, 502); // err.message
		})
		.end();
	}

	// Restore session if available
	//
	function restoreSession(req, res) {
		// Parse cookies
		req.impress.cookies = [];
		res.impress.cookies = [];
		if (req.headers.cookie) req.headers.cookie.split(';').forEach(function(cookie) {
			var parts = cookie.split('=');
			req.impress.cookies[parts[0].trim()] = (parts[1] || '').trim();
		});
		// Detect session, restore session or delete cookie
		var sid = req.impress.cookies[impress.config.session.cookie];
		if (sid) {
			if (impress.validateSID(sid)) {
				if (impress.sessions[sid]) {
					req.impress.session = sid;
					req.impress.logged = !!impress.sessions[sid].userId;
					if (impress.security) req.impress.user = impress.security.getSessionUser(sid);
					processing(req, res);
				} else {
					if (impress.config.session.persist && impress.security) {
						impress.security.restorePersistentSession(sid, function(err, session) {
							if (session) {
								var userId = session.userId;
								req.impress.session = sid;
								req.impress.user = impress.security.getSessionUser(sid);
								req.impress.logged = !!userId;
							} else impress.deleteCookie(req, res, impress.config.session.cookie);
							processing(req, res);
						});
					} else processing(req, res);
				}
			} else {
				impress.deleteCookie(req, res, impress.config.session.cookie);
				processing(req, res);
			}
		} else processing(req, res);
	}

	// Save session
	//
	function saveSession(req, res, callback) {
		if (req.impress.session && impress.config.session.persist && impress.security) {
			var session = impress.sessions[req.impress.session];
			if (session && (session.sessionCreated || session.sessionModified))
				impress.security.savePersistentSession(req.impress.session, callback);
			else callback();
		} else callback();
	}

	// Process request by impress.js
	//
	function processing(req, res) {	
		req.impress.handlers = ['access', 'request', req.method.toLowerCase()];
		res.context = {};

		// Set Content-Type if detected and not SSE
		if (req.impress.ext == 'sse') res.sse = { channel: null };
		else {
			var contentType = impress.mimeTypes[req.impress.ext];
			if (contentType) res.setHeader('Content-Type', contentType);
		}

		// Execute handlers
		async.eachSeries(req.impress.handlers, function(handler, callback) {
			req.impress.path = req.impress.url;
			filehandler(req, res, handler, callback);
		}, function(err) {
			req.impress.path = req.impress.url;
			if (req.impress.access.allowed) {
				if (req.impress.ext == 'html' || req.impress.ext == 'ajax') {
					var filePath = req.impress.hostDir+req.impress.path,
						buffer = impress.cache.pages[filePath];
					if (buffer) res.end(buffer);
					else if (global.cms) cms.processing(req, res, processingPage);
					else processingPage(req, res);
				} else if (req.impress.ext == 'sse') {
					sse(req, res);
				} else if (req.impress.ext == 'json') {
					var output = JSON.stringify(res.context.data);
					if (!output) impress.error(req, res, 404);
					else impress.end(req, res, output);
				} else impress.error(req, res, 404);
			} else impress.error(req, res, 403);
		});
	}

	// Process dynamic and static pages, cms pages !!!!!!!!!!!!!!
	// 
	function processingPage(req, res) {
		var data = res.context.data || {};
		impress.template(req, res, data, 'html', '', function(tpl) {
			if (res.impress.cachable) {
				var filePath = req.impress.hostDir+req.impress.path;
				impress.cache.pages[filePath] = tpl;
			}
			impress.end(req, res, tpl);
		});
	}

	// Initialize SSE connection
	//
	function sse(req, res) {
		var userId = (req.impress.session && req.impress.logged)
			? impress.sessions[req.impress.session].userId.toHexString() : null;
		if (userId && res.sse && res.sse.channel) {
			//console.log('SSE: incoming connection');
			res.writeHead(200, {
				'Content-Type': impress.mimeTypes['sse'],
				'Cache-Control': 'no-cache',
				'Access-Control-Allow-Credentials': true,
				'Access-Control-Allow-Origin': '*'
			});
			req.socket.setTimeout(0);
			res.write(':connected');
			if (!impress.users[userId].sse) impress.users[userId].sse = {};
			req.impress._id = impress.sse._counter;
			res.impress._id = impress.sse._counter;
			impress.users[userId].sse[impress.sse._counter] = { request: req, response: res };
			impress.sse._counter++;

			if (!impress.sse.channels[res.sse.channel]) impress.sse.channels[res.sse.channel] = [];
			var channelUsers = impress.sse.channels[res.sse.channel];
			if (!inArray(channelUsers, userId)) channelUsers.push(userId);
			
			impress.sse.statistics.incoming++;
			impress.sse.statistics.active++;

			req.on('close', function() {
				//console.log('SSE: socket close');
				impress.sse.statistics.active--;
				impress.sse.statistics.disconnected++;
			});

			req.on('error', function(err) {
				//console.log('SSE: socket error');
				impress.sse.statistics.active--;
				impress.sse.statistics.disconnected++;
				impress.sse.statistics.errors++;
			});

			req.on('timeout',function() {
				//console.log('SSE: timeout');
				impress.sse.statistics.active--;
				impress.sse.statistics.disconnected++;
				impress.sse.statistics.errors++;
			});

			req.socket.on('timeout',function() {
				//console.log('SSE: socket timeout');
				impress.sse.statistics.active--;
				impress.sse.statistics.disconnected++;
				impress.sse.statistics.errors++;
			});
		} else impress.error(req, res, 403);
	}
	
	// Send SSE event to all connections of given user
	//
	impress.sse.userEvent = function(userId, eventName, data, isRetranslation) {
		var packet = 'event: '+eventName+'\ndata: '+JSON.stringify(data)+'\n\n',
			buf = new Buffer(packet, 'utf8'),
			isRetranslation = isRetranslation || false;
		//console.dir({userEvent:{channel:channel, eventName:eventName}});

		if (impress.cluster.isWorker && !isRetranslation) process.send({
			name: 'impress:sse',
			user: userId,
			event: eventName,
			data: data
		});

		if (impress.users[userId] && impress.users[userId].sse) {
			for (var i in impress.users[userId].sse) impress.users[userId].sse[i].response.write(buf);
		}
	}

	// Send SSE event to all users in channel
	//
	impress.sse.channelEvent = function(channel, eventName, data, isRetranslation) {
		//console.dir({channelEvent:{channel:channel, eventName:eventName, isWorker: impress.cluster.isWorker}});
		var packet = 'event: '+eventName+'\ndata: '+JSON.stringify(data)+'\n\n',
			buf = new Buffer(packet, 'utf8'),
			isRetranslation = isRetranslation || false;

		//console.dir({isRetranslation:isRetranslation});

		if (impress.cluster.isWorker && !isRetranslation) process.send({
			name: 'impress:sse',
			channel: channel,
			event: eventName,
			data: data
		});

		if (impress.sse.channels[channel], isRetranslation) {
			var users = impress.sse.channels[channel];
			for (var j in users) {
				var userId = users[j];
				//console.dir({userId:userId});
				if (impress.users[userId] && impress.users[userId].sse) {
					for (var i in impress.users[userId].sse) {
						//console.dir({i:i});
						impress.users[userId].sse[i].response.write(buf);
					}
				}
			}
		}
	}

	// Send SSE event to all users in system
	//
	impress.sse.globalEvent = function(eventName, data) {
		var packet = 'event: '+eventName+'\ndata: '+JSON.stringify(data)+'\n\n',
			buf = new Buffer(packet, 'utf8'),
			isRetranslation = isRetranslation || false;
		//console.dir({globalEvent:{eventName:eventName}});

		if (impress.cluster.isWorker && !isRetranslation) process.send({
			name: 'impress:sse',
			global: true,
			event: eventName,
			data: data
		});

		for (var channelName in impress.sse.channels) {
			//console.dir({channelName:channelName});
			var users = impress.sse.channels[channelName];
			for (var j in users) {
				var userId = users[j];
				//console.dir({userId:userId});
				if (impress.users[userId] && impress.users[userId].sse) {
					for (var i in impress.users[userId].sse) {
						//console.dir({i:i});
						impress.users[userId].sse[i].response.write(buf);
					}
				}
			}
		}
	}

	// End request
	//
	impress.end = function(req, res, output) {
		saveSession(req, res, function() {
			impress.sendCookie(req, res);
			req.impress.endTime = new Date().getTime();
			res.end(output);
			if (req.impress.endTime-req.impress.startTime >= req.impress.slowTime) impress.log.slow(
				(req.impress.endTime-req.impress.startTime)+'ms\t'+
				req.connection.remoteAddress+'\t'+
				req.method+'\t'+
				req.impress.schema+'://'+req.headers.host+req.impress.url+'\t'+
				req.headers['user-agent']
			);
		});
	}

	// End request with HTTP error code
	//
	impress.error = function(req, res, code) {
		if (code==304) {
			res.statusCode = code;
			impress.end(req, res);
		} else {
			res.setHeader('Content-Type', impress.mimeTypes['html']);
			res.statusCode = code;
			var message = impress.httpErrorCodes[code] || 'Unknown error';
			impress.include(req, res, {title: "Error "+code, message: message}, __dirname+'/error.template', '', function(tpl) {
				impress.end(req, res, tpl);
			});
		}
	}

	// Find existent file to execute
	//
	function filehandler(req, res, file, callback) {
		var fileName = file+'.js',
			filePath = req.impress.hostDir+lastSlash(req.impress.path)+fileName,
			fileExecute = impress.cache.files[filePath];
		if (fileExecute) {
			if (fileExecute != impress.fileNotFound) execute(req, res, fileExecute, callback);
			else impress.error(req, res, 404);
		} else impress.fs.exists(filePath, function(exists) {
			if (exists) {
				execute(req, res, filePath, callback);
				var fileOriginal = req.impress.hostDir+lastSlash(req.impress.url)+fileName;
				impress.cache.files[fileOriginal] = filePath;
				watchCache(fileOriginal);
			} else {
				// Try to process request on parent directory
				if ((req.impress.path != '/') && (req.impress.path != '.')) {
					req.impress.path = impress.path.dirname(req.impress.path);
					filehandler(req, res, file, callback);
					watchCache(req.impress.hostDir+req.impress.path+(req.impress.path.endsWith("/") ? "" : "/"));
				} else {
					// If last file in array
					// if (file == req.method.toLowerCase()) res.write('No handler found');
					// Lose hope to execute request and drop connection
					impress.error(req, res, 404);
					//callback();
					var fileOriginal = req.impress.hostDir+lastSlash(req.impress.url)+fileName;
					impress.cache.files[fileOriginal] = impress.fileNotFound;
					watchCache(fileOriginal);
				}
			}
		});
	}

	// Execute existent file from cache or disk
	//
	function execute(req, res, filePath, callback) {
		var cache = require.cache[require.resolve(filePath)];
		if (cache) cache = cache.exports;
		else {
			cache = require(filePath);
			watchCache(filePath);
		}
		req.impress.access.allowed = (
			(
				(!req.impress.logged && req.impress.access.guests) ||
				(!!req.impress.logged && req.impress.access.logged)
			) && (
				(!!req.connection.server && req.impress.access.http) ||
				(!req.connection.server && req.impress.access.https)
			)
		);
		if (req.impress.logged) {
			req.impress.access.allowed = req.impress.access.allowed && (
				(!req.impress.access.groups) ||
				(req.impress.access.groups &&
					(
						req.impress.access.groups.length==0 ||
						inArray(req.impress.access.groups, req.impress.user.group)
					)
				)
			);
		}
		if (req.impress.access.allowed) {
			if (typeof(cache) == "function") cache(req, res, callback);
			else {
				req.impress.access = cache;
				callback();
			}
		} else callback();
	}

	// Render template from file or cache
	//
	impress.template = function(req, res, data, file, cursor, callback) { // callback(tpl)
		var userGroup = '';
		if (req.impress.logged) userGroup = '.'+(req.impress.user.group || 'everyone');
		var fileName = file+userGroup+'.template',
			filePath = req.impress.hostDir+lastSlash(req.impress.path)+fileName;
			fileInclude = impress.cache.files[filePath];
		if (fileInclude) {
			if (fileInclude != impress.fileNotFound) impress.include(req, res, data, fileInclude, cursor, callback);
			else callback(impress.templateNotFound+file);
		} else impress.fs.exists(filePath, function(exists) {
			if (exists) {
				impress.include(req, res, data, filePath, cursor, callback);
				var fileOriginal = req.impress.hostDir+lastSlash(req.impress.url)+fileName;
				impress.cache.files[fileOriginal] = filePath;
				watchCache(fileOriginal);
			} else {
				// Try to find template without group name
				fileName = file+'.template',
				filePath = req.impress.hostDir+lastSlash(req.impress.path)+fileName;
				fileInclude = impress.cache.files[filePath];
				if (fileInclude) {
					if (fileInclude != impress.fileNotFound) impress.include(req, res, data, fileInclude, cursor, callback);
					else callback(impress.templateNotFound+file);
				} else impress.fs.exists(filePath, function(exists) {
					if (exists) {
						impress.include(req, res, data, filePath, cursor, callback);
						var fileOriginal = req.impress.hostDir+lastSlash(req.impress.url)+fileName;
						impress.cache.files[fileOriginal] = filePath;
						watchCache(fileOriginal);
					} else {
						// Try to find template in parent directory
						if ((req.impress.path != '/') && (req.impress.path != '.')) {
							req.impress.path = impress.path.dirname(req.impress.path);
							impress.template(req, res, data, file, cursor, callback);
							watchCache(req.impress.hostDir+req.impress.path+(req.impress.path.endsWith("/") ? "" : "/"));
						} else {
							// Lose hope to fine template and save cache
							var fileOriginal = req.impress.hostDir+lastSlash(req.impress.url)+fileName;
							impress.cache.files[fileOriginal] = impress.fileNotFound;
							watchCache(fileOriginal);
							callback(impress.templateNotFound+file);
						}
					}
				});
			}
		});
	}

	// Include template
	//
	impress.include = function(req, res, data, filePath, cursor, callback) { // callback(tpl)
		var cache = impress.cache.templates[filePath];
		if (cache) {
			if (cache != impress.fileIsEmpty) impress.render(req, res, data, cache, cursor, callback);
			else callback(impress.fileIsEmpty);
		} else {
			impress.fs.readFile(filePath, 'utf8', function(err, tpl) {
				if (err) callback(impress.templateNotFound+filePath);
				else {
					if (!tpl) tpl = impress.fileIsEmpty;
					else tpl = tpl.replace(/^[\uBBBF\uFEFF]/, '');
					impress.cache.templates[filePath] = tpl;
					impress.render(req, res, data, tpl, cursor, callback);
				}
			});
			watchCache(filePath);
		}
	}

	// Render template from variable
	//
	impress.render = function(req, res, data, tpl, cursor, callback) { // callback(tpl)
		// parse template into structure
		if (tpl != impress.fileIsEmpty) {
			var structure = [],
				pos, tplBefore, tplInclude, dataInclude, dataItem, tplBody, arrayIndex;
			while (tpl.length>0) {
				// get tpl before includes
				pos = tpl.indexOf("@[");
				if (pos >= 0) {
					structure.push({ type:'plain', tpl:tpl.substr(0, pos) });
					tpl = tpl.substring(pos+2);
					// get include name
					pos = tpl.indexOf("]@");
					tplInclude = tpl.substr(0, pos);
					tpl = tpl.substring(pos+2);
					dataInclude = impress.value(data,(cursor ? cursor+'.' : '')+tplInclude);
					// find inline templates
					pos = tpl.indexOf("@[/"+tplInclude+"]@");
					arrayIndex = 0;
					if (pos >= 0) {
						tplBody = tpl.substr(0, pos);
						if (Array.isArray(dataInclude)) for (dataItem in dataInclude) structure.push({
							type:'inline', name:tplInclude+'.'+arrayIndex++, tpl:tplBody
						}); else structure.push({ type:'inline', name:tplInclude, tpl:tplBody });
						tpl = tpl.substring(pos+5+tplInclude.length);
					} else {
						// handle included templates
						if (Array.isArray(dataInclude)) for (dataItem in dataInclude) structure.push({
							type:'include', name:tplInclude+'.'+arrayIndex++
						}); else structure.push({ type:'include', name:tplInclude });
					}
				} else {
					structure.push({ type:'plain', tpl:tpl });
					tpl = '';
				}
			}
			// generate result from structure
			var result = '';
			async.eachSeries(structure, function(item, callback) {
				if (item.type == 'plain') {
					result += impress.subst(item.tpl, data, cursor);
					callback();
				} else if (item.type == 'inline') {
					var cursorNew = (cursor == "") ? item.name : cursor+"."+item.name;
					impress.render(req, res, data, item.tpl, cursorNew, function(tpl) {
						result += tpl;
						callback();
					});
				} else if (item.type == 'include') {
					var cursorNew = (cursor == "") ? item.name : cursor+"."+item.name;
					req.impress.path = req.impress.url;
					impress.template(req, res, data, item.name, cursorNew, function(tpl) {
						if (tpl == impress.fileIsEmpty) callback();
						else {
							result += tpl || impress.templateNotFound+item.name;
							callback();
						}
					});
				}
			}, function(err) {
				callback(result);
			});
		} else callback(impress.fileIsEmpty);
	}

	// Substitute variables with values
	//   tpl  - template body
	//   data - global data structure to visualize
	//   cur  - current position in data structure
	//   returns result body
	//
	impress.subst = function(tpl, data, cursor) {
		tpl = tpl.replace(/@([\.0-9a-zA-Z]+)@/g, function(s, key) {
			var name, pos = key.indexOf(".");
			if (pos == 0) name = cursor+key; else name = key;
			return impress.value(data, name);
		});
		return tpl;
	}

	// Return value from data structure
	//
	impress.value = function(data, name) {
		var name = name.split("."),
			obj = data;
		for (var i = 0; i < name.length; ++i) obj = obj[name[i]] || obj;
		return obj;
	}

	// Send static file
	//
	function static(req, res) {
		var filePath = req.impress.hostDir+req.impress.path,
			httpCode = impress.customHttpCodes[req.impress.ext] || 200,
			buffer = impress.cache.static[filePath];
		if (buffer) {
			if (buffer != impress.fileNotFound) {
				var sinceTime = req.headers['if-modified-since'];
				if (sinceTime && isTimeEqual(sinceTime, buffer.stats.mtime)) {
					impress.error(req, res, 304);
					return;
				}
				res.writeHead(httpCode, baseHeader(req.impress.ext, buffer.stats, buffer.compressed));
				res.end(buffer.data);
			} else impress.error(req, res, 404);
		} else impress.fs.stat(filePath, function(err, stats) {
			if (err) {
				impress.error(req, res, 404);
				impress.cache.static[filePath] = impress.fileNotFound;
				watchCache(filePath);
			} else {
				var sinceTime = req.headers['if-modified-since'];
				if (sinceTime && isTimeEqual(sinceTime, stats.mtime)) {
					impress.error(req, res, 304);
					return;
				}
				compress(filePath, stats, httpCode, req, res);
			}
		});
	}

	// Refresh static in memory cache with compression and minification
	//    required parameters: filePath, stats
	//    optional parameters: httpCode, req, res
	//
	function compress(filePath, stats, httpCode, req, res) {
		impress.fs.readFile(filePath, function(error, data) {
			if (error) {
				if (res) res.end();
			} else {
				var ext = (req) ? req.impress.ext : fileExt(filePath);
				if (ext == 'js' && impress.config.uglify && impress.config.uglify.minify) {
					data = impress.minify(data);
					stats.size = data.length;
				}
				if (!inArray(impress.compressedExt, ext) && stats.size>impress.compressAbove) {
					impress.zlib.gzip(data, function(err, data) {
						stats.size = data.length;
						if (res) {
							res.writeHead(httpCode, baseHeader(ext, stats, true));
							res.end(data);
						}
						impress.cache.static[filePath] = { data:data, stats:stats, compressed: true };
					});
				} else {
					if (res) {
						res.writeHead(httpCode, baseHeader(ext, stats));
						res.end(data);
					}
					impress.cache.static[filePath] = { data:data, stats:stats, compressed: false };
				}
				watchCache(filePath);
			}
		});
	}

	function isTimeEqual(since, mtime) {
		return (new Date(mtime)).getTime() == (new Date(since)).getTime();
	}

	// Send HTTP headers
	//
	function baseHeader(ext, stats, compressed) {
		var compressed = typeof(compressed) !== 'undefined' ? compressed : false;
		var header = {
			'Transfer-Encoding': 'chunked',
			'Content-Type':      impress.mimeTypes[ext],
			'Cache-Control':     'public',
			//'Cache-Control':   'no-cache, no-store, max-age=0, must-revalidate',
			//'Pragma':          'no-cache'
		};
		if (!inArray(impress.compressedExt, ext) && compressed) header['Content-encoding'] = 'gzip';
		if (stats) {
			//var start = 0, end = stats.size-1;
			//header['Accept-Ranges' ] = 'bytes';
			//header['Content-Range' ] = 'bytes '+start+'-'+end+'/'+stats.size;
			header['Content-Length'] = stats.size;
			header['Last-Modified' ] = stats.mtime.toGMTString();
		}
		return header;
	}

	function fileExt(fileName) {
		return impress.path.extname(fileName).replace('.','');
	}

	// Redirect to specified location
	//
	impress.redirect = function(res, location) {
		res.setHeader("Location", location);
		res.statusCode = 302;
	}

	// Cache watchers
	//
	function watchCache(filePath) {
		var path = filePath;
		if (!filePath.endsWith("/")) path = impress.path.dirname(path)+"/";
		var watcher = impress.cache.watchers[path];
		if (typeof(watcher) == 'undefined') {
			impress.fs.exists(path, function(exists) {
				if (exists) {
					watcher = impress.fs.watch(path, function(event, fileName) {
						var filePath = (fileName) ? path+fileName : path,
							ext = fileExt(fileName),
							watcher = impress.cache.watchers[path];
						if (watcher.timer) clearTimeout(watcher.timer);
						watcher.timer = setTimeout(function() {
							watcher.timer = null;
							impress.fs.stat(filePath, function(err, stats) {
								if (err) return;
								if (stats.isFile()) {
									var cache = require.cache[require.resolve(filePath)];
									if (impress.cache.static[filePath]) {
										// Replace static files memory cache
										impress.fs.exists(filePath, function(exists) {
											if (exists) compress(filePath, stats);
										});
									} else if (ext == 'js' && cache) {
										// Replace changed js file in cache
										delete require.cache[require.resolve(filePath)];
										impress.fs.exists(filePath, function(exists) {
											if (exists) require(filePath);
										});
									} else if (ext == 'template') {
										// Replace changed template file in cache
										delete impress.cache.templates[filePath];
										impress.fs.exists(filePath, function(exists) {
											if (exists) impress.fs.readFile(filePath, 'utf8', function(err, tpl) {
												if (!err) {
													if (!tpl) tpl = impress.fileIsEmpty;
													else tpl = tpl.replace(/^[\uBBBF\uFEFF]/, '');
													impress.cache.templates[filePath] = tpl;
												}
											});
										});
									}
								} else {
									if (impress.cache.static[filePath]) {
										for (desired in impress.cache.static) {
											if (desired.startsWith(filePath)) delete impress.cache.static[desired];
										}
									} else {
										// Clear cache for all changed folders (created or deleted files)
										for (desired in impress.cache.files) {
											var used = impress.cache.files[desired];
											if (desired.startsWith(filePath)) delete impress.cache.files[desired];
											if (used != impress.fileNotFound) {
												ext = fileExt(used);
												if (used.startsWith(filePath)) {
													if (ext == 'js') delete require.cache[require.resolve(used)];
													else if (ext == 'template') delete impress.cache.templates[used];
													delete impress.cache.files[desired];
												}
											}
										}
									}
								}
							});
						}, 2000);
					});
					watcher.timer = null;
					impress.cache.watchers[path] = watcher;
				}
			});
		}
	}

} (global.impress = global.impress || {}));