'use strict';

// ----------------------------------------------------------------------------
// Requirements
// ----------------------------------------------------------------------------

var _ = require('underscore')
  , async = require('async')
  , BoxError = require('./box_error')
  , Validator = require('validator').Validator;


// ----------------------------------------------------------------------------
// Public Functions
// ----------------------------------------------------------------------------

/**
  General Note:
  When using these public functions through a model instance (sqlbox.create)
  you do not specify the first "box" param. The model will auto-fill that in.

  Example:

    var Person = sqlbox.create({
      tableName: 'people'
    });

    Person.get(1, function (err, person) {
      // ...
    });

  This allows you to .bind, .call, or .apply without worrying about `this`
  being messed with.

  You can also interact directly with these methods if you need to:

    // This is the same as above
    box.get(People, 1, function (err, person) {
      // ...
    });
**/


/**
 * Builds a obj that conforms to the column spec defined in the model. Removes
 * all excess properties.
 *
 * @param box Object The model that defines the column spec
 * @param obj Object The data to transform
 * @param callback Function(err Error, obj Object)
 * @returns null
 */
function build(box, obj, callback) {
  var instance = pruneToColumns(box, obj);
  
  // Define a non-enumerable $meta property on the instance. This is used
  // for book keeping and extra properties that should be passed around with
  // the data.
  Object.defineProperty(instance, '$meta', {
    value: {},
    enumerable: false
  });
  
  // Save a clone of the data in its meta. This allows comparing changed objects
  // to what they originally where.
  instance.$meta.original = pruneToColumns(box, instance);
  
  runHooks(box, instance, ['afterFetch'], function (err) {
    if (err) {
      return callback(err);
    }
    callback(null, instance);
  });
}


/**
 * Get a single row from a table by its id. Callback is optional. When it is
 * not specified a partially applied `get` function will be returned.
 *
 * Example of partial application:
 *
 *   var getOne = People.get(1);
 *   getOne(function (err, person) { ... });
 *
 * This is super useful when used with something like the async library.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance
 * @param idOrQuery Number|Object The id of the row to fetch or a query
 *        object
 * @param [opts] Object
 * @param [callback] Function(err Error, row Object)
 * 
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `get` is returned.
 */
function get(box, idOrQuery, opts, callback) {
  // Shift around the arguments to allow optional opts
  if (arguments.length === 2) {
    opts = {};
  } else if (arguments.length === 3 && typeof arguments[2] === 'function') {
    callback = arguments[2];
    opts = {};
  }

  // If there is no callback, return a partially applied function
  if (!callback) {
    return _.partial(get, box, idOrQuery, opts);
  }

  var query;
  if (typeof idOrQuery === 'object') {
    query = idOrQuery;
  } else {
    query = {id: Number(idOrQuery)};
  }

  opts.limit = 1;
  opts.skip = 0;

  box.first(query, opts, function get_(err, object) {
    if (err) {
      return callback(err);
    }

    if (!object) {
      return callback(new BoxError(404, 'Row with id ' + idOrQuery + ' was not found in ' + box.name));
    }

    callback(null, object);
  });

  // // TODO: look into providing a dev mode that captures the stack that called
  // //       into the box methods. This works, though maybe domains are better.
  // // var stackCapture = BoxError.stackCapture();
}


/**
 * Get multiple rows from a table by their ids. Uses the sql IN operator. Like
 * `get`, this also returns a partially applied function of itself if the
 * callback is not specified.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance
 * @param ids Array The ids of the rows to fetch
 * @param [opts] Object
 * @param [callback] Function(err Error, rows Array)
 * 
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `get` is returned.
 */
function mget(box, ids, opts, callback) {
  // Shift around the arguments to allow optional opts
  if (arguments.length === 2) {
    opts = {};
  } else if (arguments.length === 3 && typeof arguments[2] === 'function') {
    callback = arguments[2];
    opts = {};
  }

  // If there is no callback, return a partially applied function
  if (!callback) {
    return _.partial(mget, box, ids, opts);
  }

  box.all({id: {in: _.map(ids, Number)}}, callback);
}


