/**
 * This is a base class for a RESTful Client.
 * It is responsible for
 * - CRUD operations
 * - Lazy loading data
 * - Caching
 * - and error handling
 * It is a Javascript abstraction for the interface to the DB.
 * This implementation corresponds to the mLab Data API http://docs.mlab.com/data-api/
 */
"use strict"

var log = require("loglevel").getLogger("BaseRestClient"); // http://pimterry.github.io/loglevel/
var _ = require('lodash')

// JsonSchmea Validator  https://github.com/tdegrunt/jsonschema
var Validator = require('jsonschema').Validator;
// custom Format for validating a MongoDB ObjectID (as 24 character long HEX value)
Validator.prototype.customFormats.ObjectID = function(input) {
  return input !== undefined && input.match(/[0-9a-f]{24}/)
}
var validator = new Validator();

var Client = require('node-rest-client').Client
var client = new Client()
client.on('error', function(err) {
  console.error('ERROR in node-rest-client', err)
})

// default properties for timestamps (createdAt and updatedAt)
var jsonSchemaForTimestamps = {
  properties: {
    createdAt: {
      type: "object",
      properties: {
        $date : { type: "string", format: "date-time", required: true }
      }
      //TODO: required: true    is that necessary here too?
    },
    updatedAt: {
      type: "object",
      properties: {
        $date : { type: "string", format: "date-time", required: true }
      }
    }
  }
}

