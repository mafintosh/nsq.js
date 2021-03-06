
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var reconnect = require('./mixins/reconnect');
var debug = require('debug')('nsq:reader');
var Connection = require('./connection');
var close = require('./mixins/close');
var ready = require('./mixins/ready');
var lookup = require('nsq-lookup');
var Set = require('set-component');
var utils = require('./utils');
var assert = require('assert');
var delegate = utils.delegate;

/**
 * Expose `Reader`.
 */

module.exports = Reader;

/**
 * Initialize a new Reader.
 *
 * - `topic` subscription topic
 * - `channel` subscription channel
 * - `nsqd` optional addresses
 * - `nsqlookupd` optional addresses
 * - `maxAttempts` max attempts before discarding messages [Infinity]
 * - `maxInFlight` max messages in-flight [10]
 * - `pollInterval` nsqlookupd poll interval[10000]
 * - `msgTimeout` session-specific msg timeout
 * - `ready` when `false` auto-RDY maintenance will be disabled
 * - `trace` optional trace function
 * - `maxConnectionAttempts` max reconnection attempts [Infinity]
 *
 * The Reader is in charge of establishing connections
 * between the given `nsqd` nodes, or looking them
 * up and connecting via `nsqlookupd`. Subscribes
 * are buffered so that no initialization is required.
 *
 * @param {Object} opts
 * @api public
 */

function Reader(opts) {
  // required
  assert(opts.topic, '.topic required');
  assert(opts.channel, '.channel required');
  assert(opts.nsqd || opts.nsqlookupd, '.nsqd or .nsqlookupd addresses required');

  // initialize
  this.trace = opts.trace || function(){};
  this.maxConnectionAttempts = opts.maxConnectionAttempts || Infinity;
  this.pollInterval = opts.pollInterval || 10000;
  this.maxAttempts = opts.maxAttempts || Infinity;
  this.maxInFlight = opts.maxInFlight || 10;
  this.msgTimeout = opts.msgTimeout;
  this.nsqlookupd = opts.nsqlookupd;
  this.channel = opts.channel;
  this.autoready = opts.ready;
  this.topic = opts.topic;
  this.nsqd = opts.nsqd;
  this.connected = {};
  this.conns = new Set;

  // mixins
  close(this);

  this.connect();
}

/**
 * Inherit from `Emitter.prototype`.
 */

Reader.prototype.__proto__ = Emitter.prototype;

/**
 * Establish connections to the given nsqd instances,
 * or look them up via nsqlookupd.
 *
 * @api private
 */

Reader.prototype.connect = function(){
  var self = this;

  // nsqd
  if (this.nsqd) {
    this.connectToEach(this.nsqd);
    return;
  }

  // nsqlookupd
  this.lookup(function(err, nodes){
    if (err) return self.emit('error', err);
    self.connectToEach(nodes.map(address));
  });

  this.poll(this.pollInterval);
};

/**
 * Poll for nsqlookupd additional nodes every `ms`.
 *
 * @param {Number} ms
 * @api private
 */

Reader.prototype.poll = function(ms){
  var self = this;

  debug('polling every %dms', ms);
  setInterval(function(){
    self.lookup(function(err, nodes){
      if (err) return self.emit('error', err);
      nodes.map(address).forEach(function(addr){
        if (self.connected[addr]) {
          debug('already connected to %s', addr);
        } else {
          self.connectTo(addr);
        }
      });
    });
  }, ms);
};

/**
 * Lookup nsqd nodes via .nsqlookupd addresses and
 * filter on the `.topic` and invoke `fn(err, nodes)`.
 *
 * @param {Function} fn
 * @api private
 */

Reader.prototype.lookup = function(fn){
  var addrs = this.nsqlookupd.map(normalize);
  var topic = this.topic;
  var self = this;

  debug('lookup %j', addrs);
  lookup(addrs, function(err, nodes){
    if (err) return fn(err);
    nodes = nodes.filter(byTopic(topic));
    debug('found %d nodes with topic %j', nodes.length, topic);
    fn(null, nodes);
  });
};

