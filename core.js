/*global _, jsyaml, esprima, estraverse, File, XDomainRequest, JSZip, getFile: true, putFile: true, prepareFile: true, prepareString: true, prepareUrl: true, startTransaction: true, endTransaction: true, resolve: true, basename: true, deepEquals: true */

var core_version = 2;

var settings = {};

var inTransaction = false;
var transaction = null;
var transactionDate;
var filesToPut;
function startTransaction() {
	inTransaction = true;
	if(!transaction) {
		transaction = {};
		transactionDate = new Date();
		filesToPut = 0;
	}
}
window.startTransaction = startTransaction;
function endTransaction() {
	console.trace(inTransaction, filesToPut, transaction);
	if(!transaction) return;
	inTransaction = false;
	if(filesToPut) return;
	var _transaction = transaction;
	transaction = null;
	Object.keys(_transaction).forEach(function(path) {
		_transaction[path][1].finishingTransaction = true;
		if(/\/\.history\//.test(_transaction[path][0])) {
			window.getFileCache[_transaction[path][0]] = {codec: _transaction[path][1].codec, contents: _transaction[path][2], ts: Date.now()};
		}
		putFile.apply(window, _transaction[path]);
	});
}
window.endTransaction = endTransaction;

var sjcl = parent.sjcl;
var private_key = parent.private_key;
var private_hmac = parent.private_hmac;
var files_hmac = parent.files_hmac;
var password = parent.password;
var files_key = parent.files_key;
var account_info = parent.account_info;

sjcl.codec.raw = sjcl.codec.sjcl = {
	fromBits: function(bits) { return bits; },
	toBits: function(bits) { return bits; }
};

var utf8String_fromBits = sjcl.codec.utf8String.fromBits; // `sjcl.codec.utf8String.fromBits` will get overwritten in our getFile hackery.
sjcl.codec.json = sjcl.codec.prettyjson = {
	fromBits: function(bits) { return JSON.parse(utf8String_fromBits(bits)); },
	toBits: function(obj) { return sjcl.codec.utf8String.toBits(JSON.stringify(obj)); }
};
sjcl.codec.prettyjson.toBits = function(obj) { return sjcl.codec.utf8String.toBits(JSON.stringify(obj, null, '\t')); };

var currentFilename;
sjcl.codec.dir = sjcl.codec.yaml = {
	fromBits: function(bits) { return jsyaml.safeLoad(utf8String_fromBits(bits), {filename: currentFilename}); },
	toBits: function(obj) { return sjcl.codec.utf8String.toBits(jsyaml.safeDump(obj, {flowLevel: 1})); }
};
sjcl.codec.dir.fromBits = function(bits) {
	var utf8 = utf8String_fromBits(bits);
	if(utf8 !== '{}' && !/^.+: {.*}$/m.test(utf8)) {
		var obj = {};
		utf8.split('\n').forEach(function(line) {
			if(line) obj[line] = {};
		});
		return obj;
	}
	return jsyaml.safeLoad(utf8, {filename: currentFilename});
};