/**
 * Saves a new or updated row into the database based on the box information.
 * Like `get`, this also returns a partially applied function of itself if the
 * callback is not specified.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance 
 * @param obj Object The data to save or update to the database
 * @param [where] Object A where clause the update must match against
 * @param [callback] Function(err Error, savedRow Object)
 *
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `save` is returned.
 */
function save(box, obj, where, mainCallback) {
  // Shift around the arguments to allow optional where
  if (arguments.length === 2) {
    where = {};
  } else if (arguments.length === 3 && typeof arguments[2] === 'function') {
    mainCallback = arguments[2];
    where = {};
  }

  if (!mainCallback) {
    return _.partial(save, box, obj, where);
  }

  // Clone the object so any destruction done within save is not relayed back
  // to the original obj. This is super useful when mutating the object in a
  // hook, but then the save fails. You expect to still have the same object.
  var clone = cloneObject(obj);

  // Make sure the clone has the $meta feild of obj
  if ('$meta' in obj) {
    Object.defineProperty(clone, '$meta', {
      value: obj.$meta,
      enumerable: false
    });
  }

  // Perform the transaction and the save/update sequence
  async.series({
    beginTxn: _.bind(box.client.query, box.client, 'BEGIN'),
    beforeValidation: _.partial(runHook, box, clone, 'beforeValidation'),
    validation: _.partial(validate, box, clone),
    afterValidation: _.partial(runHook, box, clone, 'afterValidation'),

    hasChanges: function (callback) {
      if (box.hasChanges(clone)) {
        return callback();
      } else {
        return callback(new BoxError(304));
      }
    },

    beforeSave: _.partial(runHook, box, clone, 'beforeSave'),
    saved: function (callback) {
      // If the obj has an id, we assume it is not new, this might be a good
      // place to utilize $meta.
      if (clone.id) {
        saveUpdate(box, clone, where, callback);
      } else {
        saveNew(box, clone, callback);
      }
    },
    commitTxn: _.bind(box.client.query, box.client, 'COMMIT')
  }, function (err, results) {
    // If there is an error, we need to roll the transaction back
    if (err) {
      box.client.query('ROLLBACK');
    }

    // If the error is 304, we just return the unchanged clone
    if (err && err.code === 304) {
      return mainCallback(null, clone);
    }

    // Postgres error 23505 is a unique index conflict, so we transform that
    // to a 409 conflict error
    if (err && err.code == '23505') {
      var error = new BoxError(409, 'Duplicate key violates unique constraint.');

      var parsedDetail = err.detail.match(/\(([^)]+)\)=\(([^)]+)\)/);

      if (parsedDetail) {
        error.conflicts = [{
          key: parsedDetail[0],
          value: parsedDetail[1],
          expected: 'unique'
        }];
      }

      return mainCallback(error);
    }

    // Pass back any other error
    if (err) {
      return mainCallback(err);
    }

    // Hopefully nothing was wrong, in that case we pass back the result
    mainCallback(null, results.saved);
  });
}


/**
 * Remove a row from the database.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance 
 * @param id Number The id of the row to remove
 * @param [callback] Function(err Error, success Boolean)
 *
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `remove` is returned.
 */
function remove(box, id, callback) {
  if (!callback) {
    return _.partial(remove, box, id);
  }

  var t = box.table;

  // DELETE FROM table WHERE table.id = $id;
  var query = t.delete().where(
        t.id.equals(Number(id))
      );

  if (box.logQueries) {
    console.log(query.toString());
  }

  box.client.query(query.toQuery(), function remove_(err, result) {
    if (err) {
      return callback(err);
    }

    if (result.rowCount) {
      callback(null, true);
    } else {
      callback(new BoxError(404, 'Row with id ' + id + ' was not found in ' + box.name));
    }
  });
}


