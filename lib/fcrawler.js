const cheerio = require('cheerio');
var _ = require('lodash');
var request = require('request');
var url = require('url');
var validUrl = require('valid-url');
require('google-closure-library');
goog.require('goog.structs.PriorityQueue');

function FocusedCrawler(config) {
  this._frontier = new goog.structs.PriorityQueue();
  this._activeLinks = new Set();
  this._visitedLinks = new Set();
  this._searchTerms = new Set();
  this._callStackSize = 0;
  this._successfulFetches = 0;

  var defaultConfig = {
    maxLinks: 100000,
    callStackBreakSize: 1000,
    timeout: 3000,
    robotsCompliance: true,
    domainWhiteList: [],
    domainBlackList: []
  };

  this.config = _.extend(defaultConfig, config);

  this._requestOptions = {}; 
}

FocusedCrawler.prototype.clear = function() {
  this._frontier.clear();
  this._activeLinks.clear();
  this._visitedLinks.clear();
  this._searchTerms.clear();
  this._callStackSize = 0;
  this._successfulFetches = 0;
};

FocusedCrawler.prototype.crawl = function(seedLinks, searchTerms) {
  var that = this;

  seedLinks.forEach(function(link) {
    that._frontier.enqueue(1, link);
  });
  this._searchTerms = new Set(searchTerms);

  this._crawl();
};

FocusedCrawler.prototype.getFrontier = function() {
  return this._frontier; // goog.structs.PriorityQueue
};

FocusedCrawler.prototype.getActiveLinks = function() {
  return this._activeLinks; // Set
};

FocusedCrawler.prototype.getVisitedLinks = function() {
  return this._visitedLinks; // Set
};

FocusedCrawler.prototype._crawl = function() {
  var that = this;
  var link = this._frontier.dequeue();

  if (this._successfulFetches > this.config.maxLinks) return;
  
  if (this._shouldFetchLink(link)) this._fetchLink(link);

  if (this._callStackSize <= this.config.callStackBreakSize) {
    this._callStackSize++;
    this._crawl();
  }
  else
    setTimeout(function() { that._callStackSize++; that._crawl(); }, 0);
};

FocusedCrawler.prototype._extractLinks = function(link, body) {
  var that = this;
  var linkObj = url.parse(link);
  var $ = cheerio.load(body);

  $('a').each(function() {
    var href = $(this).attr('href');
    if (validUrl.isWebUri(href)) // href is an absolute link
      that._frontier.enqueue(1, href);
    else if (validUrl.isUri(href)) { // href is a relative link
      hrefObj = url.parse(href);
      hrefObj["protocol"] = linkObj.protocol;
      hrefObj["host"] = linkObj.host;
      that._frontier.enqueue(1, url.format(hrefObj));
    }
  });
};

FocusedCrawler.prototype._fetchLink = function(link) {
  var that = this;

  this._activeLinks.add(link);
  this._visitedLinks.add(link);
  request(link, function(error, response, body) {
    if (!error) {
      var contentType = response.headers["content-type"];
      if (contentType !== undefined && contentType.includes("html")) {
        that._successfulFetches++;
        console.log(that._successfulFetches + ": " + link);
        that._extractLinks(link, body);
      }
    } 
    else
      console.log(error);
    that._activeLinks.delete(link);
    that._callStackSize--;
  });
};

FocusedCrawler.prototype._shouldFetchLink = function(link) {
  if (link === undefined || this._visitedLinks.has(link))
    return false;
  return true;
};

module.exports = FocusedCrawler;