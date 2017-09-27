const cheerio = require('cheerio');
const http = require('http');
var _ = require('lodash');
var natural = require('natural');
var request = require('request');
var robotsParser = require('robots-txt-parser');
var url = require('url');
var validUrl = require('valid-url');
require('google-closure-library');
goog.require('goog.structs.PriorityQueue');

function FocusedCrawler(config) {
  this._frontier = new goog.structs.PriorityQueue();
  this._activeLinks = new Set();
  this._visitedLinks = {};
  this._stemmedSearchTerms = new Set();
  this._callBack = undefined;
  this._concurrentRequestCt = 0;
  this._successfulFetchCount = 0;
  
  this._visitedEnum = {
    ERROR: -1,
    NOT_FETCHED: 0,
    FETCHED: 1,
  };
  
  var defaultConfig = {
    maxLinks: 100000,
    maxConcurrentRequests: 2000,
    concurrentRequestsTimeout: 0,
    timeout: 3000,
    userAgent: "fcrawler",
    robotsCompliance: true,
    debugMode: false,
    followRedirect: false,
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

  this._bots = robotsParser({
    userAgent: this.config.userAgent,
    allowOnNeutral: true
  });

  this._pool = new http.Agent({});
  this._crawlerRequest = request.defaults({
    headers: { "User-Agent": this.config.userAgent },
    followRedirect: this.config.followRedirect,
    pool: this._pool,
    timeout: this.config.timeout
  });
}

// Clears out crawl specific data so the FocusedCrawler
// instance can be re-used for another crawl.
FocusedCrawler.prototype.clear = function() {
  this._frontier.clear();
  this._activeLinks.clear();
  this._visitedLinks = {};
  this._stemmedSearchTerms.clear();
  this._callBack = undefined;
  this._concurrentRequestCt = 0;
  this._successfulFetchCount = 0;
};

FocusedCrawler.prototype.crawl = function(seedLinks, searchTerms, callBack) {
  var that = this;

  if (searchTerms.length > 0) {
    _.forEach(searchTerms, function(term) {
      that._stemmedSearchTerms.add(natural.PorterStemmer.stem(term));
    });
  }

  _.forEach(seedLinks, function(link) {
    that._frontier.enqueue(0, link);
  });
  this._searchTerms = new Set(searchTerms);
  this._callBack = callBack;

  this._crawl();
};

FocusedCrawler.prototype.getFrontier = function() {
  return this._frontier; // goog.structs.PriorityQueue
};

FocusedCrawler.prototype.getActiveLinks = function() {
  return this._activeLinks; // Set
};

FocusedCrawler.prototype.getVisitedLinks = function() {
  return this._visitedLinks; // Object
};

FocusedCrawler.prototype.getSuccessfulFetchCount = function() {
  return this._successfulFetchCount; // Number
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

  return this._filterLinks(links, body);
};

FocusedCrawler.prototype._filterLinks = function(links, body) {
  var that = this;
  var linkValues = {};
  var sim = that._computeSim(body);
  
  _.forEach(links, function(link) {
    var linkObj = url.parse(link);
    if (!linkObj["query"] && that._isAllowedDomain(linkObj)) {
      linkValues[link] = sim;
    }
  });

  return linkValues;
};

FocusedCrawler.prototype._computeSim = function(body) {
  var that = this;
  var $ = cheerio.load(body);
  var dTermFreqs = _.countBy(natural.PorterStemmer
    .tokenizeAndStem($('body').text()));

  var numerSum = 0;
  var denomDocSum = 0;
  this._stemmedSearchTerms.forEach(function(term) {
    if (dTermFreqs[term] !== undefined) {
      numerSum += dTermFreqs[term];
      denomDocSum += Math.pow(dTermFreqs[term], 2);
    }
  });

  if (denomDocSum === 0) return 1;

  var denomSum = Math.sqrt(denomDocSum * this._stemmedSearchTerms.size);
  return 1 - (numerSum / denomSum);
};

FocusedCrawler.prototype._fetchLink = function(link) {
  var that = this;

  this._activeLinks.add(link);
  this._crawlerRequest.get(link, function(error, response, body) {
    if (that._successfulFetchCount >= that.config.maxLinks)
      _.forEach(that._pool.requests, function(r) { r.abort(); });
    else if (error) {
      that._visitedLinks[link] = that._visitedEnum.ERROR;
      if (that.config.debugMode) console.error(link + "\n\t" + error);
    } 
    else {
      var contentType = response.headers["content-type"];
      if (contentType !== undefined && contentType.includes("html")) {
        that._visitedLinks[link] = that._visitedEnum.FETCHED;
        that._successfulFetchCount++;
        var linkValues = that._extractLinks(link, body);
        Object.keys(linkValues).forEach(function(link) {
          that._frontier.enqueue(linkValues[link], link);
        });
        if (that._callBack !== undefined) 
          that._callBack(link, response, body);
      }
      else that._visitedLinks[link] = that._visitedEnum.ERROR;
    }
    that._activeLinks.delete(link);
    that._concurrentRequestCt--;
  });
};

FocusedCrawler.prototype._shouldFetchLink = function(link) {
  if (link === undefined ||
    this._visitedLinks.hasOwnProperty(link) ||
    this._activeLinks.has(link)) 
      return false;
  return true;
};

FocusedCrawler.prototype._crawl = function() {
  if (this._successfulFetchCount >= this.config.maxLinks) return;

  var that = this;
  var link = this._frontier.dequeue();

  if (this._shouldFetchLink(link)) {
    if (this.config.robotsCompliance) {
      this._bots.canCrawl(link)
        .then((isAllowed) => {
          if (isAllowed) this._fetchLink(link);
          else if (this.config.debugMode) {
            this._visitedLinks[link] = this._visitedEnum.NOT_FETCHED;
            console.log(link + "\n\tSkipped due to robots.txt");
          }
        })
        .catch((rejected) => {
          // TODO: Unresolved robots.txt connections need to be aborted
          // when link quota has been met.
          if (this.config.debugMode)
            console.error(link + "\n\tCould not get robots.txt: " + rejected);
        });
    }
    else
      this._fetchLink(link);
  }

  this._concurrentRequestCt++;
  if (this._concurrentRequestCt <= this.config.maxConcurrentRequests)
    this._crawl();
  else
    setTimeout(function() { that._crawl(); }, 
      that.config.concurrentRequestsTimeout);
};

module.exports = FocusedCrawler;