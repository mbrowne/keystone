import { resolveUniqueWhereInput, UniqueInputFilter, UniquePrismaFilter } from '../../where-inputs';
import { KeystoneContext } from '../../../../types';
import { InitialisedList } from '../../types-for-lists';
import { NestedMutationState } from '../create-update';
import { CreateOneValueType } from './types';

export function getResolvedUniqueWheres(
  uniqueInputs: UniqueInputFilter[],
  context: KeystoneContext,
  foreignList: InitialisedList
): Promise<UniquePrismaFilter>[] {
  return uniqueInputs.map(async uniqueInput => {
    // Validate and resolve the input filter
    const uniqueWhere = await resolveUniqueWhereInput(uniqueInput, foreignList.fields, context);
    // Check whether the item exists
    const item = await context.db[foreignList.listKey].findOne({ where: uniqueInput });
    if (item === null) {
      throw new Error('Unable to find item to connect to.');
    }
    return uniqueWhere;
  });
}

export async function handleCreateAndUpdate(
  value: CreateOneValueType,
  nestedMutationState: NestedMutationState,
  context: KeystoneContext,
  foreignList: InitialisedList,
  target: string
) {
  if (value.connect) {
    // Validate and resolve the input filter
    const uniqueWhere = await resolveUniqueWhereInput(value.connect, foreignList.fields, context);
    // Check whether the item exists
    try {
      const item = await context.db[foreignList.listKey].findOne({ where: value.connect });
      if (item === null) {
        throw new Error(`Unable to connect a ${target}`);
      }
    } catch (err) {
      throw new Error(`Unable to connect a ${target}`);
    }
    return { connect: uniqueWhere };
  } else if (value.create) {
    const createInput = value.create;
    let create = await (async () => {
      try {
        // Perform the nested create operation
        return await nestedMutationState.create(createInput, foreignList);
      } catch (err) {
        throw new Error(`Unable to create a ${target}`);
      }
    })();

    return { connect: { id: create.id } };
  }
}
