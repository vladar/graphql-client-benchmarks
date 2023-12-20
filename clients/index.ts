import { ApolloInMemory } from './apollo-inmemory';
import { ApolloInMemoryResultCache } from './apollo-inmemory-resultcache';
import { ApolloRelayStoreCache } from './apollo-relay-store';
import { ApolloRelayStoreCacheFullyRuntime } from './apollo-relay-store-fully-runtime';
import { Relay } from './relay';

export = [
  ApolloInMemory,
  ApolloInMemoryResultCache,
  Relay,
  ApolloRelayStoreCache,
  ApolloRelayStoreCacheFullyRuntime,
];
