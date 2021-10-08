import { GraphQLResolveInfo } from 'graphql';
import {
  FindManyArgsValue,
  ItemRootValue,
  KeystoneContext,
  OrderDirection,
  PolymorphicRelationDBField,
} from '../../../types';
import { getOperationAccess, getAccessFilters } from '../access-control';
import {
  PrismaFilter,
  UniquePrismaFilter,
  resolveUniqueWhereInput,
  resolveWhereInput,
  UniqueInputFilter,
  InputFilter,
} from '../where-inputs';
import { limitsExceededError, userInputError } from '../graphql-errors';
import { InitialisedList } from '../types-for-lists';
import {
  customOperationWithPrisma,
  getDBFieldKeyForFieldOnMultiField,
  IdType,
  runWithPrisma,
} from '../utils';
import { checkFilterOrderAccess } from '../filter-order-access';
import { ResolvedPolymorphicRelationDBField } from '../resolve-relationships';

// doing this is a result of an optimisation to skip doing a findUnique and then a findFirst(where the second one is done with access control)
// we want to do this explicit mapping because:
// - we are passing the values into a normal where filter and we want to ensure that fields cannot do non-unique filters(we don't do validation on non-unique wheres because prisma will validate all that)
// - for multi-field unique indexes, we need to a mapping because iirc findFirst/findMany won't understand the syntax for filtering by multi-field unique indexes(which makes sense and is correct imo)
export function mapUniqueWhereToWhere(
  list: InitialisedList,
  uniqueWhere: UniquePrismaFilter
): PrismaFilter {
  // inputResolvers.uniqueWhere validates that there is only one key
  const key = Object.keys(uniqueWhere)[0];
  const dbField = list.fields[key].dbField;
  if (dbField.kind !== 'scalar' || (dbField.scalar !== 'String' && dbField.scalar !== 'Int')) {
    throw new Error(
      'Currently only String and Int scalar db fields can provide a uniqueWhere input'
    );
  }
  const val = uniqueWhere[key];
  if (dbField.scalar === 'Int' && typeof val !== 'number') {
    throw new Error('uniqueWhere inputs must return an integer for Int db fields');
  }
  if (dbField.scalar === 'String' && typeof val !== 'string') {
    throw new Error('uniqueWhere inputs must return an string for String db fields');
  }
  return { [key]: val };
}

function traverseQuery(
  list: InitialisedList,
  context: KeystoneContext,
  inputFilter: InputFilter,
  filterFields: Record<string, { fieldKey: string; list: InitialisedList }>
) {
  // Recursively traverse a where filter to find all the fields which are being
  // filtered on.
  Object.entries(inputFilter).forEach(([fieldKey, value]) => {
    if (fieldKey === 'OR' || fieldKey === 'AND' || fieldKey === 'NOT') {
      value.forEach((value: any) => {
        traverseQuery(list, context, value, filterFields);
      });
    } else if (fieldKey === 'some' || fieldKey === 'none' || fieldKey === 'every') {
      traverseQuery(list, context, value, filterFields);
    } else {
      filterFields[`${list.listKey}.${fieldKey}`] = { fieldKey, list };
      // If it's a relationship, check the nested filters.
      const field = list.fields[fieldKey];
      if (field.dbField.kind === 'relation' && value !== null) {
        const foreignList = field.dbField.list;
        traverseQuery(list.lists[foreignList], context, value, filterFields);
      }
    }
  });
}

export async function checkFilterAccess(
  list: InitialisedList,
  context: KeystoneContext,
  inputFilter: InputFilter
) {
  if (!inputFilter) return;
  const filterFields: Record<string, { fieldKey: string; list: InitialisedList }> = {};
  traverseQuery(list, context, inputFilter, filterFields);
  await checkFilterOrderAccess(Object.values(filterFields), context, 'filter');
}

export async function accessControlledFilter(
  list: InitialisedList,
  context: KeystoneContext,
  resolvedWhere: PrismaFilter,
  accessFilters: boolean | InputFilter
) {
  // Merge the filter access control
  if (typeof accessFilters === 'object') {
    resolvedWhere = { AND: [resolvedWhere, await resolveWhereInput(accessFilters, list, context)] };
  }

  return resolvedWhere;
}

