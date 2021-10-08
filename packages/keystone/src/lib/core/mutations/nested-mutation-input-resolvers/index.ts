import * as polymorphic from './polymorphic-relation-resolvers';
import * as standard from './standard-relation-resolvers';

type PolymorphicResolvers = typeof polymorphic;
export type MutationPolymorphicRelationInputResolver =
  PolymorphicResolvers[keyof PolymorphicResolvers];

type StandardResolvers = typeof standard;
export type MutationStandardRelationInputResolver = StandardResolvers[keyof StandardResolvers];

export const inputResolvers = {
  polymorphic,
  standard,
};