/** @namespace ArrayBuffer */
sjcl.codec.arrayBuffer = {
	/* jshint ignore:start *//* jscs: disable */
	/** Convert from a bitArray to an ArrayBuffer.
	 * Will default to 8byte padding if padding is undefined*/
	fromBits: function (arr, padding, padding_count) {
		var out, i, ol, tmp, smallest;
		padding_count = padding_count || 8
		
		ol = sjcl.bitArray.bitLength(arr)/8
		
		//check to make sure the bitLength is divisible by 8, if it isn't
		//we can't do anything since arraybuffers work with bytes, not bits
		if ( sjcl.bitArray.bitLength(arr)%8 !== 0 ) {
			throw new sjcl.exception.invalid("Invalid bit size, must be divisble by 8 to fit in an arraybuffer correctly")
		}
		
		if (padding && ol%padding_count !== 0){
			ol += padding_count - (ol%padding_count)
		}
		
		
		//padded temp for easy copying
		tmp = new DataView(new ArrayBuffer(arr.length*4))
		for (i=0; i<arr.length; i++) {
			tmp.setUint32(i*4, (arr[i]<<32)) //get rid of the higher bits
		}
		
		//now copy the final message if we are not going to 0 pad
		out = new DataView(new ArrayBuffer(ol))
		
		//save a step when the tmp and out bytelength are ===
		if (out.byteLength === tmp.byteLength){
			return tmp.buffer
		}
		
		smallest = tmp.byteLength < out.byteLength ? tmp.byteLength : out.byteLength
		for(i=0; i<smallest; i++){
			out.setUint8(i,tmp.getUint8(i))
		}
		
		
		return out.buffer
	},
	
	toBits: function (buffer) {
		var i, out=[], len, inView, tmp;
		inView = new DataView(buffer);
		len = inView.byteLength - inView.byteLength%4;
		
		for (var i = 0; i < len; i+=4) {
			out.push(inView.getUint32(i));
		}
		
		if (inView.byteLength%4 != 0) {
			tmp = new DataView(new ArrayBuffer(4));
			for (var i = 0, l = inView.byteLength%4; i < l; i++) {
				//we want the data to the right, because partial slices off the starting bits
				tmp.setUint8(i+4-l, inView.getUint8(len+i)); // big-endian,
			}
			out.push(
				sjcl.bitArray.partial( (inView.byteLength%4)*8, tmp.getUint32(0) )
			);
		}
		return out;
	},
	
	
	
	/** Prints a hex output of the buffer contents, akin to hexdump **/
	hexDumpBuffer: function(buffer){
		var stringBufferView = new DataView(buffer)
		var string = ''
		var pad = function (n, width) {
			n = n + '';
			return n.length >= width ? n : new Array(width - n.length + 1).join('0') + n;
		}
		
		for (var i = 0; i < stringBufferView.byteLength; i+=2) {
			if (i%16 == 0) string += ('\n'+(i).toString(16)+'\t')
			string += ( pad(stringBufferView.getUint16(i).toString(16),4) + ' ')
		}
		
		if ( typeof console === undefined ){
			console = console || {log:function(){}} //fix for IE
		}
		console.log(string.toUpperCase())
	}
	/* jshint ignore:end *//* jscs: enable */
};

window.getFileCache = {};
window.getRequestCache = {};
window.getFile = function(file, options, callback) {
	if(typeof options === 'function' || options === undefined) {
		callback = options;
		options = {};
	}
	if(callback === undefined) {
		callback = function() {};
	}
	
	if(handleFromCache()) return;
	function handleFromCache() {
		if(options.cache === false) return;
		var cache = window.getFileCache[file];
		if(cache) {// && Date.now() - cache.ts < 2000) {
			if((options.codec || 'utf8String') === (cache.codec || 'utf8String')) {
				callback(cache.contents);
			} else {
				currentFilename = file;
				callback(sjcl.codec[options.codec || 'utf8String'].fromBits(sjcl.codec[cache.codec || 'utf8String'].toBits(cache.contents)));
			}
			return true;
		}
	}
	
	var requestCache = window.getRequestCache[file];
	var req;
	if(requestCache) {
		req = requestCache;
		cb(); // For some reason browsers slightly delay firing readystatechange, so we check if it's already finished.
	} else {
		req = window.getRequestCache[file] = new XMLHttpRequest();
		console.log('GET', file);
	}
	req.addEventListener('readystatechange', cb);
	if(!requestCache) {
		var is_bootstrap_file = file.substr(0, 4) === '/key' || file.substr(0, 5) === '/hmac';
		req.open('GET', 'object/' + sjcl.codec.hex.fromBits((is_bootstrap_file ? private_hmac : files_hmac).mac(file)));
		req.send(null);
	}
	
	function cb() {
		if(req.readyState === 4) {
			window.getRequestCache[file] = null;
			if(handleFromCache()) return; // We might've PUT a newer version by now.
			if(req.status === 200) {
				var fromBits = sjcl.codec.utf8String.fromBits;
				if(options.codec) {
					sjcl.codec.utf8String.fromBits = sjcl.codec[options.codec].fromBits;
				}
				currentFilename = file;
				var decrypted;
				try {
					decrypted = sjcl.decrypt(files_key, req.responseText);
				} catch(e) {
					try {
						decrypted = sjcl.decrypt(private_key, req.responseText);
					} catch(e2) {
						decrypted = sjcl.decrypt(password, req.responseText);
					}
				}
				if(options.codec) {
					sjcl.codec.utf8String.fromBits = fromBits;
				}
				if(options.cache !== false) window.getFileCache[file] = {codec: options.codec, contents: decrypted, ts: Date.now()};
				callback(decrypted);
			} else {
				console.error('GET', file);
				callback(null, {status: req.status, statusText: req.statusText});
			}
		}
	}
};

