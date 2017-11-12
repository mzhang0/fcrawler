function TfidfUtil() {
	this._idfObj = {}
	this._documentsTfidf = {};
}

TfidfUtil.prototype.clear = function() {
	this._idfObj = {}
	this._documentsTfidf = {};
};

TfidfUtil.prototype.getDocumentsTfidf = function() {
	return this._documentsTfidf;
};

TfidfUtil.prototype.addDocument = function(docName, terms) {
	// Compute normalized TF values of all terms in each input document
	this._documentsTfidf[docName] = this.computeNormTfs(terms, true);
};

TfidfUtil.prototype.computeIdf = function() {
	var corpusTerms = Object.keys(this._idfObj);
	var corpusSize = Object.keys(this._documentsTfidf).length;
	for (var i = 0; i < corpusTerms.length; i++) {
		var term = corpusTerms[i];
		this._idfObj[term] =
			Math.log10(corpusSize / (this._idfObj[term]));
	}
};

TfidfUtil.prototype.computeCosSim = function(objA, objB) {
	var shortObj, longObj;
	if (Object.keys(objA).length <= Object.keys(objB).length) {
		shortObj = objA;
		longObj = objB;
	}
	else {
		shortObj = objB;
		longObj = objA;
	}
	var shortTerms = Object.keys(shortObj);
	var longTerms = Object.keys(longObj);

	var numerSum = 0;
	var denomSumShort = 0;
	var denomSumLong = 0;
	var denomSum;

	for (var i = 0; i < shortTerms.length; i++) {
		var term = shortTerms[i];
		if (longObj[term] !== undefined) {
			numerSum += shortObj[term] * longObj[term];
		}
		denomSumShort += shortObj[term] * shortObj[term];
	}

	for (var i = 0; i < longTerms.length; i++) {
		var term = longTerms[i];
		denomSumLong += longObj[term] * longObj[term];
	}

	denomSum = Math.sqrt(denomSumShort) * Math.sqrt(denomSumLong);

	if (denomSum > 0) return numerSum / denomSum;

	return 0;
};

TfidfUtil.prototype.computeTfidf = function() {
	var docNames = Object.keys(this._documentsTfidf);
	for (var i = 0; i < docNames.length; i++) {
		var docName = docNames[i];
		var terms = Object.keys(this._documentsTfidf[docName]);
		for (var j = 0; j < terms.length; j++) {
			var term = terms[j];
			this._documentsTfidf[docName][term] *= this.getIdf(term);
		}
	}
};

TfidfUtil.prototype.setDocuments = function(documents) {
	if (Object.keys(this._documentsTfidf).length > 0) this.clear();

	var docNames = Object.keys(documents);
	
	// Compute normalized TF values of all terms in each input document
	for (var i = 0; i < docNames.length; i++) {
		var docName = docNames[i];
		var terms = documents[docName];
		this._documentsTfidf[docName] = this.computeNormTfs(terms, true);
	}
	
	// Compute IDF
	var corpusTerms = Object.keys(this._idfObj);
	for (var i = 0; i < corpusTerms.length; i++) {
		var term = corpusTerms[i];
		this._idfObj[term] =
			Math.log10(docNames.length / (this._idfObj[term]));
	}

	// Compute TFIDF values of all terms in each input document
	for (var i = 0; i < docNames.length; i++) {
		var docName = docNames[i];
		var terms = Object.keys(this._documentsTfidf[docName]);
		for (var j = 0; j < terms.length; j++) {
			var term = terms[j];
			this._documentsTfidf[docName][term] *= this.getIdf(term);
		}
	}
};

TfidfUtil.prototype.computeTermCounts = function(terms) {
	var max = 0;
	var termCounts = {};

	for (var i = 0; i < terms.length; i++) {

		if (termCounts[terms[i]] !== undefined)
			termCounts[terms[i]] += 1;
		else termCounts[terms[i]] = 1;

		if (termCounts[terms[i]] > max)
			max = termCounts[terms[i]];
	}

	return { termCounts: termCounts, max: max };
};

TfidfUtil.prototype.computeNormTfs = function(terms, corpusCounting) {
	var result = this.computeTermCounts(terms);
	var max = result.max;
	var termFreqs = result.termCounts;
	var tfTerms = Object.keys(termFreqs);

	for (var i = 0; i < tfTerms.length; i++) {
		var term = tfTerms[i];

		if (corpusCounting === true) {
			if (this._idfObj[term] !== undefined)
				this._idfObj[term] += 1;
			else this._idfObj[term] = 1;
		}

		termFreqs[term] = ((0.5 * termFreqs[term]) / max) + 0.5;
	}

	return termFreqs;
};

TfidfUtil.prototype.computeTfidfWithTf = function(termFreqs) {
	var terms = Object.keys(termFreqs);
	for (var i = 0; i < terms.length; i++)
		termFreqs[terms[i]] *= this.getIdf(terms[i]);
	return termFreqs;
};

TfidfUtil.prototype.getTopTerms = function(numTerms, includedDocs) {
	var allTermsObj = {};
	var allTermsArr = [];
	var docs;
	if (!includedDocs)
		docs = Object.keys(this._documentsTfidf);
	else docs = includedDocs;
	for (var i = 0; i < docs.length; i++) {
		var termsObj = this._documentsTfidf[[docs[i]]];
		var terms = Object.keys(termsObj);
		for (var j = 0; j < terms.length; j++) {
			if (allTermsObj[terms[j]] === undefined ||
				allTermsObj[terms[j]] < termsObj[terms[j]])
					allTermsObj[terms[j]] = termsObj[terms[j]];
		}
	}

	var allTerms = Object.keys(allTermsObj);

	for (var i = 0; i < allTerms.length; i++) {
		allTermsArr.push({
			term: allTerms[i], 
			tfidf: allTermsObj[allTerms[i]]
		});
	}

	allTermsArr.sort(function(a, b) { return b.tfidf - a.tfidf; });

	return allTermsArr.slice(0, numTerms);
};

TfidfUtil.prototype.getIdf = function(term) {
	if (this._idfObj[term] !== undefined)
		return this._idfObj[term];
	else return 0;
};

module.exports = TfidfUtil;