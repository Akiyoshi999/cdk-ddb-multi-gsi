# DynamoDB GSI Manager Snapshot

## Shared Types
- lib/types/gsi-types.ts exports AttributeDefinition, GSIConfiguration, and validation helpers for both construct and Lambda layers.
- Validation now flags duplicate index names, missing keys, and unsupported attribute or projection types before synthesis.
- Operation plan types (GSIOperation, GSIOperationResult) centralise orchestration data structures.

## Construct Update
- lib/gsi-manager-construct.ts provisions the Lambda provider (Node.js 20 + esbuild bundling) and grants DynamoDB permissions.
- lib/cdk-ddb-multi-gsi-stack.ts delegates GSI orchestration to the custom resource while keeping table definition minimal.

## Lambda Runtime
- lambda/gsi-manager/src/dynamodb-gsi-service.ts implements DescribeTable/UpdateTable flows with retryable backoff and waiter logic.
- lambda/gsi-manager/src/handler.ts validates incoming props, plans operations, and executes them sequentially with state polling.
- lambda/gsi-manager/src/operation-planner.ts surfaces required CREATE/UPDATE/DELETE steps while preserving external GSIs.

## Follow Up
- Integrate richer error classification / circuit breaker logic as outlined in task 5.1.
- Add dedicated build pipeline (task 8) and automated tests (task 9) for the Lambda bundle.