var fileChangeListeners = [];
window.listenForFileChanges = function(fn) {
	fileChangeListeners.push(fn);
};
function notifyFileChange(path, reason) {
	fileChangeListeners.forEach(function(fn) {
		fn(path, reason);
	});
}

/*function guid() {
	var d = new Date().getTime();
	var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		var r = (d + Math.random()*16)%16 | 0;
		d = Math.floor(d/16);
		return (c=='x' ? r : (r&0x7|0x8)).toString(16);
	});
	return uuid;
}*/

function extend(target) {
	[].slice.call(arguments, 1).forEach(function(obj) {
		_.each(obj, function(value, key) {
			if(value != null && value.constructor === Object) {
				if(target.hasOwnProperty(key)) extend(target[key], value);
				else target[key] = value;
			}
			else if(value === undefined) delete target[key];
			else target[key] = value;
		});
	});
	return target;
}

/* jshint ignore:start *//* jscs: disable */
function deepEquals(a, b) {
	if (b == a) return true;
	
	var p;
	for (p in a) {
		if (typeof (b[p]) == 'undefined') { return false; }
	}
	
	for (p in a) {
		if (a[p]) {
			switch (typeof (a[p])) {
				case 'object':
					if (!deepEquals(a[p], b[p])) { return false; } break;
				default:
					if (a[p] !== b[p]) { return false; }
			}
		} else {
			if (b[p])
				return false;
		}
	}
	
	for (p in b) {
		if (typeof (a[p]) == 'undefined') { return false; }
	}
	
	return true;
}
/* jshint ignore:end *//* jscs: enable */