/**
 * Modify is a higher level function that helps with the get/save loop. It
 * manages retrying saves if another actor updates the row being modified,
 * handles rules around what a valid object to update looks like (ensures),
 * and in general is a simpler, less nested way to mutate a row.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance 
 * @param id Number The id of the row to modify
 * @param where Object The where clause to match against, if this fails a
 *        409 is passed back
 * @param mutator Function(obj Object) A function that takes the fetched
 *        database row and is responsible for changing it. This function
 *        may be ran multiple times on save conflicts, so should not have any
 *        side effects
 * @param [callback] Function(err Error, obj Object) The function that will be
 *        called after a successful update or after too many retries. The obj
 *        will reflect the new row in teh database
 *
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `modify` is returned.
 */
function modify(box, id, where, mutator, callback) {
  if (!callback) {
    return _.partial(modify, box, id, where, mutator);
  }

  // If they pass in a record, get its id
  if (_.isObject(id)) {
    id = id.id;
  }

  box.get(id, function modifyGet_(err, obj) {
    if (err) {
      return callback(err);
    }

    mutator(obj);

    box.save(obj, where, function modifySave_(err, savedObject) {
      // Other errors are passed back in tact
      if (err) {
        return callback(err);
      }

      callback(null, savedObject);
    });
  });
}


/**
 * Find the first row that matchs the properties of the query. If nothing is
 * found with the query, a 404 error is returned.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance 
 * @param properties Object The values to match against
 * @param [opts] Object
 * @param [opts.offset] Number Number of rows to skip before returning one
 * @param [opts.order] Function(table Object) Function to allow custom sorting
 *        before returning the first
 * @param [callback] Function(err Error, row Object)
 * 
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `first` is returned.
 */
function first(box, properties, opts, callback) {
  // Shift around the arguments to allow alternate forms
  if (arguments.length === 2) {
    opts = {};
  } else if (arguments.length === 3 && typeof arguments[2] === 'function') {
    callback = arguments[2];
    opts = {};
  }

  // If there is no callback, return a partially applied function
  if (!callback) {
    return _.partial(first, box, properties, opts);
  }

  opts.limit = 1;

  all(box, properties, opts, function first_(err, objects) {
    if (err) {
      return callback(err);
    }

    if (objects.length) {
      callback(null, objects[0]);
    } else {
      callback(null, undefined);
    }
  });
}


/**
 * Find all the rows that matchs the properties of the query.
 *
 * @param box Object The model instance. This parameter is not specified when
 *        using the method through a model instance 
 * @param properties Object The values to match against
 * @param [opts] Object
 * @param [opts.limit] Number Maximum number of rows to return
 * @param [opts.offset] Number Number of rows to skip before returning one
 * @param [opts.order] Function(table Object) Function to allow custom sorting
 *        before returning the first
 * @param [callback] Function(err Error, rows Array)
 * 
 * @returns null|Function null if a callback was specified else a partially
 *          applied version of `first` is returned.
 */
function all(box, properties, opts, callback) {
  // Shift around the arguments to allow alternate forms
  if (arguments.length === 2) {
    opts = {};
  } else if (arguments.length === 3 && typeof arguments[2] === 'function') {
    callback = arguments[2];
    opts = {};
  }

  // If there is no callback, return a partially applied function
  if (!callback) {
    return _.partial(all, box, properties, opts);
  }

  var t = box.table;
  var query = t.select(t.star());

  query = whereClause(box, query, properties);

  // Depending on the options supplied we need to add additional modifiers
  if (opts.limit) {
    query.limit(opts.limit);
  }

  if (opts.offset) {
    query.offset(opts.offset);
  }

  if (typeof opts.order === 'function') {
    query.order(opts.order(box.table));
  }

  if (box.logQueries) {
    var startTime = Date.now();
  }

  box.client.query(query.toQuery(), function all_(err, result) {
    if (box.logQueries) {
      console.log('[%dms] %s', Date.now() - startTime, query.toString());
    }

    if (err) {
      return callback(err);
    }

    async.map(result.rows, box.build, function (err, results) {
      if (err) {
        return callback (err);
      }

      return callback(null, results);
    });
  });
}