/**
 * Connect to all `addrs`.
 *
 * @param {Array} addrs
 * @api private
 */

Reader.prototype.connectToEach = function(addrs){
  addrs.forEach(this.connectTo.bind(this));
};

/**
 * Connect to nsqd at `addr`.
 *
 * @param {String} addr
 * @api private
 */

Reader.prototype.connectTo = function(addr){
  var maxInFlight = this.maxInFlight;
  var maxAttempts = this.maxAttempts;
  var msgTimeout = this.msgTimeout;
  var channel = this.channel;
  var topic = this.topic;

  this.connected[addr] = true;

  debug('connect nsqd %s %s/%s [%d]', addr, topic, channel, maxInFlight);
  addr = utils.address(addr);

  // connect
  var conn = new Connection({
    maxInFlight: maxInFlight,
    maxAttempts: maxAttempts,
    msgTimeout: msgTimeout,
    trace: this.trace,
    host: addr.host,
    port: addr.port
  });

  // apply reconnection
  reconnect(conn, this.maxConnectionAttempts);

  // apply rdy state
  if (false !== this.autoready) ready(conn);

  // delegate events
  this.delegate(conn);

  // reconnection
  conn.on('ready', function(){
    conn.subscribe(topic, channel);
    conn.ready(conn.maxInFlight);
  });

  conn.connect();
  this.conns.add(conn);
  this.distributeMaxInFlight();
};

/**
 * Delegate events from `conn`.
 *
 * @param {Connection} conn
 * @api private
 */

Reader.prototype.delegate = function(conn){
  delegate(conn, 'error response', this);
  delegate(conn, 'closing', this);
  delegate(conn, 'discard', this);
  delegate(conn, 'message', this);
  delegate(conn, 'connect', this);
  delegate(conn, 'ready', this);
  delegate(conn, 'error', this);
  delegate(conn, 'end', this);
};

/**
 * Distribute per-connection maxInFlight.
 *
 * @api private
 */

Reader.prototype.distributeMaxInFlight = function(){
  var max = this.maxInFlight;
  var size = this.conns.size();
  n = Math.ceil(max / size);
  debug('distribute RDY %s (%s) to %s connections', max, n, size);
  this.conns.each(function(conn){
    conn.maxInFlight = n;
  });
};

/**
 * Distribute RDY `n` to the connected nodes.
 *
 * @param {Number} n
 * @api public
 */

Reader.prototype.ready = function(n){
  debug('ready %s', n);
  n = Math.floor(n / this.conns.size());
  this.conns.each(function(conn){
    conn.ready(n);
  });
};

/**
 * Pause all connections.
 *
 * @api public
 */

Reader.prototype.pause = function(){
  debug('pause');
  this.conns.each(function(conn){
    conn.pause();
  });
};

/**
 * Resume all connections.
 *
 * @api public
 */

Reader.prototype.resume = function(){
  debug('resume');
  this.conns.each(function(conn){
    conn.resume();
  });
};

/**
 * Gracefully close the connections.
 *
 * @param {Function} [fn]
 * @api public
 */

Reader.prototype.close = function(fn){
  debug('close');
  if (fn) this.once('close', fn);
  this.conns.each(function(conn){
    conn.close();
  });
};

/**
 * Filter nodes by `topic`.
 */

function byTopic(topic) {
  return function(node){
    return ~node.topics.indexOf(topic);
  }
}

/**
 * Return address of `node`.
 */

function address(node) {
  return node.broadcast_address + ':' + node.tcp_port;
}

/**
 * Normalize addresses to include the http scheme.
 */

function normalize(addr) {
  if (0 == addr.indexOf('http')) return addr;
  return 'http://' + addr;
}