function debounce(fn, time, obj) {
	if(obj.timeout) clearTimeout(obj.timeout);
	obj.timeout = setTimeout(function() {
		delete obj.timeout;
		fn();
	}, time);
}
var debounceObj = {};
window.putFile = function(file, options, contents, attrs, callback, progress) {
	if(!options.finishingTransaction) window.startTransaction();
	debounce(window.endTransaction, 100, debounceObj);
	
	if(typeof contents === 'function' || contents === undefined) {
		progress = attrs;
		callback = contents;
		contents = options;
		options = {};
		attrs = {};
	} else if(typeof attrs === 'function' || attrs === undefined) {
		if(_.isObject(options)) { // If contents is an object, you also need to pass options = {codec: 'dir'}.
			progress = callback;
			callback = attrs;
			attrs = {};
		} else if(_.isObject(contents)) { // 2nd argument is not an object, assume that's the contents.
			progress = callback;
			callback = attrs;
			attrs = contents;
			contents = options;
			options = {};
		}
	}
	
	var upload_history = account_info.tier >= 5;
	var now = attrs.edited || window.transactionDate || new Date();
	
	var size, is_new_file;
	if(!options.finishingTransaction && file !== '/') {
		// Add file to parent directories
		var slashindex = file.lastIndexOf('/', file.length - 2) + 1;
		var dirname = file.substr(0, slashindex);
		var basename = file.substr(slashindex);
		filesToPut++;
		getFile(dirname, {codec: 'dir'}, function(dircontents) {
			if(!dircontents) dircontents = {};
			
			size = basename.substr(-1) === '/' ? undefined : sjcl.bitArray.bitLength(sjcl.codec[options.codec || 'utf8String'].toBits(contents)) / 8;
			is_new_file = !dircontents.hasOwnProperty(basename);
			var newattrs = extend({}, is_new_file ? {created: now} : dircontents[basename], {edited: upload_history ? now : undefined, size: upload_history ? size : undefined}, attrs);
			if(!dircontents.hasOwnProperty(basename) || !deepEquals(newattrs, dircontents[basename])) {
				var newdircontents = extend({}, dircontents); // Don't modify getFileCache entry.
				newdircontents[basename] = newattrs;
				putFile(dirname, {codec: 'dir'}, newdircontents, {edited: upload_history ? now : undefined});
			}
			filesToPut--;
			if(transaction && !inTransaction && !filesToPut) window.endTransaction();
		});
	}
	
	if(!/\/\.history\//.test(file)) {
		window.getFileCache[file] = {codec: options.codec, contents: contents, ts: Date.now()};
	}
	
	if(!/\.history\//.test(file) && upload_history) {
		// Add to file history
		filesToPut++;
		getFile(file + '.history/', {codec: 'dir'}, function(history) {
			if(!history && !is_new_file) {
				// User switched tier
				filesToPut++;
				getFile(file, {codec: 'raw', cache: false}, function(old, err) {
					if(!err) {
						putFile(file + '.history/v0' + file.match(/(\/|\.\w+)?$/)[0], {codec: 'raw'}, old, {created: undefined, edited: undefined});
					}
					filesToPut--;
					if(transaction && !inTransaction && !filesToPut) window.endTransaction();
				});
			}
			
			var histname = file + '.history/v' + (history ? Math.max.apply(Math, Object.keys(history).map(function(name) { return parseInt(name.substr(1), 10); })) + 1 : 1) + file.match(/(\/|\.\w+)?$/)[0];
			putFile(histname, {codec: options.codec}, contents, {edited: now}, function(histid, blob) {
				
				// Copy history file to destination
				var is_bootstrap_file = file.substr(0, 4) === '/key' || file.substr(0, 5) === '/hmac';
				var id = sjcl.codec.hex.fromBits((is_bootstrap_file ? private_hmac : files_hmac).mac(file));
				var req = new XMLHttpRequest();
				req.open('PUT', '/object/' + id);
				req.addEventListener('load', function() {
					if(this.status === 200) {
						cont();
					} else {
						console.log('error', this);
					}
				});
				req.addEventListener('error', function() {
					console.log('error', this);
				});
				req.send(blob);
				
			}, progress);
			filesToPut--;
			if(transaction && !inTransaction && !filesToPut) window.endTransaction();
		});
	} else {
		if(transaction) {
			transaction[file] = [file, options, contents, attrs, callback, progress];
		} else {
			// Upload file
			console.log('PUT', file);
			var is_bootstrap_file = file.substr(0, 4) === '/key' || file.substr(0, 5) === '/hmac';
			var id = sjcl.codec.hex.fromBits((is_bootstrap_file ? private_hmac : files_hmac).mac(file));
			if(options.codec) contents = sjcl.codec[options.codec].toBits(contents);
			var blob = new Blob([sjcl.encrypt(is_bootstrap_file ? private_key : files_key, contents)], {type: 'binary/octet-stream'});
			var req = new XMLHttpRequest();
			req.open('PUT', '/object/' + id);
			req.addEventListener('load', function() {
				if(this.status === 200) {
					if(upload_history) {
						// We were uploading a *.history/* file
						if(callback) callback(id, blob);
					} else {
						// We were uploading a normal file
						cont();
					}
				} else {
					console.log('error', this);
				}
			});
			req.addEventListener('progress', function(evt) {
				if(evt.lengthComputable) {
					if(progress) progress(evt.loaded, evt.total);
				}
			});
			req.addEventListener('error', function() {
				console.log('error', this);
			});
			req.send(blob);
		}
	}
	
	function cont() {
		if(callback) callback();
		notifyFileChange(file, is_new_file ? 'created' : 'modified');
	}
};

var mimeTypes = {
	js: 'text/javascript',
	css: 'text/css',
	png: 'image/png',
	html: 'text/html'
};

function resolve(from, to, rootParent) {
	if(to === '') return from;
	if(to[0] === '/') return resolve(rootParent, to.substr(1));
	var resolved = from.replace(/[^/]*$/, '') + to;
	var rParentOrCurrent = /([^./]+\/\.\.\/|\/\.(?=\/))/g;
	while(rParentOrCurrent.test(resolved)) resolved = resolved.replace(rParentOrCurrent, '');
	return resolved;
}
function basename(path) {
	return path.substr(path.lastIndexOf('/') + 1);
}

