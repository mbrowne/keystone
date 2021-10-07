import { RelationshipFieldConfig } from '../../fields';
import {
  DBField,
  MultiDBField,
  NoDBField,
  PolymorphicRelationDBField,
  RelationDBField,
  ScalarishDBField,
} from '../../types';

type BaseResolvedRelationDBField = {
  kind: 'relation';
  list: string;
  field: string;
  relationName: string;
};

export type ResolvedRelationDBField =
  | (BaseResolvedRelationDBField & {
      mode: 'many';
    })
  | (BaseResolvedRelationDBField & {
      mode: 'one';
      foreignIdField: 'none' | 'owned' | 'owned-unique';
    });

export type ResolvedPolymorphicRelationDBField = PolymorphicRelationDBField;

export type ListsWithResolvedRelations = Record<
  string,
  { resolvedDbFields: FieldsWithResolvedRelations }
>;

export type ResolvedDBField =
  | ResolvedRelationDBField
  | ScalarishDBField
  | NoDBField
  | MultiDBField<Record<string, ScalarishDBField>>
  | ResolvedPolymorphicRelationDBField;

// note: all keystone fields correspond to a field here
// not all fields here correspond to keystone fields(the implicit side of one-sided relation fields)
type FieldsWithResolvedRelations = Record<string, ResolvedDBField>;

type Rel = {
  listKey: string;
  fieldPath: string;
  mode: 'many' | 'one';
};

function sortRelationships(left: Rel, right: Rel) {
  const order = left.listKey.localeCompare(right.listKey);
  if (order > 0) {
    // left comes after right, so swap them.
    return [right, left];
  } else if (order === 0) {
    // self referential list, so check the paths.
    if (left.fieldPath.localeCompare(right.fieldPath) > 0) {
      return [right, left];
    }
  }
  return [left, right];
}

type AnyFieldConfig = RelationshipFieldConfig<any> | any;

// what's going on here:
// - validating all the relationships
// - for relationships involving to-one: deciding which side owns the foreign key
// - turning one-sided relationships into two-sided relationships so that elsewhere in Keystone,
//   you only have to reason about two-sided relationships
//   (note that this means that there are "fields" in the returned ListsWithResolvedRelations
//   which are not actually proper Keystone fields, they are just a db field and nothing else)
export function resolveRelationships(
  lists: Record<
    string,
    {
      fields: Record<string, AnyFieldConfig & { dbField: DBField }>;
    }
  >
): ListsWithResolvedRelations {
  const alreadyResolvedTwoSidedRelationships = new Set<string>();
  const resolvedLists: Record<string, Record<string, ResolvedDBField>> = Object.fromEntries(
    Object.keys(lists).map(listKey => [listKey, {}])
  );
  for (const [listKey, fields] of Object.entries(lists)) {
    const resolvedList = resolvedLists[listKey];
    for (const [fieldPath, field] of Object.entries(fields.fields)) {
      const { dbField } = field;
      if (dbField.kind !== 'relation') {
        // TODO verify -
        // Do we need this check? Depends on whether or not we end up adding a relationship
        // field to the Prisma model for the join table (currently we only have an ID field,
        // e.g. postId)
        if (dbField.kind === 'polymorphicRelation') {
          if (fieldPath === 'order') {
            throw new Error(`Invalid field name for polymorphic relationship: '${fieldPath}'`);
          }

          const polymorphicInterface = (field as RelationshipFieldConfig<any>).interface;

          for (const foreignField of Object.values(
            (dbField as PolymorphicRelationDBField).fields
          )) {
            resolvePolymorphicRelationship(
              listKey,
              fieldPath,
              foreignField,
              lists as any,
              resolvedLists,
              alreadyResolvedTwoSidedRelationships,
              polymorphicInterface
            );
          }
        }

        resolvedList[fieldPath] = dbField;
        continue;
      }

      resolveStandardRelationship(
        listKey,
        fieldPath,
        dbField,
        lists,
        resolvedLists,
        alreadyResolvedTwoSidedRelationships
      );
    }
  }
  // the way we resolve the relationships means that the relationships will be in a
  // different order than the order the user specified in their config
  // doesn't really change the behaviour of anything but it means that the order of the fields in the prisma schema will be
  // the same as the user provided
  return Object.fromEntries(
    Object.entries(resolvedLists).map(([listKey, outOfOrderDbFields]) => {
      // this adds the fields based on the order that the user passed in
      // (except it will not add the opposites to one-sided relations)
      const resolvedDbFields = Object.fromEntries(
        Object.keys(lists[listKey].fields).map(fieldKey => [fieldKey, outOfOrderDbFields[fieldKey]])
      );

      // then we add the opposites to one-sided relations
      Object.assign(resolvedDbFields, outOfOrderDbFields);
      return [listKey, { resolvedDbFields }];
    })
  );
}

