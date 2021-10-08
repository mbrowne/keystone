import { Prisma } from '@prisma/client';
import { KeystoneContext } from '../../../../types';
import { InitialisedField, InitialisedList } from '../../types-for-lists';
import { isRejected, isFulfilled, IdType, customOperationWithPrisma } from '../../utils';
import { userInputError } from '../../graphql-errors';
import { NestedMutationState } from '../create-update';
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

async function getRelatedItemsById(
  ids: string[],
  context: KeystoneContext,
  field: InitialisedPolymorphicRelationshipField
  // list: InitialisedList
) {
  const foreignTableNames = Object.values(field.dbField.fields).map(
    foreignField => foreignField.list
  );

  const unionQuery = foreignTableNames
    .map(name => Prisma.sql`SELECT id FROM ${name}`)
    .join(' UNION ');

  const results = await customOperationWithPrisma(
    context,
    prisma =>
      prisma.$queryRaw`${unionQuery}
        WHERE id IN (${ids.join(',')})`
  );
}

async function getItemIdsToConnectOrDisconnect(
  uniqueInputs: UniqueInputFilter[],
  context: KeystoneContext,
  field: InitialisedPolymorphicRelationshipField,
  list: InitialisedList
): Promise<string>[] {
  // Validate input filter
  const ids = uniqueInputs.map(uniqueInput => {
    const { id, _type, ...otherFilters } = uniqueInput;
    if (!id || Object.keys(otherFilters).length) {
      throw Error('Only ID filters are currently supported for polymorphic relationships');
    }
    return id;
  });

  // Check whether the items exist
  const verifiedIds = await getRelatedItemsById(ids, context, field);

  // if (item === null) {
  //   throw new Error('Unable to find item to connect to.');
  // }

  return verifiedIds;
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

    // Perform queries for the connections
    const connects = Promise.allSettled(
      getItemIdsToConnectOrDisconnect(value.connect || [], context, field, list)
    );

    const disconnects = Promise.allSettled(
      getItemIdsToConnectOrDisconnect(value.disconnect || [], context, field, list)
    );

    const sets = Promise.allSettled(getResolvedUniqueWheres(value.set || [], context, foreignList));

    // Perform nested mutations for the creations
    const creates = Promise.allSettled(
      (value.create || []).map(x => nestedMutationState.create(x, foreignList))
    );

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