function parallel(fns, callback) {
	var todo = fns.length,
		results = new Array(todo),
		error;
	fns.forEach(function(fn, i) {
		fns[i](function(data, err) {
			results[i] = data;
			error = err;
			if(!--todo) {
				callback.apply(this, results.concat(error));
			}
		});
	});
}

window.prepareFile = function(file, options, callback, progress, createObjectURL) {
	var _options = {};
	Object.keys(options).forEach(function(key) {
		_options[key] = options[key];
	});
	var extension = file.substr(file.lastIndexOf('.') + 1);
	if(extension === 'html' && options.bootstrap !== false) {
		_options.bootstrap = false;
		var inline_linenr = +(new Error().stack.match(/[:@](\d+)/) || [])[1] + 2;
		var data = [
			'<!DOCTYPE html>',
			'<html>',
			'<head>',
			'	<meta charset="utf-8">',
			'</head>',
			'<body>',
			'<script>',
			'if(window.parent === window.top) document.write("Loading…");',
			'document.root = ' + JSON.stringify(file) + ';',
			'document.filenames = {};',
			'document.apikey = ' + JSON.stringify(getAPIKey()) + ';',
			'window.addEventListener("message", function(message) {',
			'	if(message.data.action === "createObjectURL") {',
			'		var arg = message.data.args[0], object;',
			'		try {',
			'			object = new File([arg.data], arg.name, {type: arg.type});',
			'		} catch(e) {',
			'			object = new Blob([arg.data], {type: arg.type});',
			'		}',
			'		var url = URL.createObjectURL(object);',
			'		document.filenames[url] = arg.name;',
			'		window.top.postMessage({inReplyTo: message.data.messageID, result: [url]}, "*");',
			'		return;',
			'	}',
			'	if(message.data.progress) {',
			'		if(window.parent !== window.top) window.parent.postMessage({action: "wm.setProgress", args: [message.data.result[0] / message.data.result[1]]}, "*");',
			'	} else {',
			'		document.open();',
			'		document.write(message.data.result[0]);',
			'		document.close();',
			'		if(navigator.userAgent.indexOf("Firefox") !== -1) history.replaceState({}, "", ""); // Make refresh iframe work in Firefox',
			'		if(window.parent !== window.top) window.parent.postMessage({action: "wm.hideProgress", args: []}, "*");',
			'	}',
			'});',
			'window.top.postMessage({action: "fs.prepareFile", args: ' + JSON.stringify([file, _options]) + ', apikey: document.apikey}, "*");',
			'if(window.parent !== window.top) window.parent.postMessage({action: "wm.showProgress", args: []}, "*");',
			'</script>',
			'</body>',
			'</html>',
			'<!--# sourceURL = /Core/core.js > inline at line ' + inline_linenr + ' -->'
		].join('\n');
		callback(data);
	} else if(extension === 'html' && (options.compat !== false || options.csp)) {
		_options.compat = false;
		parallel([
			function(cb) {
				prepareString('\n<script src="/Core/compat.js"></script>\n', {rootParent: '/'}, cb, function() {}, createObjectURL);
			},
			function(cb) {
				prepareFile(file, _options, cb, progress, createObjectURL);
			},
			function(cb) {
				getFile(options.appData + 'localStorage', function(localStorage) {
					cb(localStorage || '{}');
				});
			}
		], function(compat, c, localStorage, err) {
			if(err) return callback('');
			callback((options.csp ? '<meta http-equiv="Content-Security-Policy" content="' + options.csp.replace(/"/g, '&quot;') + '">' : '') + c.replace(/^\uFEFF/, '').replace(/(?=<script|<\/head)/i, '<script>document.airborn_localStorage = ' + localStorage + ';</script>' + compat));
		});
	} else if(extension === 'js') {
		getFile(file, function(contents, err) {
			if(err) return callback('');
			if(options.compat !== false && !options.webworker) {
				console.log('Parsing', file);
				var renames = {cookie: 'airborn_cookie', location: 'airborn_location', top: 'airborn_top'};
				if(navigator.userAgent.match(/Chrome/)) renames.localStorage = 'airborn_localStorage';
				contents = renameGlobalVariables(contents, renames);
			}
			if(options.webworker) {
				_options.relativeParent = file;
				_options.rootParent = file.match(/\/Apps\/.+?\//)[0];
				prepareString(contents, _options, callback, progress, createObjectURL);
				return;
			}
			callback(contents);
		});
	} else {
		getFile(file, function(contents, err) {
			if(err) return callback('');
			_options.rootParent = _options.relativeParent = file;
			delete _options.bootstrap;
			delete _options.compat;
			prepareString(contents, _options, callback, progress, createObjectURL);
		});
	}
};

window.prepareString = function(contents, options, callback, progress, createObjectURL) {
	var i = 0,
		match, matches = [],
		rURL,
		rSchema = /^[a-z]+:/i,
		filesDownloaded = 0;
	if(options.webworker) {
		var rImportScripts = /importScripts\s*\([\s\S]*?\)/;
		while((match = contents.substr(i).match(rImportScripts))) {
			var j = 0,
				subject = match[0];
			rURL = /((["']))(.*?)(\2)()/;
			i += match.index;
			match.pos = i;
			while((match = subject.substr(j).match(rURL))) {
				if(!rSchema.test(match[3])) {
					matches.push(match);
				}
				
				j += match.index;
				match.pos = i + j;
				j++;
			}
			i++;
		}
	} else {
		rURL = /((?:(?:src|href|icon)\s*=|url\()\s*(["']?))(.*?)(?=["') >])(\2\s*\)?)/;
		while((match = contents.substr(i).match(rURL))) {
			if(!rSchema.test(match[3])) {
				matches.push(match);
			}
			
			i += match.index;
			match.pos = i;
			i++;
		}
	}
	
	if(matches.length) {
		matches.forEach(function(match) { // We don't process matches immediately for when getFile calls callback immediately.
			prepareUrl(match[3], options, function(data, err) {
				if(options.webworker) data = data.replace(/'/g, "\\'");
				if(!err) match[5] = data;
				filesDownloaded++;
				updateProgress();
				if(filesDownloaded === matches.length) {
					matches.reverse().forEach(function(match) {
						if(match[5]) contents = contents.substr(0, match.pos + match[1].length) + match[5] + contents.substr(match.pos + match[0].length - match[4].length);
					});
					callback(contents);
				}
			}, function(done, total) {
				match.progressDone = done;
				match.progressTotal = total;
				updateProgress();
			}, createObjectURL);
		});
	} else {
		callback(contents);
	}
	function updateProgress() {
		if(!progress) return;
		var done = filesDownloaded;
		var total = matches.length;
		matches.forEach(function(match) {
			if('progressDone' in match) {
				done += match.progressDone; 
				total += match.progressTotal;
			}
		});
		progress(done, total);
	}
};

var rArgs = /[?#].*$/;
window.prepareUrl = function(url, options, callback, progress, createObjectURL) {
	var args = (url.match(rArgs) || [''])[0];
	url = url.replace(rArgs, '');
	if(url === '') {
		callback(args);
		return;
	}
	if(url.substr(0, 2) === '//') {
		callback('https:' + url + args);
		return;
	}
	var extension = url.substr(url.lastIndexOf('.') + 1);
	var path = resolve(options.relativeParent, url, options.rootParent);
	if(extension === 'html' || extension === 'css' || extension === 'js') prepareFile(path, {bootstrap: options.bootstrap, compat: options.compat, webworker: options.webworker, appData: options.appData}, cb, progress, createObjectURL);
	else getFile(path, {codec: 'sjcl'}, cb);
	
	function cb(c, err) {
		var data;
		if(!err) {
			if((navigator.userAgent.match(/Firefox\/(\d+)/) || [])[1] < 35) {
				if(extension === 'js') data = ',' + encodeURIComponent(c + '\n//# sourceURL=') + path;
				else if(extension === 'css') data = ',' + encodeURIComponent(c + '\n/*# sourceURL=' + path + ' */');
				else if(extension === 'html') data = ',' + encodeURIComponent(c + '\n<!--# sourceURL=' + path + ' -->');
				else if(typeof c === 'string') data = ',' + encodeURIComponent(c);
				else data = ';base64,' + sjcl.codec.base64.fromBits(c);
				data = 'data:' + mimeTypes[extension] + ';filename=' + encodeURIComponent(path + args) + ';charset=utf-8' + data;
				callback(data + args);
			} else {
				if(extension === 'js') data = c + '\n//# sourceURL=' + path;
				else if(extension === 'css') data = c + '\n/*# sourceURL=' + path + ' */';
				else if(extension === 'html') data = c + '\n<!--# sourceURL=' + path + ' -->';
				else if(typeof c === 'string') data = c;
				else data = sjcl.codec.arrayBuffer.fromBits(c);
				createObjectURL({data: data, type: mimeTypes[extension], name: path + args}, callback);
			}
		} else {
			callback(null, err);
		}
	}
};

getFile('/Core/lodash.min.js', eval);
getFile('/Core/js-yaml.js', eval);
getFile('/Core/3rdparty/jszip/jszip.min.js', eval);
getFile('/Core/3rdparty/esprima.js', eval);
getFile('/Core/3rdparty/estraverse.js', eval);

var mainWindow;

window.openWindow = function(path, callback) {
	prepareUrl(path, {compat: false, rootParent: '/'}, function(url) {
		var div = document.createElement('div');
		div.className = 'window';
		div.style.overflow = 'hidden';
		var iframe = document.createElement('iframe'); 
		iframe.sandbox = 'allow-scripts';
		iframe.src = url;
		iframe.scrolling = 'no';
		div.appendChild(iframe);
		document.body.appendChild(div);
		mainWindow = iframe.contentWindow;
		callback(iframe);
	}, function() {}, function(arg, callback) {
		var object;
		try {
			object = new File([arg.data], arg.name, {type: arg.type});
		} catch(e) {
			object = new Blob([arg.data], {type: arg.type});
		}
		callback(URL.createObjectURL(object));
	});
};

var title = document.createElement('title');
document.head.appendChild(title);
window.setTitle = function(t) {
	title.textContent = t ? t + ' - Airborn' : 'Airborn';
};

var icon = document.createElement('link');
icon.rel = 'shortcut icon';
document.head.appendChild(icon);
window.setIcon = function(href) {
	icon.href = href;
};

function corsReq(url, callback, responseType) {
	var req = new XMLHttpRequest();
	if('withCredentials' in req) {
		req.open('GET', url, true);
	} else if(typeof XDomainRequest !== 'undefined') {
		req = new XDomainRequest();
		req.open('GET', url);
	} else {
		throw new Error('CORS not supported.');
	}
	req.onload = callback;
	if(responseType) req.responseType = responseType;
	req.send();
}

window.installPackage = function(manifest_url, params, callback) {
	if(typeof params === 'function') {
		callback = params;
		params = {};
	}
	corsReq(manifest_url, function() {
		var manifest = JSON.parse(this.responseText);
		corsReq(manifest.package_path, function() {
			var zip = new JSZip(this.response);
			var keys = Object.keys(zip.files);
			var uploaded = 0;
			var total = 0;
			var target = '/Apps/' + basename(manifest.package_path).replace('-' + manifest.version, '').replace('.zip', '') + '/';
			keys.forEach(function(path) {
				var file = zip.files[path];
				if(!file.options.dir) {
					total++;
					putFile(target + path, {codec: 'arrayBuffer'}, file.asArrayBuffer(), function() {
						uploaded++;
						if(uploaded === total) {
							callback({installState: 'installed'});
						}
					});
				}
			});
		}, 'arraybuffer');
	});
};

window.update = function() {
	corsReq('http://airborn-update-stage.herokuapp.com/current-id', function() {
		var currentId = this.response;
		getFile('/Core/version-id', function(contents) {
			if(currentId !== contents) {
				if((settings.core && settings.core.notifyOfUpdates === false) || (document.hasFocus() && confirm(
					'There is an update for Airborn. Do you want to install it now? You can continue using Aiborn while and after updating. The update will apply next time you open Airborn.\nIf you click Cancel, you will be asked again in 1 hour or next time you open Airborn.'
				))) {
					corsReq('http://airborn-update-stage.herokuapp.com/current', function() {
						var zip = new JSZip(this.response);
						var keys = Object.keys(zip.folder('airborn').files);
						var target = '/Core/';
						keys.forEach(function(path) {
							var file = zip.files[path];
							if(!file.options.dir) {
								putFile(target + path.replace(/^airborn\//, ''), {codec: 'arrayBuffer'}, file.asArrayBuffer());
							}
						});
					}, 'arraybuffer');
				}
			}
		});
	});
};

window.getServerMessages = function() {
	var req = new XMLHttpRequest();
	req.open('GET', '/messages');
	req.responseType = 'json';
	req.addEventListener('load', function() {
		if(this.status === 200) {
			this.response.forEach(function(message) {
				if(message.min_core_version && message.min_core_version > core_version) return;
				if(message.max_core_version && message.max_core_version < core_version) return;
				alert(message.text);
			});
		}
	});
	req.send();
};

window.loadSettings = function() {
	getFile('/settings', {codec: 'json'}, function(_settings) {
		settings = _settings;
	});
};

window.logout = function() {
	sessionStorage.clear();
	localStorage.clear();
	document.cookie = document.cookie.split('=')[0] + '=';
	window.location.reload();
};

var APIKeys = [];
function getAPIKey() {
	var array = new Uint32Array(10);
	window.crypto.getRandomValues(array);
	var key = Array.prototype.slice.call(array).toString();
	APIKeys.push(key);
	return key;
}
window.isValidAPIKey = function(key) {
	return APIKeys.indexOf(key) !== -1;
};

// From: http://tobyho.com/2013/12/02/fun-with-esprima/
function renameGlobalVariables(source, variables) {
	if(typeof esprima === 'undefined' || typeof estraverse === 'undefined') return source;
	var ast;
	try {
		ast = esprima.parse(source, {range: true});
	} catch(e) {
		return source;
	}
	var scopeChain = [];
	var identifiers = [];
	var replaces = [];
	estraverse.traverse(ast, {
		enter: enter,
		leave: leave
	});
	replaces.sort(function(a, b) {
		return b.range[0] - a.range[0];
	});
	for(var i = 0; i < replaces.length; i++) {
		source = source.substr(0, replaces[i].range[0]) + variables[replaces[i].name] + source.substr(replaces[i].range[1]);
	}
	return source;
	
	function enter(node) {
		if(createsNewScope(node)) {
			if(node.type === 'FunctionDeclaration') {
				scopeChain[scopeChain.length - 1].push(node.id.name);
			}
			if(node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
				scopeChain.push(node.params.map(function(node) { return node.name; }));
				if(node.rest) {
					scopeChain[scopeChain.length - 1].push(node.rest.name);
				}
			} else {
				scopeChain.push([]);
			}
		}
		if(node.type === 'VariableDeclarator') {
			var currentScope = scopeChain[scopeChain.length - 1];
			currentScope.push(node.id.name);
		}
		if(node.type === 'Identifier') {
			identifiers.push(node);
		}
		if(node.type === 'ObjectExpression') {
			node.properties.forEach(function(property) {
				property.key.isObjectKey = true;
			});
			return node;
		}
		if(node.type === 'MemberExpression') {
			if(!node.computed) {
				node.property.isProperty = true;
				return node;
			}
		}
	}
	function leave(node) {
		if(createsNewScope(node)) {
			renameGlobals(identifiers, scopeChain);
			scopeChain.pop();
			identifiers = [];
		}
	}
	function isVarDefined(varname, scopeChain) {
		for(var i = 0; i < scopeChain.length; i++) {
			var scope = scopeChain[i];
			if(scope.indexOf(varname) !== -1) {
				return true;
			}
		}
		return false;
	}
	function renameGlobals(identifiers, scopeChain) {
		for(var i = 0; i < identifiers.length; i++) {
			var identifier = identifiers[i];
			var varname = identifier.name;
			if(!identifier.isObjectKey && variables.hasOwnProperty(varname) && (identifier.isProperty || !isVarDefined(varname, scopeChain))) {
				replaces.push(identifier);
			}
		}
	}
	function createsNewScope(node) {
		return node.type === 'FunctionDeclaration' ||
			node.type === 'FunctionExpression' ||
			node.type === 'Program';
	}
}
//# sourceURL=/Core/core.js