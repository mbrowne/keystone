import { KeystoneContext } from '../../../../types';
import { InitialisedField, InitialisedList } from '../../types-for-lists';
import { isRejected, isFulfilled, IdType, customOperationWithPrisma } from '../../utils';
import { userInputError } from '../../graphql-errors';
import { NestedMutationState } from '../create-update';
import { requirePrisma } from '../../../../artifacts';
import {
  CreateOneValueType,
  UpdateOneValueType,
  CreateManyValueType,
  UpdateManyValueType,
  InitialisedPolymorphicRelationshipField,
} from './types';
import { getResolvedUniqueWheres, handleCreateAndUpdate } from './utils';
import { ResolvedPolymorphicRelationDBField } from '../../resolve-relationships';
import { resolveUniqueWhereInput, UniqueInputFilter } from '../../where-inputs';

const Prisma = requirePrisma(process.cwd());

function getTarget(
  listKey: string,
  fieldKey: string,
  field: InitialisedPolymorphicRelationshipField
) {
  // note: it might make more sense to use the interface name instead of joinModelName;
  // we might change this later
  return `${listKey}.${fieldKey}<${field.dbField.joinModelName}>`;
}

export function resolveRelateToOneForCreateInput(
  nestedMutationState: NestedMutationState,
  context: KeystoneContext,
  fieldKey: string,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
) {
  // TODO
  //   return async (value: CreateOneValueType) => {
  //     const numOfKeys = Object.keys(value).length;
  //     if (numOfKeys !== 1) {
  //       throw userInputError(
  //         `Nested to-one mutations must provide exactly one field if they're provided but ${target} did not`
  //       );
  //     }
  //     return handleCreateAndUpdate(value, nestedMutationState, context, foreignList, target);
  //   };
}

export function resolveRelateToOneForUpdateInput(
  nestedMutationState: NestedMutationState,
  context: KeystoneContext,
  fieldKey: string,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
) {
  // TODO
  //   return async (value: UpdateOneValueType) => {
  //     if (Object.keys(value).length !== 1) {
  //       throw userInputError(
  //         `Nested to-one mutations must provide exactly one field if they're provided but ${target} did not`
  //       );
  //     }
  //     if (value.connect || value.create) {
  //       return handleCreateAndUpdate(value, nestedMutationState, context, foreignList, target);
  //     } else if (value.disconnect) {
  //       return { disconnect: true };
  //     }
  //   };
}

export function resolveRelateToManyForCreateInput(
  nestedMutationState: NestedMutationState,
  context: KeystoneContext,
  fieldKey: string,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
) {
  return async (value: CreateManyValueType) => {
    if (!Array.isArray(value.connect) && !Array.isArray(value.create)) {
      throw userInputError(
        `You must provide at least one field in to-many relationship inputs but none were provided at ${target}`
      );
    }

    // Perform queries for the connections
    const connects = Promise.allSettled(
      getResolvedUniqueWheres(value.connect || [], context, foreignList)
    );

    // Perform nested mutations for the creations
    const creates = Promise.allSettled(
      (value.create || []).map(x => nestedMutationState.create(x, foreignList))
    );

    const [connectResult, createResult] = await Promise.all([connects, creates]);

    // Collect all the errors
    const errors = [...connectResult.filter(isRejected), ...createResult.filter(isRejected)].map(
      x => x.reason
    );
    if (errors.length) {
      throw new Error(`Unable to create and/or connect ${errors.length} ${target}`);
    }

    const result = {
      connect: [...connectResult, ...createResult].filter(isFulfilled).map(x => x.value),
    };

    // Perform queries for the connections
    return result;
  };
}

// for now, assume table name matches list name
// (TODO find out if there's a way to get the table name from the prisma client)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getTableName(listKey: string, context: KeystoneContext) {
  return listKey;
}

function betterPrismaSql(literals: readonly string[], ...args: any[]) {
  // const parsedArgs = args
  //   .map(arg => {
  //     if (typeof arg === 'object') {
  //       return false;
  //     }
  //     return arg;
  //   })
  //   .filter(Boolean);

  const parsedLiterals: string[] = [];
  const parsedArgs: any[] = [];

  let skipNextLiteral = false;
  literals.forEach((literal, i) => {
    const arg = args[i];
    if (typeof arg === 'object' && arg.__isBetterPrismaSql) {
      const nestedTemplateArgs = arg.__templateArgs;
      const [firstNestedLiteral, ...remainingNestedLiterals] = nestedTemplateArgs.literals;
      parsedLiterals.push(literal + firstNestedLiteral);
      if (remainingNestedLiterals.length) {
        remainingNestedLiterals.forEach((nestedLiteral: string, j: number) => {
          parsedLiterals.push(nestedLiteral);
          // TODO deeper nesting
          parsedArgs.push(nestedTemplateArgs.args[j]);
        });
      }
      skipNextLiteral = true;
    } else {
      if (!skipNextLiteral) {
        parsedLiterals.push(literal);
      } else {
        skipNextLiteral = false;
      }
      if (arg) {
        parsedArgs.push(arg);
      }
    }
  });

  console.log('parsedLiterals, parsedArgs', parsedLiterals, parsedArgs);

  return {
    ...Prisma.sql(parsedLiterals, ...parsedArgs),
    __isBetterPrismaSql: true,
    __templateArgs: { literals, args },
  };
}

