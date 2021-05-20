import { ReadPreference } from '../read_preference';
import { maxWireVersion, decorateWithCollation, hasAtomicOperators, Callback } from '../utils';
import { MongoDriverError } from '../error';
import { CommandOperation, CommandOperationOptions } from './command';
import { defineAspects, Aspect } from './operation';
import type { Document } from '../bson';
import type { Server } from '../sdam/server';
import type { Collection } from '../collection';
import { Sort, SortForCmd, formatSort } from '../sort';
import type { ClientSession } from '../sessions';
import type { WriteConcern, WriteConcernSettings } from '../write_concern';

/** @public */
export const ReturnDocument = Object.freeze({
  BEFORE: 'before',
  AFTER: 'after'
} as const);

/** @public */
export type ReturnDocument = typeof ReturnDocument[keyof typeof ReturnDocument];

/** @public */
export interface FindOneAndDeleteOptions extends CommandOperationOptions {
  /** An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.*/
  hint?: Document;
  /** Limits the fields to return for all matching documents. */
  projection?: Document;
  /** Determines which document the operation modifies if the query selects multiple documents. */
  sort?: Sort;
}

/** @public */
export interface FindOneAndReplaceOptions extends CommandOperationOptions {
  /** Allow driver to bypass schema validation in MongoDB 3.2 or higher. */
  bypassDocumentValidation?: boolean;
  /** An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.*/
  hint?: Document;
  /** Limits the fields to return for all matching documents. */
  projection?: Document;
  /** When set to 'after', returns the updated document rather than the original. The default is 'before'.  */
  returnDocument?: ReturnDocument;
  /** Determines which document the operation modifies if the query selects multiple documents. */
  sort?: Sort;
  /** Upsert the document if it does not exist. */
  upsert?: boolean;
}

/** @public */
export interface FindOneAndUpdateOptions extends CommandOperationOptions {
  /** Optional list of array filters referenced in filtered positional operators */
  arrayFilters?: Document[];
  /** Allow driver to bypass schema validation in MongoDB 3.2 or higher. */
  bypassDocumentValidation?: boolean;
  /** An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.*/
  hint?: Document;
  /** Limits the fields to return for all matching documents. */
  projection?: Document;
  /** When set to 'after', returns the updated document rather than the original. The default is 'before'.  */
  returnDocument?: ReturnDocument;
  /** Determines which document the operation modifies if the query selects multiple documents. */
  sort?: Sort;
  /** Upsert the document if it does not exist. */
  upsert?: boolean;
}

/** @internal */
interface FindAndModifyCmdBase {
  remove: boolean;
  new: boolean;
  upsert: boolean;
  update?: Document;
  sort?: SortForCmd;
  fields?: Document;
  bypassDocumentValidation?: boolean;
  arrayFilters?: Document[];
  maxTimeMS?: number;
  writeConcern?: WriteConcern | WriteConcernSettings;
}

function configureFindAndModifyCmdBaseUpdateOpts(
  cmdBase: FindAndModifyCmdBase,
  options: FindOneAndReplaceOptions | FindOneAndUpdateOptions
): FindAndModifyCmdBase {
  cmdBase.new = options.returnDocument === ReturnDocument.AFTER;
  cmdBase.upsert = options.upsert === true;

  if (options.bypassDocumentValidation === true) {
    cmdBase.bypassDocumentValidation = options.bypassDocumentValidation;
  }
  return cmdBase;
}

/** @internal */
class FindAndModifyOperation extends CommandOperation<Document> {
  options: FindOneAndReplaceOptions | FindOneAndUpdateOptions | FindOneAndDeleteOptions;
  cmdBase: FindAndModifyCmdBase;
  collection: Collection;
  query: Document;
  doc?: Document;

