import graphql from 'babel-plugin-relay/macro';

graphql`
  query mostCommentedIssuesQuery {
    organization(login: "facebook") {
      __typename
      repositories(first: 50) {
        __typename
        nodes {
          __typename
          createdAt
          homepageUrl
          issues(first: 50, states: OPEN, orderBy: { field: COMMENTS, direction: DESC }) {
            __typename
            nodes {
              __typename
              createdAt
              id
              title
              comments {
                __typename
                totalCount
              }
            }
          }
        }
      }
    }
  }
`
