# fcrawler

fcrawler is a focused web crawling library for Node.js.

## Installation

```
git clone https://github.com/mzhang0/fcrawler.git
cd fcrawler && npm install
```

## Usage

```javascript
var FocusedCrawler = require('fcrawler');
var fc = new FocusedCrawler();
var searchTerms = [
	'javascript','code','programming’,
	'language','js','ecmascript','web'
];
var seedLinks = ['https://developer.mozilla.org/en-US/docs/Web/JavaScript'];
fc.crawl({
searchTerms: searchTerms,
	seedLinks: seedLinks,
	onCrawl: function(link, response, body, terms, priority) {
		console.log(link);
	},
	onComplete: function() {
		console.log("Focused crawl completed!");
	}
});
```