module.exports = class BaseRestClient {

  /**
   * This method will lazily create a 'singleton' instance of this class and return it.
   * In all furhter calls, exactly that same instance will be returne
   */
  static getInstance(options) {
    if (this._instance == null) {
      log.debug("Creating new "+this.name)
      this._instance = new this(options)      // this is very Java OOP like line :-)
    }
    return this._instance
  }

  /**
   * Create a new instance of a RestClient
   * @param opitons configuration for this client:
   *   options.modelName    name of model, used in log messages
   *   options.url          may contain path variables in the form ${var}
   *   options.urlParams    (optional) global URL params, for example apiKey
   *   options.nameOfIdAttr (optional) name of id field. By default '_id' will be used as used by mongoDB. (Keep in mind that JSON replies have the id in  '_id.$oid')
   *   options.timestamps   (optional) if "true", then createdAt and (last) updatedAt date fields will be added and updated automatically
   *   options.jsonSchema   (optional) jsonSchmea to validate documents after loading and before storing them to the DB.
   */
  constructor(options) {
    if (options.url == undefined) throw new Error("BaseRestClient needs an options.URL")
    this.options = options
    this.options.nameOfIdAttr = options.nameOfIdAttr || '_id'
    this.options.modelName    = options.modelName || this.constructor.name
    this.cache  = {}
    if (options.timestamps) {
      _.defaultsDeep(this.options.jsonSchema, jsonSchemaForTimestamps)
    }
  }

  /**
   * Retreive the ID of a given item.
   * This ID is used as key in the cache.
   * You must overwrite this if your id attribute is not called "_id".
   */
  getId(item) {
    if (item === undefined) throw new Error("BaseRestClient: Cannot get Id of undefined!")
    return _.get(item, this.options.nameOfIdAttr+'.$oid')
  }

  /*
   ================= SCHEMA VALIDATION  ==================
   */

  /**
   * Validate the given item against this.options.jsonSchmea
   * using https://github.com/tdegrunt/jsonschema
   * @return true if item is valid
   */
  validate(item) {
    var result = validator.validate(item, this.options.jsonSchema)
    for (var i = result.errors.length; i--; ) {
      console.error(result.errors[i])
    }
    return result.errors.length == 0
  }

  /*
   ================= CACHE operations  ==================
   */

  /** put one item (or all items in an array) into the cache */
  cachePut(itemOrItems) {
    if (_.isArray(itemOrItems)) {
      itemOrItems.forEach((item) => {
        this.cache[this.getId(item)] = item
      })
    } else {
      this.cache[this.getId(itemOrItems)] = itemOrItems
    }
  }

  /**
   * Get an item from the cache by its ID.
   * This might return undefined if item is not in the cache! Use getById() if you need to query for an item
   */
  cacheGet(id) {
    return this.cache[id]
  }

  /*
   ================= READ (GET) operations  ==================
   */

  /** Get all items from the server. Without using the cache! */
  getAll(params) {
    var that = this
    var args = {
      parameters: _.merge(params, that.options.urlParams),
      path: { id: '' }
    }
    return new Promise(function(resolve, reject) {
      log.debug(that.options.modelName+".getAll() => ", args)
      client.get(that.options.url, args, function(data, response) {
        log.debug(that.options.modelName+".getAll() <= Array("+data.length+")")
        that.cachePut(data)
        resolve(data)
      }).on('error', function (err) {
        log.error("ERROR in getAll()", err)
        reject('ERROR in BaseRestClient.getAll():', err)
      })
    })
  }

  /**
   * Get one item by its unique ID.
   * By default the item will be returned from the cache.
   * @param id the primary key of the item to fetch
   * œparam  params (optional) additional URL query parameteres
   * @param nocache (optional) if true, then the value will fetched and updated from the server
   * @return a Promise that will resolve with the fetched item
   */
  getById(id, params, nocache) {
    log.debug(this.options.modelName+"getById(id="+id+") => ")
    if (!nocache && this.cacheGet(id) !== undefined) {
      log.debug(this.options.modelName+".getById(id="+id+") <= FROM CACHE ", this.cacheGet(id))
      return Promise.resolve(this.cacheGet(id))
    }
    var that = this
    var args = {
      parameters: _.merge(params, that.options.urlParams),
      path: { id: id }
    }
    return new Promise(function(resolve, reject) {
      client.get(that.options.url, args, function(item, response) {
        log.debug(that.options.modelName+".getById(id="+id+") <= ", item)
        that.cachePut(item)  // remember item in cache
        resolve(item)
      }).on('error', function (err) {
        reject('ERROR in BaseRestClient.getById(id='+id+'):', err)
      })
    })
  }

  /**
   * Find mulitple documents by their repective ID
   * This method is highly optimized:
   *  1. Remove duplicates from `ids` array
   *  2. Try to find items in the cache
   *  3. Only query for the remaining items by id
   *  4. Put the received new items in the cache for later.
   *  4. return merged results from cache and DB
   *
   * @param ids array of IDs
   * @param params additional url query parameters
   * @param nocache if true, then will not lookup items from cache
   * @return array of found items
   *
   */
  getByIds(ids, params, nocache) {
    //console.log("getByIds", ids, params)
    if (!_.isArray(ids)) throw new Error("Param for getByIds must be Array.")
    var that = this
    var result = []
    var notInCacheIds = []
    ids = _.uniq(ids)
    //----- get items from cache, where possible
    ids.forEach((id) => {
      if (!nocache && this.cache[id] !== undefined) {
        result.push(this.cache[id])
      } else {
        notInCacheIds.push('{$oid:"'+id+'"}')  // see http://stackoverflow.com/questions/26938598/mongodb-oid-vs-objectid
      }
    })
    if (notInCacheIds.length == 0) {
      log.debug(this.options.modelName+".getByIds(): Found all in cache")
      return Promise.resolve(result)  // Found all in cache
    }
    //----- query DB for the rest of the ids that were not found in the cache
    var query = '{'+this.options.nameOfIdAttr+' : { $in: ['+notInCacheIds.join(',')+'] } }'
    return new Promise(function(resolve, reject) {
      that.findByQuery(query, params).then((dbResult) => {
        resolve(result.concat(dbResult))
      })
    })
  }

  /**
   * Find mulitple documents by their repective ID, and return a map
   * { ID1: item1,   ID2: item2, ... }
   * @param ids array of IDs
   * @return map from IDs to items
   */
  getByIdsAsMap(ids, params, nocache) {
    var result = {}
    var that = this
    return new Promise(function(resolve, reject) {
      that.getByIds(ids, params, nocache).then((items) => {
        items.forEach((item) => {
          result[that.getId(item)] = item
        })
        resolve(result)
      })
    })
  }

  /**
   * Find one or more items that match the given mongoDB query.
   * Will cache the results.
   * @param query  e.g. { email: "user@host.com" }
   * @param params (optional) further URL parameters
   * @return a Promise that will resolve to the array of matched items
   */
  findByQuery(query, params) {
    var that = this
    if (!_.isString(query)) {
      query = JSON.stringify(query)
    }
    var args = {
      parameters: _.merge(params, that.options.urlParams),
      path: { id: '' }
    }
    args.parameters.q = query
    return new Promise(function(resolve, reject) {
      log.debug(that.options.modelName+".findByQuery("+query+") => ...")
      client.get(that.options.url, args, function(data, response) {
        if (data.length < 4)
          log.debug(that.options.modelName+".findByQuery("+query+") <= \n"+JSON.stringify(data, ' ', 2))
        else
          log.debug(that.options.modelName+".findByQuery("+query+") <= Array("+data.length+")")
        that.cachePut(data)   //put results of query into cache
        resolve(data)
      }).on('error', function (err) {
        reject('ERROR in BaseRestClient.findByQuery(query='+query+'):', err)
      })
    })
  }

  /**
   * Find one doc with a query.
   * Will cache the result.
   * @query a query that matches exactly one doc
   * @return A promise that will resolve with the one found doc
   *         or reject when nothing was found
   */
  findOne(query, params) {
    var that = this
    return new Promise(function(resolve, reject) {
      that.findByQuery(query, params).then((matches) => {
        if (matches == undefined || matches.length == 0) {
          console.warn("Could not find ", query)
          reject("Could not find "+JSON.stringify(query))
        }
        if (matches.length > 1) console.warn('findOne found more than one match. Returning first one.')
        that.cachePut(matches[0])
        resolve(matches[0])
      })
    })
  }

  /**
   * count the number of documents that match the given query
   */
  count(query, params) {
    var that = this
    var args = {
      parameters: _.merge(params, that.options.urlParams),
      path: { id: '' }
    }
    args.parameters.c = true  // only return the count
    return new Promise(function(resolve, reject) {
      log.debug(that.options.modelName+".count() => ", args)
      client.get(that.options.url, args, function(data, response) {
        log.debug(that.options.modelName+".count() <= "+data)
        resolve(data)
      }).on('error', function (err) {
        console.error("ERROR in count()", err)
        reject('ERROR in BaseRestClient.count():', err)
      })
    })
  }

  /**
   * Populate the given path: replace its value with the child doc.
   *
   * Item in the DB may have references to other child items. Those references have
   * an mongo ObjectId as their value. When populated, then this reference is replaced
   * with the actual child doc.
   *
   * opulate its attribute given by path.
   * That path must lead to a foreign key, ie. the ID of a child document:
   *
   *     // before population
   *     parentDoc = {
   *       _id: { $oid: 'ID_OF_PARENT'},
   *       attr1: 'value1',
   *       refToChild: { $oid: 'ID_OF_CHILD_DOC' }
   *       [...]
   *     }
   *
   *     populate(parentDoc, 'refToChild', childService).then((populatedChild) => { ... })
   *
   *     // after population
   *     populatedChild == {
   *       _id: { $oid: 'ID_OF_PARENT'},
   *       attr1: 'value1',
   *       refToChild: {
   *         _id: { $oid: 'ID_OF_CHILD'}
   *         childAttr1: 'val1'
   *         childAttr2: 'val2'
   *         [...]
   *       }
   *       [...]
   *     }
   *
   *  Remark: Since parentDoc is only a reference, it will also point to the populated instance!
   *
   * @param item item with child doc under path
   * @param path name (or path) of attribute in parent document that points to id of child document
   * @return (A Promise that will resolve to) the parent document that has the the given path replaced/populated with the child document
   */
  populate(item, path, childService) {
    log.debug('populate(', path, 'with', childService.options.modelName, ')')
    if (_.has(item, path+'.'+childService.nameOfIdAttr)) {
      log.debug("Already populated")
      return Promise.resolve(item)   // already populated
    }
    var childId = _.get(item, path+'.$oid')   //TODO:  $oid is mongoDB specific. Where to handle it?
    return childService.getById(childId).then(function(childItem) {
      _.set(item, path, childItem)
      return item
    })
  }

  /**
   * Populate the given path in all items.
   *
   * This is highly optimized:
   *  1. collect a list of childIds (that are not yet populated)
   *  2. receive all child items for those childIds (will use cache in childService)
   *  3. replace all references with child items
   *
   * @param itemArray array of items (need items. No ids!)
   * @param path path to child id that will be replaced/populated
   * @param childServie where to receive child items from
   * @return (A promise that will resolve to) a list of populated items
   */
  populateAll(itemArray, path, childService) {
    //console.log("ENTER populateAll")
    if (!_.isArray(itemArray)) throw new Error("Need array in populateAll()")
    //collect ids of not yet populated child items
    var childIds = []
    for (var i = itemArray.length; i--; ) {
      var alreadyPopulated = _.get(itemArray[i], path+"."+childService.nameOfIdAttr)  // When path._id exists, then the child object is already populated
      if (alreadyPopulated !== undefined) {
        //console.log("populateAll(path='+path+'): Found already populated item childId=", alreadyPopulated)
      } else {
        var childId = _.get(itemArray[i], path+'.$oid')        // path.$oid  is the not yet populated child id "reference"
        //console.log("will populate childId="+childId)
        childIds.push(childId)
      }
    }
    return childService.getByIds(childIds).then(function(result) {
      itemArray.forEach(function(item) {
        var childId = _.get(item, path+'.$oid')
        _.set(item, path, childService.cacheGet(childId))
      })
      return itemArray
    })

    /*  Shorter but unoptimized. Since we send all tasks at once, the childServcie's cache would not be used (if not already filled)
    var tasks = []
    idsOrItemArray.forEach(idOrItem => {
      tasks.push(this.populate(idOrItem, path, childService))
    })
    return Promise.all(tasks)
    */
  }


  /*
   ================= WRITE (POST/PUT/UPDATE) operations  ==================
   */

  //POST will save over the old document; PUT will modify it (when passed the ID matches)
  /**
   * Insert a new item
   * @param newItem data for new item (without _id)
   * @return (A Promise that will resolve to) the newly created item (with _id)
   */
  postItem(newItem, params) {
    //console.log("ENTER: postItem")
    var that = this
    return new Promise(function(resolve, reject) {
      var args = {
        parameters: _.merge(params, that.options.urlParams),
        data: JSON.stringify(newItem),
        headers: { "Content-Type": "application/json" },
        path: { id: '' }
      }
      log.debug(that.options.modelName+".postItem() => ", args)
      client.post(that.options.url, args, function(data, response) {
        log.debug(that.options.modelName+".postItem() <= ", data)
        resolve(data)
      }).on('error', function(err) {
        console.error("ERROR in "+this.options.modelName+".postItem(", newItem, "):", err)
        reject(err)
      })
    })
  }

  /**
   * Delete one item given by its ID
   * and also remove it from cache.
   * @param id the primary key for the item to delete
   * @return (A Promise that will resolve with) the deleted item
   */
  deleteById(id, params) {
    var that = this
    return new Promise(function(resolve, reject) {
      var args = {
        parameters: _.merge(params, that.options.urlParams),
        path: { id: id }
      }
      log.debug(that.options.modelName+".deleteById(id="+id+") => ", args)
      client.delete(that.options.url, args, function(deletedItem, response) {
        log.debug(that.options.modelName+".deleteById(id="+id+") <= successfully deleted")
        delete that.cache[that.getId(deletedItem)]   // remove item from cache
        resolve(deletedItem)
      }).on('error', function(err) {
        console.error("ERROR in "+that.options.modelName+".deleteItem(id="+id+"):", err)
        reject(err)
      })
    })
  }
}