const name = 'HeroComponent';
const r = betterPrismaSql`SELECT id FROM ${betterPrismaSql`${name}`}`;
console.log('r: ', r);

type ConnectOrDisconnectItem = {
  id: string;
  type: string;
};

async function getRelatedItemsById(
  ids: string[],
  context: KeystoneContext,
  field: InitialisedPolymorphicRelationshipField
  // list: InitialisedList
): Promise<ConnectOrDisconnectItem[]> {
  const foreignTableNames = Object.values(field.dbField.fields).map(foreignField =>
    getTableName(foreignField.list, context)
  );

  const sql = betterPrismaSql;
  const unionQuery = sql`${foreignTableNames
    .map(tableName => sql`SELECT id, '${tableName}' as type FROM ${tableName}`)
    .join(' UNION ')}`;

  // const q = Prisma.sql(
  //   [
  //     foreignTableNames.map(name => `SELECT id FROM ${name}`).join(' UNION ') + ' WHERE id IN (',
  //     ')',
  //   ],
  //   ids.join(',')
  // );
  // console.log('q: ', q);

  const q = sql`${unionQuery} WHERE id IN (${ids.join(',')})`;

  console.log('q: ', q);

  const results = await customOperationWithPrisma(
    context,
    prisma => prisma.$queryRaw(q)
    // prisma.$queryRaw`${unionQuery}
    //   WHERE id IN (${ids.join(',')})`
  );

  console.log('results', results);
}

async function getItemsToConnectOrDisconnect(
  uniqueInputs: UniqueInputFilter[],
  context: KeystoneContext,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
): Promise<ConnectOrDisconnectItem[]> {
  // Validate input filter
  const ids = uniqueInputs.map(uniqueInput => {
    const { id, _type, ...otherFilters } = uniqueInput;
    if (!id || Object.keys(otherFilters).length) {
      throw Error('Only ID filters are currently supported for polymorphic relationships');
    }
    return id;
  });

  // Check whether the items exist
  const verifiedItems = await getRelatedItemsById(ids, context, field);

  // if (item === null) {
  //   throw new Error('Unable to find item to connect to.');
  // }

  return verifiedItems;
}

export function resolveRelateToManyForUpdateInput(
  nestedMutationState: NestedMutationState,
  context: KeystoneContext,
  fieldKey: string,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
) {
  const target = getTarget(list.listKey, fieldKey, field);

  return async (value: UpdateManyValueType) => {
    if (
      !Array.isArray(value.connect) &&
      !Array.isArray(value.create) &&
      !Array.isArray(value.disconnect) &&
      !Array.isArray(value.set)
    ) {
      throw userInputError(
        `You must provide at least one field in to-many relationship inputs but none were provided at ${target}`
      );
    }
    if (value.set && value.disconnect) {
      throw userInputError(
        `The set and disconnect fields cannot both be provided to to-many relationship inputs but both were provided at ${target}`
      );
    }

    //temp
    const connects = Promise.resolve(value.connect);

    // // Perform queries for the connections
    // const connects = getItemsToConnectOrDisconnect(
    //   value.connect || [],
    //   context,
    //   field,
    //   list
    // );

    // const disconnects = getItemsToConnectOrDisconnect(
    //   value.disconnect || [],
    //   context,
    //   field,
    //   list
    // );

    // TODO
    // const sets = Promise.allSettled(getResolvedUniqueWheres(value.set || [], context, foreignList));

    // TODO
    // // Perform nested mutations for the creations
    // const creates = Promise.allSettled(
    //   (value.create || []).map(x => nestedMutationState.create(x, foreignList))
    // );

    return {
      connect: await connects,
    };

    const [connectResult, createResult, disconnectResult, setResult] = await Promise.all([
      connects,
      creates,
      disconnects,
      sets,
    ]);

    // Collect all the errors
    const errors = [
      ...connectResult.filter(isRejected),
      ...createResult.filter(isRejected),
      ...disconnectResult.filter(isRejected),
      ...setResult.filter(isRejected),
    ];
    if (errors.length) {
      throw new Error(
        `Unable to create, connect, disconnect and/or set ${errors.length} ${target}`
      );
    }

    return {
      // unlike all the other operations, an empty array isn't a no-op for set
      set: value.set ? setResult.filter(isFulfilled).map(x => x.value) : undefined,
      disconnect: disconnectResult.filter(isFulfilled).map(x => x.value),
      connect: [...connectResult, ...createResult].filter(isFulfilled).map(x => x.value),
    };
  };
}