export async function findOne(
  args: { where: UniqueInputFilter },
  list: InitialisedList,
  context: KeystoneContext
) {
  // Check operation permission to pass into single operation
  const operationAccess = await getOperationAccess(list, context, 'query');
  if (!operationAccess) {
    return null;
  }

  const accessFilters = await getAccessFilters(list, context, 'query');
  if (accessFilters === false) {
    return null;
  }

  // Validate and resolve the input filter
  const uniqueWhere = await resolveUniqueWhereInput(args.where, list.fields, context);
  const resolvedWhere = mapUniqueWhereToWhere(list, uniqueWhere);

  // Check filter access
  const fieldKey = Object.keys(args.where)[0];
  await checkFilterOrderAccess([{ fieldKey, list }], context, 'filter');

  // Apply access control
  const filter = await accessControlledFilter(list, context, resolvedWhere, accessFilters);

  // const result = runWithPrisma(context, list, model => model.findFirst({ where: filter }));
  // result.then(r => {
  //   console.log('result: ', r);
  // });
  // return result;

  return runWithPrisma(context, list, model => model.findFirst({ where: filter }));
}

export async function findMany(
  { where, take, skip, orderBy: rawOrderBy }: FindManyArgsValue,
  list: InitialisedList,
  context: KeystoneContext,
  info: GraphQLResolveInfo,
  extraFilter?: PrismaFilter
): Promise<ItemRootValue[]> {
  const orderBy = await resolveOrderBy(rawOrderBy, list, context);

  // Check operation permission, throw access denied if not allowed
  const operationAccess = await getOperationAccess(list, context, 'query');
  if (!operationAccess) {
    return [];
  }

  const accessFilters = await getAccessFilters(list, context, 'query');
  if (accessFilters === false) {
    return [];
  }

  applyEarlyMaxResults(take, list);

  let resolvedWhere = await resolveWhereInput(where, list, context);

  // Check filter access
  await checkFilterAccess(list, context, where);

  resolvedWhere = await accessControlledFilter(list, context, resolvedWhere, accessFilters);

  const results = await runWithPrisma(context, list, model =>
    model.findMany({
      where: extraFilter === undefined ? resolvedWhere : { AND: [resolvedWhere, extraFilter] },
      orderBy,
      take: take ?? undefined,
      skip,
    })
  );

  applyMaxResults(results, list, context);

  // //temp
  // // if (list.listKey === 'Post') {
  // for (const item of results) {
  //   console.log('item: ', item);
  //   item.content = [];
  // }
  // // }

  if (info.cacheControl && list.cacheHint) {
    info.cacheControl.setCacheHint(
      list.cacheHint({ results, operationName: info.operation.name?.value, meta: false }) as any
    );
  }
  return results;
}

export async function findManyPolymorphic(
  { where, take, skip, orderBy: rawOrderBy }: FindManyArgsValue,
  dbField: ResolvedPolymorphicRelationDBField,
  lists: Record<string, InitialisedList>,
  context: KeystoneContext,
  info: GraphQLResolveInfo,
  sourceId: IdType
): Promise<ItemRootValue[]> {
  if (rawOrderBy) {
    throw Error('orderBy not yet supported for polymorphic relations');
  }

  for (const foreignField of Object.values(dbField.fields)) {
    const list = lists[foreignField.list];
    if (list.maxResults && list.maxResults < Infinity) {
      throw Error(
        'list.maxResults is not currently supported when the list is one of the refs' +
          ' of a polymorphic relationship'
      );
    }

    // Check operation permission, throw access denied if not allowed
    const operationAccess = await getOperationAccess(list, context, 'query');
    if (!operationAccess) {
      return [];
    }

    const accessFilters = await getAccessFilters(list, context, 'query');
    if (accessFilters === false) {
      return [];
    }

    // Check filter access
    await checkFilterAccess(list, context, where);
  }

  // TODO adjust this to work with polymorphic relations
  // applyEarlyMaxResults(take, list);

  // TODO
  // let resolvedWhere = await resolveWhereInputPolymorphic(where, list, context);
  //
  // resolvedWhere = await accessControlledFilter(list, context, resolvedWhere, accessFilters);

  // Resolve polymorphic relations, if any
  try {
    const orderByFields = ['order'];

    const results = await customOperationWithPrisma(
      context,
      prisma =>
        prisma.$queryRaw`SELECT contentType as __typename, 'TODO' as chunkName, contentId, ${'order'}
          FROM PostContent
          WHERE postId = ${sourceId}
          ORDER BY ${orderByFields.join(',')}`
    );
    console.log('results', results);

    if (info.cacheControl) {
      console.warn('Warning: cacheControl is not currently supported for polymorphic relations');
    }

    //temp
    const interfaceFields = ['chunkName'];

    const resolvedItems = results.map(row => {
      const item: ItemRootValue = {
        id: row.id,
      };
      for (const interfaceField of interfaceFields) {
        item[interfaceField] = row[interfaceField];
      }
      return item;
    });
    console.log('resolvedItems', resolvedItems);

    return [
      {
        __typename: 'HeroComponent',
        id: 'a',
        chunkName: 'teswt',
      },
    ];

    return resolvedItems;

    // TODO
    // applyMaxResults(results, list, context);
  } catch (e) {
    // TEMP
    console.log(e);
    throw e;
  }
}