  constructor(
    collection: Collection,
    query: Document,
    options: FindOneAndReplaceOptions | FindOneAndUpdateOptions | FindOneAndDeleteOptions
  ) {
    super(collection, options);
    this.options = options ?? {};
    this.cmdBase = {
      remove: false,
      new: false,
      upsert: false
    };

    const sort = formatSort(options.sort);
    if (sort) {
      this.cmdBase.sort = sort;
    }

    if (options.projection) {
      this.cmdBase.fields = options.projection;
    }

    if (options.maxTimeMS) {
      this.cmdBase.maxTimeMS = options.maxTimeMS;
    }

    // Decorate the findAndModify command with the write Concern
    if (options.writeConcern) {
      this.cmdBase.writeConcern = options.writeConcern;
    }

    // force primary read preference
    this.readPreference = ReadPreference.primary;

    this.collection = collection;
    this.query = query;
  }

  execute(server: Server, session: ClientSession, callback: Callback<Document>): void {
    const coll = this.collection;
    const query = this.query;
    const options = { ...this.options, ...this.bsonOptions };

    // Create findAndModify command object
    const cmd: Document = {
      findAndModify: coll.collectionName,
      query: query,
      ...this.cmdBase
    };

    // Have we specified collation
    try {
      decorateWithCollation(cmd, coll, options);
    } catch (err) {
      return callback(err);
    }

    if (options.hint) {
      // TODO: once this method becomes a CommandOperation we will have the server
      // in place to check.
      const unacknowledgedWrite = this.writeConcern?.w === 0;
      if (unacknowledgedWrite || maxWireVersion(server) < 8) {
        callback(
          new MongoDriverError(
            'The current topology does not support a hint on findAndModify commands'
          )
        );

        return;
      }

      cmd.hint = options.hint;
    }

    if (this.explain && maxWireVersion(server) < 4) {
      callback(
        new MongoDriverError(`server ${server.name} does not support explain on findAndModify`)
      );
      return;
    }

    // Execute the command
    super.executeCommand(server, session, cmd, (err, result) => {
      if (err) return callback(err);
      return callback(undefined, result);
    });
  }
}

/** @internal */
export class FindOneAndDeleteOperation extends FindAndModifyOperation {
  constructor(collection: Collection, filter: Document, options: FindOneAndDeleteOptions) {
    // Basic validation
    if (filter == null || typeof filter !== 'object') {
      throw new MongoDriverError('Filter parameter must be an object');
    }

    super(collection, filter, options);
    this.cmdBase.remove = true;
  }
}

/** @internal */
export class FindOneAndReplaceOperation extends FindAndModifyOperation {
  constructor(
    collection: Collection,
    filter: Document,
    replacement: Document,
    options: FindOneAndReplaceOptions
  ) {
    if (filter == null || typeof filter !== 'object') {
      throw new MongoDriverError('Filter parameter must be an object');
    }

    if (replacement == null || typeof replacement !== 'object') {
      throw new MongoDriverError('Replacement parameter must be an object');
    }

    if (hasAtomicOperators(replacement)) {
      throw new MongoDriverError('Replacement document must not contain atomic operators');
    }

    super(collection, filter, options);
    this.cmdBase.update = replacement;
    configureFindAndModifyCmdBaseUpdateOpts(this.cmdBase, options);
  }
}

/** @internal */
export class FindOneAndUpdateOperation extends FindAndModifyOperation {
  constructor(
    collection: Collection,
    filter: Document,
    update: Document,
    options: FindOneAndUpdateOptions
  ) {
    if (filter == null || typeof filter !== 'object') {
      throw new MongoDriverError('Filter parameter must be an object');
    }

    if (update == null || typeof update !== 'object') {
      throw new MongoDriverError('Update parameter must be an object');
    }

    if (!hasAtomicOperators(update)) {
      throw new MongoDriverError('Update document requires atomic operators');
    }

    super(collection, filter, options);
    this.cmdBase.update = update;
    configureFindAndModifyCmdBaseUpdateOpts(this.cmdBase, options);

    if (options.arrayFilters) {
      this.cmdBase.arrayFilters = options.arrayFilters;
    }
  }
}

defineAspects(FindAndModifyOperation, [
  Aspect.WRITE_OPERATION,
  Aspect.RETRYABLE,
  Aspect.EXPLAINABLE
]);
