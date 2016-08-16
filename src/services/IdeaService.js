/**
 * IdeaService handles all CRUD and search operations for "ideas"
 * 
 * This singleton facade is a Javascript abstraction for the interface to the DB.
 */
"use strict"
 
var BaseRestClient = require ('./BaseRestClient')

/** Schema for validating an idea. (see jsonschema.org) */
var ideaSchmea = {
  id: "/Idea",
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    createdBy: {
      type: "object", 
      properties: {
        $oid : { type: "string", format: "ObjectID", required: true }
      }
    },
    //TODO: views: { type: "number" },
    // validation for createdAt and updatedAt timestamps will automatically be added in BaseRestClient
  },
  required: [ "title", "description", "createdBy" ]
}

var options = {
  modelName: 'Idea',
  url: 'https://api.mlab.com/api/1/databases/liquido-test/collections/ideas/${id}',
  urlParams: { apiKey: '1crkrQWik4p98uPiOzZiFG0Fkya0iNiU' },
  nameOfIdAttr: '_id',
  timestamps: true,
  jsonSchema: ideaSchmea
}

class IdeaService extends BaseRestClient {
  // empty. All in BaseRestClient
}

// export singleton instance, see http://stackoverflow.com/a/10128393/6113110
// We only want one ideaService with one application wide cache for ideas!
module.exports = IdeaService.getInstance(options)