function resolvePolymorphicRelationship(
  listKey: string,
  fieldPath: string,
  field: RelationDBField<'many' | 'one'>,
  lists: Record<
    string,
    { fields: Record<string, { dbField: DBField }>; implementsGraphQLInterfaces: Set<string> }
  >,
  resolvedLists: Record<string, Record<string, ResolvedDBField>>,
  alreadyResolvedTwoSidedRelationships: Set<string>,
  polymorphicInterface: RelationshipFieldConfig<any>['interface']
) {
  const foreignUnresolvedList = lists[field.list];
  if (!foreignUnresolvedList) {
    throw new Error(
      `The relationship field at ${listKey}.${fieldPath} points to the list ${listKey} which does not exist`
    );
  }

  if (field.field) {
    const localRef = `${listKey}.${fieldPath}`;
    const foreignRef = `${field.list}.${field.field}`;
    if (alreadyResolvedTwoSidedRelationships.has(localRef)) {
      return;
    }
    alreadyResolvedTwoSidedRelationships.add(foreignRef);
    const foreignFieldAnyFieldType = foreignUnresolvedList.fields[field.field]?.dbField;
    if (!foreignFieldAnyFieldType) {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef} but no field at ${foreignRef} exists`
      );
    }

    const foreignField = foreignFieldAnyFieldType;
    if (foreignField.kind !== 'relation') {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef} but ${foreignRef} is not a relationship field`
      );
    }

    // let foreignField;
    // if (foreignFieldAnyFieldType.kind !== 'relation') {
    //   console.log('foreignFieldAnyFieldType: ', foreignFieldAnyFieldType);

    //   foreignField = {
    //     kind: 'relation',
    //     list: 'test',
    //     field: field.field,
    //     // mode: Mode;
    //   };
    // } else {
    //   foreignField = foreignFieldAnyFieldType as RelationDBField<'many' | 'one'>;
    // }

    if (foreignField.list !== listKey) {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef} but ${foreignRef} points to the list ${foreignField.list} rather than ${listKey}`
      );
    }

    if (foreignField.field === undefined) {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef}, ${localRef} points to ${listKey} correctly but does not point to the ${fieldPath} field when it should`
      );
    }

    if (foreignField.field !== fieldPath) {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef}, ${localRef} points to ${listKey} correctly but points to the ${foreignField.field} field instead of ${fieldPath}`
      );
    }

    const resolvedForeignField = {
      listKey: field.list,
      fieldPath: field.field,
      mode: foreignField.mode,
    };
    console.log('resolvedForeignField: ', resolvedForeignField);

    // TODO
    // add field

    return;
  }
  const foreignFieldPath = `from_${listKey}_${fieldPath}`;
  console.log('foreignFieldPath: ', foreignFieldPath);

  const foreignList = lists[field.list];
  foreignList.implementsGraphQLInterfaces.add(polymorphicInterface!.name);
}

function resolveStandardRelationship(
  listKey: string,
  fieldPath: string,
  field: RelationDBField<'many' | 'one'>,
  lists: Record<string, { fields: Record<string, { dbField: DBField }> }>,
  resolvedLists: Record<string, Record<string, ResolvedDBField>>,
  alreadyResolvedTwoSidedRelationships: Set<string>
) {
  const resolvedList = resolvedLists[listKey];

  const foreignUnresolvedList = lists[field.list];
  if (!foreignUnresolvedList) {
    throw new Error(
      `The relationship field at ${listKey}.${fieldPath} points to the list ${listKey} which does not exist`
    );
  }
  if (field.field) {
    const localRef = `${listKey}.${fieldPath}`;
    const foreignRef = `${field.list}.${field.field}`;
    if (alreadyResolvedTwoSidedRelationships.has(localRef)) {
      return;
    }
    alreadyResolvedTwoSidedRelationships.add(foreignRef);
    const foreignField = foreignUnresolvedList.fields[field.field]?.dbField;
    if (!foreignField) {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef} but no field at ${foreignRef} exists`
      );
    }

    if (foreignField.kind === 'polymorphicRelation') {
      resolvedList[fieldPath] = {
        kind: 'none',
      };
      return;
    }

    if (foreignField.kind === 'relation') {
      if (foreignField.list !== listKey) {
        throw new Error(
          `The relationship field at ${localRef} points to ${foreignRef} but ${foreignRef} points to the list ${foreignField.list} rather than ${listKey}`
        );
      }

      if (foreignField.field === undefined) {
        throw new Error(
          `The relationship field at ${localRef} points to ${foreignRef}, ${localRef} points to ${listKey} correctly but does not point to the ${fieldPath} field when it should`
        );
      }

      if (foreignField.field !== fieldPath) {
        throw new Error(
          `The relationship field at ${localRef} points to ${foreignRef}, ${localRef} points to ${listKey} correctly but points to the ${foreignField.field} field instead of ${fieldPath}`
        );
      }
    } else {
      throw new Error(
        `The relationship field at ${localRef} points to ${foreignRef} but ${foreignRef} is not a relationship field`
      );
    }

    let [leftRel, rightRel] = sortRelationships(
      { listKey, fieldPath, mode: field.mode },
      { listKey: field.list, fieldPath: field.field, mode: foreignField.mode }
    );

    if (leftRel.mode === 'one' && rightRel.mode === 'one') {
      const relationName = `${leftRel.listKey}_${leftRel.fieldPath}`;
      resolvedLists[leftRel.listKey][leftRel.fieldPath] = {
        kind: 'relation',
        mode: 'one',
        field: rightRel.fieldPath,
        list: rightRel.listKey,
        foreignIdField: 'owned-unique',
        relationName,
      };
      resolvedLists[rightRel.listKey][rightRel.fieldPath] = {
        kind: 'relation',
        mode: 'one',
        field: leftRel.fieldPath,
        list: leftRel.listKey,
        foreignIdField: 'none',
        relationName,
      };
      return;
    }
    if (leftRel.mode === 'many' && rightRel.mode === 'many') {
      const relationName = `${leftRel.listKey}_${leftRel.fieldPath}_${rightRel.listKey}_${rightRel.fieldPath}`;
      resolvedLists[leftRel.listKey][leftRel.fieldPath] = {
        kind: 'relation',
        mode: 'many',
        field: rightRel.fieldPath,
        list: rightRel.listKey,
        relationName,
      };
      resolvedLists[rightRel.listKey][rightRel.fieldPath] = {
        kind: 'relation',
        mode: 'many',
        field: leftRel.fieldPath,
        list: leftRel.listKey,
        relationName,
      };
      return;
    }
    // if we're here, we're in a 1:N
    // and we want to make sure the 1 side on the left and the many on the right
    // (technically only one of these checks is necessary, the other one will have to be true if one is
    // but this communicates what's going on here)
    if (leftRel.mode === 'many' && rightRel.mode === 'one') {
      [leftRel, rightRel] = [rightRel, leftRel];
    }
    const relationName = `${leftRel.listKey}_${leftRel.fieldPath}`;
    resolvedLists[leftRel.listKey][leftRel.fieldPath] = {
      kind: 'relation',
      mode: 'one',
      field: rightRel.fieldPath,
      list: rightRel.listKey,
      foreignIdField: 'owned',
      relationName,
    };
    resolvedLists[rightRel.listKey][rightRel.fieldPath] = {
      kind: 'relation',
      mode: 'many',
      field: leftRel.fieldPath,
      list: leftRel.listKey,
      relationName,
    };
    return;
  }
  const foreignFieldPath = `from_${listKey}_${fieldPath}`;
  if (foreignUnresolvedList.fields[foreignFieldPath]) {
    throw new Error(
      `The relationship field at ${listKey}.${fieldPath} points to the list ${field.list}, Keystone needs to a create a relationship field at ${field.list}.${foreignFieldPath} to support the relationship at ${listKey}.${fieldPath} but ${field.list} already has a field named ${foreignFieldPath}`
    );
  }

  if (field.mode === 'many') {
    const relationName = `${listKey}_${fieldPath}_many`;
    resolvedLists[field.list][foreignFieldPath] = {
      kind: 'relation',
      mode: 'many',
      list: listKey,
      field: fieldPath,
      relationName,
    };
    resolvedList[fieldPath] = {
      kind: 'relation',
      mode: 'many',
      list: field.list,
      field: foreignFieldPath,
      relationName,
    };
  } else {
    const relationName = `${listKey}_${fieldPath}`;
    resolvedLists[field.list][foreignFieldPath] = {
      kind: 'relation',
      mode: 'many',
      list: listKey,
      field: fieldPath,
      relationName,
    };
    resolvedList[fieldPath] = {
      kind: 'relation',
      list: field.list,
      field: foreignFieldPath,
      foreignIdField: 'owned',
      relationName,
      mode: 'one',
    };
  }
}