function query(box, queryFn, callback) {
  var t = box.table;
  var sqlQuery = queryFn(t);

  if (box.logQueries) {
    var startTime = Date.now();
  }

  box.client.query(sqlQuery.toQuery(), function query_(err, result) {
    if (box.logQueries) {
      console.log('[%dms] %s', Date.now() - startTime, sqlQuery.toString());
    }

    if (err) {
      return callback(err);
    }

    async.map(result.rows, box.build, function (err, results) {
      if (err) {
        return callback (err);
      }

      return callback(null, results);
    });
  });
}

function hasChanges(box, obj) {
  if ('$meta' in obj === false) {
    return true;
  }

  return _.some(box.columns, function (column) {
    return !_.isEqual(obj[column.name], obj.$meta.original[column.name]);
  });
}

// ----------------------------------------------------------------------------
// Private Functions
// ----------------------------------------------------------------------------

/**
 * Inserts a new row into the database.
 *
 * @param box Object The model instance used to get table information
 * @param obj Object The row to insert into the database
 * @param callback Function(err Error, insertedRow Object)
 */
function saveNew(box, obj, callback) {
  obj = columnsToSource(box, obj);

  var t = box.table;

  // INSERT INTO table (...) VALUES (...);
  var query = t.insert(obj).returning(t.star());

  if (box.logQueries) {
    var startTime = Date.now();
  }

  box.client.query(query.toQuery(), function saveNew_(err, result) {
    if (box.logQueries) {
      console.log('[%dms] %s', Date.now() - startTime, query.toString());
    }

    if (err) {
      return callback(err);
    }

    if (result.rows.length) {
      build(box, result.rows[0], function (err, record) {
        if (err) {
          return callback(err);
        }

        runHooks(box, record, ['afterCreate', 'afterSave'], function (err) {
          if (err) {
            return callback(err);
          }
          callback(null, record);
        });

      });
    } else {
      callback(new BoxError(500, 'Postgres returned no error, but no row was returned.'));
    }
  });
}


/**
 * Updates a row in the database.
 *
 * A where clause can be passed in to ensure that if concurrent updates are
 * happening that the record is still as expected before applying the update.
 * If the where clause does not match, a 409 is returned.
 *
 * @param box Object The model instance used to get the table information
 * @param obj Object The updated row data
 * @param where Object The where clause the update must match
 * @param callback Function(err Error, updatedRow Object)
 */
function saveUpdate(box, obj, where, callback) {
  where = where || {}
  where.id = obj.id;

  // Clear out date fields that sqlbox manages
  delete obj.id;
  delete obj.createdAt;
  delete obj.updatedAt;

  var changeSet;

  if (obj.$meta && obj.$meta.original) {
    changeSet = changes(obj, obj.$meta.original);
  } else {
    changeSet = obj;
  }

  var sourceObject = columnsToSource(box, changeSet);

  var t = box.table;

  // UPDATE table SET (...)
  //   WHERE table.id = $id AND ...
  //   RETURNING table.*;
  var query = t.update(sourceObject);
  query = whereClause(box, query, where);
  query = query.returning(t.star()).toQuery();

  // node-sql does not support functions like now() so we have
  // to hack it in there with string manipulation for now. Will work something
  // into node-sql time permitting.
  if (_.size(sourceObject) === 0) {
    query.text = query.text.replace(' WHERE', '"updated_at" = now() WHERE');
  } else {
    query.text = query.text.replace(' WHERE', ', "updated_at" = now() WHERE');
  }
  
  if (box.logQueries) {
    var startTime = Date.now();
  }

  box.client.query(query, function saveUpdate_(err, result) {
    if (box.logQueries) {
      console.log('[%dms] %s', Date.now() - startTime, query.text);
    }

    if (err) {
      return callback(err);
    }

    if (result.rows.length) {
      build(box, result.rows[0], function (err, record) {
        if (err) {
          return callback(err);
        }

        runHooks(box, record, ['afterUpdate', 'afterSave'], function (err) {
          if (err) {
            return callback(err);
          }
          callback(null, record);
        });
        
      });
    } else {
      var msg =
        ('Row with id ' + where.id + ' was not found in ' + box.name + ', ' +
         'or the where clause did not pass.');
      callback(new BoxError(409, msg));
    }
  });
}

