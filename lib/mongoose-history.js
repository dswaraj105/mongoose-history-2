"use strict";
const mongoose = require('mongoose');
const _ = require('lodash');
const hm = require('./history-model');
const async = require('async')

module.exports = function historyPlugin(schema, options) {
  const customCollectionName  = options && options.customCollectionName;
  const customDiffAlgo = options && options.customDiffAlgo;
  const diffOnly  = options && options.diffOnly;
  const metadata = options && options.metadata;

  // Clear all history collection from Schema
  schema.statics.historyModel = function() {
    return hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
  };

  // Clear all history documents from history collection
  schema.statics.clearHistory = function(callback) {
    const History = hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
    History.remove({}, function(err) {
      callback(err);
    });
  };

  // Save original data
  schema.post( 'init', function() {
    if (diffOnly){
      this._original = this.toObject();
    }
  });

  function setMetadata(original, d, historyDoc, callback){
    async.each(metadata, (m, cb) => {
      if (typeof(m.value) === 'function'){
        if (m.value.length === 3){
          /** async function */
          m.value(original, d, function(err, data){
            if (err) cb(err);
            historyDoc[m.key] = data;
            cb();
          })
        } else {
          historyDoc[m.key] = m.value(original, d);
          cb();
        }
      } else {
        historyDoc[ m.key] = d ? d[ m.value] : null;
        cb();
      }
    }, callback)
  }

  const isChanged = (oldVal, newVal) => {

    if(_.isNil(oldVal) && _.isNil(newVal)){
      return false
    } else if(_.isNil(oldVal) || _.isNil(newVal)){
      return true
    }
  
    if(typeof newVal != typeof oldVal){
      return true;
    }
  
  
    // check for array
    if(_.isArray(newVal) || _.isArray(oldVal)){
      if(!_.isArray(newVal) || !_.isArray(oldVal)){
        return true
      }
  
      if(_.isEmpty(newVal) && _.isEmpty(oldVal)){
        return false
      }
    
      if(_.isEmpty(newVal) || _.isEmpty(oldVal)){
        return true
      }
  
      let diffrencea = _.differenceWith(newVal, oldVal, _.isEqual)
      let diffrenceb = _.differenceWith(oldVal, newVal, _.isEqual)
  
      if(_.isEmpty(diffrencea) && _.isEmpty(diffrenceb)){
        return false
      }
  
      return true
    }
  
    if(_.isObject(newVal)){
      
      if(_.isEmpty(newVal) && _.isEmpty(oldVal)){
        return false
      }
    
      if(_.isEmpty(newVal) || _.isEmpty(oldVal)){
        return true
      }
  
      return !_.isEqual(newVal, oldVal)
    }
  
    if(oldVal === newVal) return false
    else return true;
  
  }

  // Create a copy when insert or update, or a diff log
  schema.pre('save', function(next) {
    let historyDoc = {};

    if(diffOnly && !this.isNew) {
      var original = this._original || {};
      delete this._original;
      var d = this.toObject();
      var diff = {};
      // diff['_id'] = d['_id'];

      console.log('this is original document', original);
      console.log('this is the new one being updated', d);
      
      for(var k in d){
        if(customDiffAlgo) {
          var customDiff = customDiffAlgo(k, d[k], original[k]);
          if(customDiff) {
            diff[k] = customDiff.diff;
          }
        } else {
          var changed = isChanged(d[k], original[k]);
          if(changed){
            diff[k] = original[k] ? original[k] : "empty";
          }
        }
      }
    
      // historyDoc = createHistoryDoc(diff, 'u');

      // changes here
      historyDoc = createHistoryDoc(d, 'u', diff);
    } else {
      var d = this.toObject();
      let operation = this.isNew ? 'i' : 'u';
      historyDoc = createHistoryDoc(d, operation);
    }

    saveHistoryModel(original, d, historyDoc, this.collection.name, next);
  });

  // Listen on update
  schema.pre('update', function(next) {
      processUpdate.call(this, next);
  });

  // Listen on updateOne
  schema.pre('updateOne', function (next) {
      processUpdate.call(this, next);
  });

  // Listen on findOneAndUpdate
  schema.pre('findOneAndUpdate', function (next) {
      processUpdate.call(this, next);
  });

  // Create a copy on remove
  schema.pre('remove', function(next) {
    let d = this.toObject();
    let historyDoc = createHistoryDoc(d, 'r');

    saveHistoryModel(this.toObject(), d, historyDoc, this.collection.name, next);
  });

  // Create a copy on findOneAndRemove
  schema.post('findOneAndRemove', function (doc, next) {
    processRemove.call(this, doc, next);
  });

  const wait = (t) => {
    return new Promise((res,rej) => {
        setTimeout(res, t);
    });
};

  schema.pre('updateMany', async function processUpdateMany(next) {

    
    let updatingDocs = await this.find(this._conditions).lean();

    next();

    await wait(10000);

    console.log("Docs fetched that are being updated")
    updatingDocs.forEach(doc => {
      console.log(doc._id);
      console.log(doc.firstName, doc.lastName)
    });
    console.log("Docs fetched that are being updated")
 


    // creating history Objects 
    const updatingValues = this._update.$set || {};

    const historyDocs = [];
    console.log("Lenth of updating docs", updatingDocs.length)
    if(updatingDocs.length > 0){
      updatingDocs.forEach(doc => {
        console.log("Creating history for ", doc._id);
        let d = { ...doc };
        let diff = {};

        for(var k in updatingValues){

          try{
            if(String(d[k]) != String(updatingValues[k])){
                diff[k] = updatingValues[k];
                d[k] = updatingValues[k];
            }
          } catch(e) {}
        }

        let historyDoc = createHistoryDoc(d, 'u', diff);

        console.log("One History Doc -> ", historyDoc);

        historyDocs.push(historyDoc);
      })
    }

    // saving the docs in historyDB
    saveHistoryModelMultiple(historyDocs, this.collection.name, next)



    console.log("[Mongo-History] Update Many used")
    console.log()

    // next();
  })

  function createHistoryDoc(d, operation, diffrence) {
    d.__v = undefined;

    let historyDoc = {};
    historyDoc['t'] = new Date();
    historyDoc['o'] = operation;
    historyDoc['d'] = d;
    if(diffrence){
      historyDoc['diff'] = diffrence;
    }

    return historyDoc;
  }

  function saveHistoryModel(original, d, historyDoc, collectionName, next) {
    if (metadata) {
      setMetadata(original, d, historyDoc, (err) => {
        if (err) return next(err);
        let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
        history.save(next);
      });
    } else {
      let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
      history.save(next);
    }
  }

  async function saveHistoryModelMultiple(historyDocs, collectionName){

    let history = hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options);

    let res = await history.insertMany(historyDocs)
    
    console.log("Result saving history docs - ", res);
  }

  function processUpdate(next) {
    let d = this._update.$set || this._update;
    let historyDoc = createHistoryDoc(d, 'u');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName, next);
  }

  function processRemove(doc, next) {
    let d = doc.toObject();
    let historyDoc = createHistoryDoc(d, 'r');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName, next);
  }

};
