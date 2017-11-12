var bayes = require('node-bayes');
var cheerio = require('cheerio');
var http = require('http');
var _ = require('lodash');
var LRU = require('lru-cache');
var natural = require('natural');
var request = require('request');
var robotsParser = require('robots-parser')
var url = require('url');
var validUrl = require('valid-url');
var textract = require('textract');
var TfidfUtil = require('./tfidf');
require('google-closure-library');
goog.require('goog.structs.PriorityQueue');

function FocusedCrawler(config) {
  this._frontier = new goog.structs.PriorityQueue();
  this._activeLinks = new Set();
  this._visitedLinks = {};
  this._stemmedSearchTerms = new Set();
  this._callBack = null;
  this._onComplete = null;

  this._classifier = null;
  this.classifierFeatures = [];
  this._tfidf = new TfidfUtil();

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
    robotsCacheSize: 500,
    debugMode: false,
    followRedirect: false,
    domainWhiteList: [],
    domainBlackList: []
  };

  this.config = _.extend(defaultConfig, config);

  if (this.config.domainWhiteList.length > 0 && 
      this.config.domainBlackList.length > 0)
    throw new Error("domainWhiteList and domainBlackList " +
      "cannot both be specified.");

  if (this.config.domainWhiteList.length > 0)
    this._isAllowedDomain = this._isAllowedDomainWhiteList;
  else if (this.config.domainBlackList.length > 0)
    this._isAllowedDomain = this._isAllowedDomainBlackList;
  else
    this._isAllowedDomain = function() { return true };

  this._robotstxtCache = LRU(this.config.robotsCacheSize);

  this._pool = new http.Agent();
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
  this._callBack = null;
  this._onComplete = null;
  this._classifier = null;
  this._classifierFeatures.length = 0;
  this._tfidf = new TfidfUtil();
  this._concurrentRequestCt = 0;
  this._successfulFetchCount = 0;
};