/**
 * Creates a new object that replaces the name keys of obj with the source keys
 * defined in the box.columns spec. This is used to convert the runtime data
 * with friendly names to the actual database column names.
 *
 * @param box Object The model instance that defines the column spec
 * @param obj Object The table row data with database column names
 * @returns Object The data with keys replaced by their database source
 *          column names
 */
function columnsToSource(box, obj) {
  var newObject = {};

  _.each(box.columns, function (column) {
    if (column.name in obj) {
      newObject[column.source] = obj[column.name];
    }
  });

  return newObject;
}

/**
 * Runs the validations on an object.
 *
 * @param box Object The model instance that defines the validations
 * @param obj Object The object to validate against the model
 * @param callback Function(error Error, bool isValid) If isValid is
 *        false, error will exist, else it will be null. The error contains
 *        .validationErrors which is an array of various issues found.
 */
function validate(box, obj, callback) {
  var v = new Validator();
  var errors = [];

  v.error = function (msg) {
    if (v.currentKey) {
      var error = _.findWhere(errors, {key: v.currentKey});

      if (error) {
        error.failed.push(v.currentKeyValidation);
      } else {
        errors.push({
          key: v.currentKey,
          value: v.currentValue,
          expected: v.currentKeyValidations,
          failed: [v.currentKeyValidation]
        });
      }
    } else {
      errors.push({message: msg});
    }
  };

  _.each(box.validations, function (validations, key) {
    var value = obj[key];
    v.currentKey = key;
    v.currentValue = value;
    v.currentKeyValidations = validations;

    // Validation form: ['exists', ['len', 1, 10], customFn]
    _.each(validations, function (validation) {
      v.currentKeyValidation = validation;

      if (_.isString(validation)) {
        // Form: 'exists'
        v.check(value)[validation]();
      } else if (_.isArray(validation)) {
        // Form: ['len', 1, 10]
        var check = v.check(value);
        check[validation[0]].apply(check, validation.slice(1));
      } else if (_.isFunction(validation)) {
        // Form: function (obj, key, v) {}
        validation(obj, key, v);
      }
    });
  });

  delete v.currentKey;
  delete v.currentValue;
  delete v.currentKeyValidations;
  delete v.currentKeyValidation;

  box.validate(obj, v);

  if (errors.length) {
    var err = new BoxError(403, 'Validation did not pass.');
    err.validationErrors = errors;
    callback(err, false);
  } else {
    callback(null, true);
  }
}

/**
 * Runs a single hook that is defined on a model. Threads obj through each
 * of the hooks functions in sequence.
 *
 * @param box Object The model
 * @param obj Object The record triggering the hook
 * @param hookName String The name of the hook to perform
 * @param callback Function(err Error)
 */
function runHook(box, obj, hookName, callback) {
  var hook = box.hooks[hookName];

  if (_.isFunction(hook)) {
    hook(obj, callback);
  } else if (_.isArray(hook)) {
    var fns = _.map(_.filter(hook, _.isFunction), function (fn) {
      return _.partial(fn, obj);
    });

    async.series(fns, callback);
  } else {
    // No hook
    callback();
  }
}

