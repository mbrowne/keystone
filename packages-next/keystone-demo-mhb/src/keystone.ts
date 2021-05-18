import { config } from '@keystone-next/keystone/schema';
import {
  statelessSessions,
  withItemData,
} from '@keystone-next/keystone/session';
import { createAuth } from '@keystone-next/auth';

import { lists } from './schema';
import { ArtnetCRUDProvider } from './graphql-providers/crud'

let sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'The SESSION_SECRET environment variable must be set in production'
    );
  } else {
    sessionSecret = '-- DEV COOKIE SECRET; CHANGE ME --';
  }
}

let sessionMaxAge = 60 * 60 * 24 * 30; // 30 days

const auth = createAuth({
  listKey: 'User',
  identityField: 'email',
  secretField: 'password',
  initFirstItem: {
    fields: ['name', 'email', 'password'],
  },
});

const artnetCrudProvider = new ArtnetCRUDProvider()

export default auth.withAuth(
  config({
    db: {
      adapter: 'prisma_postgresql',
      url: process.env.DATABASE_URL || 'postgres://demouser:demo@localhost:5432/demo',
      onConnect: async keystoneContext => {
        console.log('keystoneContext.lists[0]', keystoneContext.lists[0])
        // artnetCrudProvider.lists = keystoneContext.lists
      }
    },
    ui: {
      isAccessAllowed: (context) => !!context.session?.data,
    },
    lists,
    session: withItemData(
      statelessSessions({
        maxAge: sessionMaxAge,
        secret: sessionSecret,
      }),
      { User: 'name' }
    ),
    disableDefaultCRUDProvider: true,
    graphqlProviders: [
      artnetCrudProvider
    ],
  })
);
