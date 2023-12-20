// Updated imports
import graphqlTag from 'graphql-tag';
import {
  ApolloClient,
  ApolloLink,
  ApolloCache,
  InMemoryCache,
  ObservableQuery,
  ObservableSubscription,
  DocumentNode,
  // eslint-disable-next-line import/no-internal-modules
} from '@apollo/client/core';
import { RelayApolloCache } from '@graphitation/relay-apollo-duct-tape';
// eslint-disable-next-line import/no-internal-modules
// import packageInfo from '@graphitation/relay-apollo-duct-tape/package.json';

import { Client, Fragment, Observer, SingleExample, SingleRawExample, RawFragment, RawExample } from '../src';
import { addMinimalViableSchemaToRequestDocument } from '@graphitation/supermassive';
import { GraphQLSchema, buildASTSchema, parse } from 'graphql';

class ApolloObserver implements Observer {
  private _mostRecentResult?: any = null;
  private _subscription?: ObservableSubscription;
  constructor(observable: ObservableQuery<any>) {
    this._subscription = observable.subscribe(
      ({ data }) => {
        this._mostRecentResult = { data };
      },
      error => {
        this._mostRecentResult = { errors: [error] };
      },
    );
  }

  unsubscribe() {
    this._subscription.unsubscribe();
  }

  mostRecentResult() {
    return this._mostRecentResult;
  }
}

export interface ApolloFragmentExample extends Omit<RawFragment, 'operation'> {
  operation: DocumentNode;
}

interface ApolloExample extends SingleExample {
  operation: DocumentNode;
  variables?: object;
  fragment?: ApolloFragmentExample;
}

export class ApolloRelayStoreCache extends Client {
  static metadata = {
    name: `Apollo (RelayStore no runtime annotations)`,
  };

  apollo: ApolloClient<any>;

  constructor(cache: ApolloCache<any> = new RelayApolloCache({ mode: 'BUILDTIME' })) {
    super();

    this.apollo = new ApolloClient({
      cache,
      link: new ApolloLink(),
    });
  }

  transformRawExample(rawExample: RawExample): ApolloExample {
    let fragment: ApolloFragmentExample;

    const schema = buildASTSchema(graphqlTag(rawExample.schema));
    const transformerCache = new RelayApolloCache({ mode: 'RUNTIME_SUPERMASSIVE' });
    if ('fragment' in rawExample) {
      const operation = transformerCache.transformDocument(
        addMinimalViableSchemaToRequestDocument(schema, graphqlTag(rawExample.fragment.operation), {
          addTo: 'PROPERTY',
        }),
      );
      fragment = {
        operation,
        fragmentPath: rawExample.fragment.fragmentPath,
      };
    }

    const operation = transformerCache.transformDocument(
      addMinimalViableSchemaToRequestDocument(schema, graphqlTag(rawExample.operation), {
        addTo: 'PROPERTY',
      }),
    );

    return {
      operation,
      fragment,
      response: rawExample.response,
      variables: rawExample.variables,
    };
  }

  async read({ operation, variables }: ApolloExample) {
    try {
      return {
        data: this.apollo.readQuery({ query: operation, variables }),
      };
    } catch (error) {
      // Apollo throws if data is missing
      return null;
    }
  }

  async readFragment({ fragment, variables }: ApolloExample, fragmentInstance: Fragment) {
    try {
      return {
        data: this.apollo.readFragment({
          id: `${fragmentInstance.typename}:${fragmentInstance.id}`,
          fragment: fragment.operation,
          variables,
        }),
      };
    } catch (error) {
      // Apollo throws if data is missing
      return null;
    }
  }

  async write({ operation, response, variables }: ApolloExample) {
    this.apollo.writeQuery({
      data: response,
      query: operation,
      variables,
    });
  }

  observe({ operation, variables }: ApolloExample) {
    const observable = this.apollo.watchQuery({
      query: operation,
      variables,
      fetchPolicy: 'cache-only',
    });
    return new ApolloObserver(observable);
  }
}