/**
 * Runs the given hooks that are defined on a model. Threads obj through each
 * hook in sequence.
 *
 * @param box Object The model
 * @param obj Object The record triggering the hooks
 * @param hookNames Array An array of the names of the hooks to perform
 * @param callback Function(err Error)
 */
function runHooks(box, obj, hookNames, callback) {
  var fns = _.map(hookNames, function (hookName) {
    return _.partial(runHook, box, obj, hookName);
  });

  async.series(fns, callback);
}

/**
 * Determines the differences between 2 objects. The value that is returned
 * in the diff object is always from the first object.
 *
 * @param o1 Object The first object to compare
 * @param o2 Object The secont object to compare
 * @returns Object The differences
 */
function changes(o1, o2) {
  var changeSet = {};

  _.each(o1, function (value, key) {
    var value2 = o2[key];

    if (!_.isEqual(value, value2)) {
      changeSet[key] = value;
    }
  });

  return changeSet;
}

/**
 * Clones an object. For the most part this is a shallow clone, except it will
 * clone depth 1 arrays as well (shallow cloning them).
 *
 * @param obj Object The object to clone
 * @returns Object The clone
 */
function cloneObject(obj) {
  var clonedObj = {};

  _.each(obj, function (value, key) {
    if (_.isArray(value)) {
      clonedObj[key] = value.slice(0);
    } else {
      clonedObj[key] = value;
    }
  });

  return clonedObj;
}

/**
 * Creates a new copy of an object that removes all non columns as defined in
 * the model.
 *
 * @param box Object The model
 * @param obj Object The object to prune
 * @returns Object The newly created pruned object
 */
function pruneToColumns(box, obj) {
  var instance = {};

  _.each(box.columns, function (column) {
    var value;

    if (column.name in obj) {
      value = obj[column.name];
    } else if (column.source in obj) {
      value = obj[column.source];
    } else {
      // Column defined in the model could not be found in the databse row, so
      // we skip to the next column.
      return;
    }

    if (_.isArray(value)) {
      instance[column.name] = value.slice(0);
    } else {
      instance[column.name] = value;
    }
  });

  return instance;
}

/**
 * Creates the where clause on a node-sql query based on the where spec passed
 * in.
 *
 * @param box Object The model to query againts
 * @param query Object The current sql-box query to mutate
 * @param whereProperties Object The conditions to add to the query
 * @returns Object The mutated query (for chaining)
 */
function whereClause(box, query, whereProperties) {
  var t = box.table;

  // Iterate through the provided properties and build out the WHERE clause
  _.each(whereProperties, function (value, indexName) {
    var columnSpec = _.find(box.columns, function (column) {
      if (indexName === column.name) {
        return true;
      }
    });

    if (columnSpec) {
      if (_.isObject(value)) {
        _.each(value, function (innerValue, operator) {
          // Rename short form operators to their node-sql counterparts
          if (operator === 'not') {
            operator = 'notEquals';
          }
          if (operator === 'eq' || operator === 'is' || operator === 'eql') {
            operator = 'equals';
          }

          // We need to do a dance to get NULL to work as expected
          if (innerValue === null) {
            if (operator === 'notEquals') {
              query.where(t[columnSpec.source].isNotNull());
            } else if (operator === 'equals') {
              query.where(t[columnSpec.source].isNull());
            }
          } else {
            query.where(t[columnSpec.source][operator](innerValue));
          }
        });
      } else {
        query.where(t[columnSpec.source].equals(value));
      }
    }
  });

  return query;
}

// ----------------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------------

exports.build = build;
exports.get = get;
exports.mget = mget;
exports.save = save;
exports.remove = remove;
exports.modify = modify;
exports.first = first;
exports.all = all;
exports.query = query;
exports.hasChanges = hasChanges;