async function resolveOrderBy(
  orderBy: readonly Record<string, any>[],
  list: InitialisedList,
  context: KeystoneContext
): Promise<readonly Record<string, OrderDirection>[]> {
  // Check input format. FIXME: Group all errors
  orderBy.forEach(orderBySelection => {
    const keys = Object.keys(orderBySelection);
    if (keys.length !== 1) {
      throw userInputError(
        `Only a single key must be passed to ${list.types.orderBy.graphQLType.name}`
      );
    }

    const fieldKey = keys[0];
    const value = orderBySelection[fieldKey];
    if (value === null) {
      throw userInputError('null cannot be passed as an order direction');
    }
  });

  // Check orderBy access
  const orderByKeys = orderBy.map(orderBySelection => ({
    fieldKey: Object.keys(orderBySelection)[0],
    list,
  }));
  await checkFilterOrderAccess(orderByKeys, context, 'orderBy');

  return await Promise.all(
    orderBy.map(async orderBySelection => {
      const keys = Object.keys(orderBySelection);
      const fieldKey = keys[0];
      const value = orderBySelection[fieldKey];
      const field = list.fields[fieldKey];
      const resolve = field.input!.orderBy!.resolve;
      const resolvedValue = resolve ? await resolve(value, context) : value;
      if (field.dbField.kind === 'multi') {
        // Note: no built-in field types support multi valued database fields *and* orderBy.
        // This code path is only relevent to custom fields which fit that criteria.
        const keys = Object.keys(resolvedValue);
        if (keys.length !== 1) {
          throw new Error(
            `Only a single key must be returned from an orderBy input resolver for a multi db field`
          );
        }
        const innerKey = keys[0];
        return {
          [getDBFieldKeyForFieldOnMultiField(fieldKey, innerKey)]: resolvedValue[innerKey],
        };
      } else {
        return { [fieldKey]: resolvedValue };
      }
    })
  );
}

export async function count(
  { where }: { where: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext,
  info: GraphQLResolveInfo,
  extraFilter?: PrismaFilter
) {
  // Check operation permission, return zero if not allowed
  const operationAccess = await getOperationAccess(list, context, 'query');
  if (!operationAccess) {
    return 0;
  }

  const accessFilters = await getAccessFilters(list, context, 'query');
  if (accessFilters === false) {
    return 0;
  }

  let resolvedWhere = await resolveWhereInput(where, list, context);

  // Check filter access
  await checkFilterAccess(list, context, where);

  resolvedWhere = await accessControlledFilter(list, context, resolvedWhere, accessFilters);

  const count = await runWithPrisma(context, list, model =>
    model.count({
      where: extraFilter === undefined ? resolvedWhere : { AND: [resolvedWhere, extraFilter] },
    })
  );
  if (info.cacheControl && list.cacheHint) {
    info.cacheControl.setCacheHint(
      list.cacheHint({
        results: count,
        operationName: info.operation.name?.value,
        meta: true,
      }) as any
    );
  }
  return count;
}

function applyEarlyMaxResults(_take: number | null | undefined, list: InitialisedList) {
  const take = Math.abs(_take ?? Infinity);
  // We want to help devs by failing fast and noisily if limits are violated.
  // Unfortunately, we can't always be sure of intent.
  // E.g., if the query has a "take: 10", is it bad if more results could come back?
  // Maybe yes, or maybe the dev is just paginating posts.
  // But we can be sure there's a problem in two cases:
  // * The query explicitly has a "take" that exceeds the limit
  // * The query has no "take", and has more results than the limit
  if (take < Infinity && take > list.maxResults) {
    throw limitsExceededError({ list: list.listKey, type: 'maxResults', limit: list.maxResults });
  }
}

function applyMaxResults(results: unknown[], list: InitialisedList, context: KeystoneContext) {
  if (results.length > list.maxResults) {
    throw limitsExceededError({ list: list.listKey, type: 'maxResults', limit: list.maxResults });
  }
  if (context) {
    context.totalResults += results.length;
    if (context.totalResults > context.maxTotalResults) {
      throw limitsExceededError({
        list: list.listKey,
        type: 'maxTotalResults',
        limit: context.maxTotalResults,
      });
    }
  }
}
