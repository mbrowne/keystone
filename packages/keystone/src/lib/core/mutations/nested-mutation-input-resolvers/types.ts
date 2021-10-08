import { TypesForList } from '../../../../types';
import { graphql } from '../../../..';
import { InitialisedField } from '../../types-for-lists';
import { ResolvedPolymorphicRelationDBField } from '../../resolve-relationships';

export type InitialisedPolymorphicRelationshipField = InitialisedField & {
  dbField: ResolvedPolymorphicRelationDBField;
};

export type CreateManyValueType = Exclude<
  graphql.InferValueFromArg<
    graphql.Arg<Exclude<TypesForList['relateTo']['many']['create'], undefined>>
  >,
  null | undefined
>;

export type UpdateManyValueType = Exclude<
  graphql.InferValueFromArg<
    graphql.Arg<Exclude<TypesForList['relateTo']['many']['update'], undefined>>
  >,
  null | undefined
>;

export type CreateOneValueType = Exclude<
  graphql.InferValueFromArg<
    graphql.Arg<Exclude<TypesForList['relateTo']['one']['create'], undefined>>
  >,
  null | undefined
>;

export type UpdateOneValueType = Exclude<
  graphql.InferValueFromArg<
    graphql.Arg<graphql.NonNullType<Exclude<TypesForList['relateTo']['one']['update'], undefined>>>
  >,
  null | undefined
>;