FocusedCrawler.prototype.crawl = function(inputObj) {
  var that = this;

  if (inputObj.searchTerms.length > 0) {
    _.forEach(inputObj.searchTerms, function(term) {
      that._stemmedSearchTerms.add(natural.PorterStemmer.stem(term));
    });
  }

  if (inputObj.trainingLinks)
    this._trainClassifier(inputObj.trainingLinks, inputObj.irrelevantTerms);

  _.forEach(inputObj.seedLinks, function(link) {
    that._frontier.enqueue(0.0, link);
  });

  this._searchTerms = new Set(inputObj.searchTerms);
  this._callBack = inputObj.onCrawl;
  this._onComplete = inputObj.onComplete;
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

FocusedCrawler.prototype._extractLinks = function(link, resp, body) {
  var that = this;
  var urlObj = url.parse(link);
  var $ = cheerio.load(body);
  var links = [];

  $('a').each(function() {
    var href = $(this).attr('href');
    var aText = $(this).text();
    if (validUrl.isUri(href)) {
      var hrefObj = url.parse(href);
      if (!validUrl.isWebUri(href)) {
        hrefObj["protocol"] = urlObj.protocol;
        hrefObj["host"] = urlObj.host;
      }
      hrefObj["hash"] = undefined; // Remove URL hash
      links.push({ url: url.format(hrefObj), anchorText: aText });
    }
  });
  this._filterLinks(links, link, resp, body);
};

FocusedCrawler.prototype._filterLinks = function(links, pLink, resp, body) {
  var that = this;
  var docPri;

  var buffer = Buffer.from(body, 'utf8');
  textract.fromBufferWithMime('text/html', buffer, function(err, text) {
    if (!err && that._successfulFetchCount < that.config.maxLinks) {
      that._successfulFetchCount++;
      var docTerms = natural.PorterStemmer.tokenizeAndStem(text);
      
      if (that._classifier)
        // Computes probability of page belonging to the relevant category
        // using the trained classifier
        docPri = that._computeDocProb(docTerms);

      // Computes cosine similarity using normalized TF values
      else docPri = that._computeTermsSim(docTerms);
      
      _.forEach(links, function(link) {
        var urlObj = url.parse(link.url);
        if (!urlObj["query"] && that._isAllowedDomain(urlObj)) {
          if (link.anchorText) {
            var anchorTerms = natural.PorterStemmer
                          .tokenizeAndStem(link.anchorText);
            var anchorPri;

            if (that._classifier)
              // Compute cosine similarity using TF-IDF values computed from
              // the training set corpus.
              anchorPri = that._computeTermsSim(anchorTerms, true);

            // Compute cosine similarity using normalized TF values
            else anchorPri = that._computeTermsSim(anchorTerms);

            that._frontier.enqueue(1.0 - (0.5 * docPri + 0.5 * anchorPri),
                                  link.url); // _frontier is implemented as a
                                        // min-heap. Scores range from 0 to 1,
                                        // so priority = 1.0 - score
          }
          else that._frontier.enqueue(1.0 - docPri, link.url);
        }
      });

      if (that._callBack)
        // Execute onCrawl function supplied to .crawl method
        that._callBack(pLink, resp, body, docTerms, docPri);
    }
  });
};

FocusedCrawler.prototype._computeDocProb = function(docTerms) {
  var that = this;
  var normTfs = this._tfidf.computeNormTfs(docTerms);
  var tfidfs = this._tfidf.computeTfidfWithTf(normTfs);
  var data = [];

  _.forEach(this._classifierFeatures, function(term) {
    if (tfidfs[term] !== undefined) data.push(tfidfs[term]);
    else data.push(0);
  });

  // Probabilties are given in percentages here
  var probs = this._classifier.predict(data);
  var relProb = probs["Relevant"];
  var irrProb = probs["Irrelevant"];
  
  if (relProb < irrProb) return 0;
  return relProb / 100.0;
};

FocusedCrawler.prototype._computeTermsSim = function(terms, useTfidf) {
  var that = this;
  var stemmedTermsValues = {};
  var termNormTf = this._tfidf.computeNormTfs(terms);
  var termValues;

  // TFIDF instead of normalized TF is only used to compute
  // anchor text similarity when in classifier mode
  if (useTfidf) {
    termValues = this._tfidf.computeTfidfWithTf(termNormTf);
    this._stemmedSearchTerms.forEach(function(term) {
      stemmedTermsValues[term] = that._tfidf.getIdf(term);
    });
  }
  else {
    termValues = termNormTf;
    this._stemmedSearchTerms.forEach(function(term) {
      stemmedTermsValues[term] = 1;
    });
  }

  return this._tfidf.computeCosSim(stemmedTermsValues, termValues);
};

FocusedCrawler.prototype._fetchLink = function(link) {
  var that = this;

  this._activeLinks.add(link);
  this._crawlerRequest.get(link, function(error, response, body) {
    that._activeLinks.delete(link);
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
        that._extractLinks(link, response, body);
      }
      else that._visitedLinks[link] = that._visitedEnum.ERROR;
    }
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
  if (this._successfulFetchCount >= this.config.maxLinks) 
    return this._onComplete ? this._onComplete() : null;

  var that = this;
  var link = this._frontier.dequeue();

  if (this._shouldFetchLink(link)) {
    if (this.config.robotsCompliance) {
      var rLink = url.resolve(link, "/robots.txt");
      if (this._robotstxtCache.has(rLink)) {
        let rParser = robotsParser(rLink, this._robotstxtCache.get(rLink));
        if (rParser.isAllowed(link, this.config.userAgent))
            this._fetchLink(link);
        else
          this._visitedLinks[link] = this._visitedEnum.NOT_FETCHED;
      }
      else {
        this._crawlerRequest.get(rLink, function(error, response, body) {
          if (error) {
            that._robotstxtCache.set(rLink, null);
            that._fetchLink(link);
          }
          else {
            that._robotstxtCache.set(rLink, body);
            let rParser = robotsParser(rLink, body);
            if (rParser.isAllowed(link, that.config.userAgent))
              that._fetchLink(link);
            else
              that._visitedLinks[link] = that._visitedEnum.NOT_FETCHED;
          }
        });
      }
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

FocusedCrawler.prototype._trainClassifier = function(trainingLinks, 
                                                     irrelevantTerms) {
  var that = this;
  var promises = [];
  var stemmedIrrTerms = new Set();

  if (irrelevantTerms) {
    _.forEach(irrelevantTerms, function(term) {
      stemmedIrrTerms.add(natural.PorterStemmer.stem(term));
    });
  }

  _.forEach(trainingLinks, function(entry) {
    promises.push(new Promise(function(resolve) {
      that._crawlerRequest.get(entry.link, function(error, response, body) {
        if (error) {
          var msg = "Error fetching training link";
          if (that.config.debugMode)
            console.error(msg + " " + entry.link);
          throw new Error(msg);
        }
        else {
          var buffer = Buffer.from(body, 'utf8');
          textract.fromBufferWithMime('text/html', buffer,
            function(err, text) {
              if (err) throw new Error("Error parsing training page");
              else {
                var terms = natural.PorterStemmer.tokenizeAndStem(text);
                entry["terms"] = terms;
                resolve(entry);
              }
            });
        }
      })
    }));
  });

  Promise.all(promises).then(function(result) {
    var documents = {};
    _.forEach(result, function(entry) {
      if (entry) documents[entry.link] = entry.terms;
    });
    that._tfidf.setDocuments(documents);
    var documentsTfidf = that._tfidf.getDocumentsTfidf();
    var docNames = Object.keys(documentsTfidf);
    var features = _.concat(that._stemmedSearchTerms,
                            that._stemmedIrrTerms, 'Relevancy');
    that._classifierFeatures = _.concat(Array.from(that._stemmedSearchTerms),
                                        Array.from(stemmedIrrTerms));
    
    var data = [];
    _.forEach(docNames, function(doc) {
      var docData = [];
      _.forEach(that._classifierFeatures, function(term) {
        if (documentsTfidf[doc][term] !== undefined)
          docData.push(documentsTfidf[doc][term]);
        else docData.push(0);
      });
      docData.push(_.find(trainingLinks, function(tLinkObj) {
        return tLinkObj.link === doc;
      }).relevancy);
      data.push(docData);
    });

    that._classifierFeatures.push("Relevancy");
    that._classifier = new bayes.NaiveBayes({
      columns: that._classifierFeatures,
      data: data,
      verbose: true
    });
    that._classifier.train();
    that._classifierFeatures.pop();
  });
};

module.exports = FocusedCrawler;