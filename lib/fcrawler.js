const cheerio = require('cheerio');
var _ = require('lodash');
var request = require('request');
var robots = require('robots-txt');
var level = require('level');
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
    userAgent: "fcrawler",
    robotsCompliance: true,
    domainWhiteList: [],
    domainBlackList: []
  };

  this.config = _.extend(defaultConfig, config);

  if (this.config.domainWhiteList.length > 0 && 
      this.config.domainBlackList.length > 0)
    throw "domainWhiteList and domainBlackList cannot both be specified.";

  if (this.config.domainWhiteList.length > 0)
    this._isAllowedDomain = this._isAllowedDomainWhiteList;
  else if (this.config.domainBlackList.length > 0)
    this._isAllowedDomain = this._isAllowedDomainBlackList;
  else
    this._isAllowedDomain = function() { return true };

  this._bots = robots({
    db: level('./robots-txt-cache'),
    ttl: 1000 * 60 * 60 * 24
  });
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

FocusedCrawler.prototype._isAllowedDomainWhiteList = function(linkObj) {
  _.forEach(this.config.domainWhiteList, function(domain) {
    if (linkObj.hostname.contains(domain)) return true;
  });
  return false;
};

FocusedCrawler.prototype._isAllowedDomainBlackList = function(linkObj) {
  _.forEach(this.config.domainBlackList, function(domain) {
    if (linkObj.hostname.contains(domain)) return false;
  });
  return true;
};

FocusedCrawler.prototype.crawl = function(seedLinks, searchTerms) {
  var that = this;

  _.forEach(seedLinks, function(link) {
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

FocusedCrawler.prototype._extractLinks = function(link, body) {
  var that = this;
  var linkObj = url.parse(link);
  var $ = cheerio.load(body);
  var links = [];

  $('a').each(function() {
    var href = $(this).attr('href');
    if (validUrl.isUri(href)) {
      var hrefObj = url.parse(href);
      if (!validUrl.isWebUri(href)) {
        hrefObj["protocol"] = linkObj.protocol;
        hrefObj["host"] = linkObj.host;
      }
      hrefObj["hash"] = undefined; // Remove URL hash
      links.push(url.format(hrefObj));
    }
  });

  return this._filterLinks(links);
};

FocusedCrawler.prototype._filterLinks = function(links, body) {
  var that = this;
  var linkValues = {};

  _.forEach(links, function(link) {
    var linkObj = url.parse(link);
    if (!linkObj["query"] && that._isAllowedDomain(linkObj)) 
      linkValues[link] = that._computeSim(body);
  });

  return linkValues;
}

FocusedCrawler.prototype._computeSim = function(body) {
  // TODO: Compute and return similarity score
  return 1;
}

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
        var linkValues = that._extractLinks(link, body);
        Object.keys(linkValues).forEach(function(link) {
          that._frontier.enqueue(linkValues[link], link);
        });
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

FocusedCrawler.prototype._crawl = function() {
  var that = this;
  var link = this._frontier.dequeue();

  if (this._successfulFetches > this.config.maxLinks) return;

  if (this._shouldFetchLink(link)) {
    if (this.config.robotsCompliance) {
      this._bots.isAllowed(this.config.userAgent, link)
        .then((fulfilled) => { this._fetchLink(link); })
        .catch((rejected) => {});
    }
    else
      this._fetchLink(link);
  }

  if (this._callStackSize <= this.config.callStackBreakSize) {
    this._callStackSize++;
    this._crawl();
  }
  else
    setTimeout(function() { that._callStackSize++; that._crawl(); }, 0);
};

module.exports = FocusedCrawler;