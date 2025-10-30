# Implementation Plan

## Core Type System and Interfaces

-   [x] 1. Create missing GSI type definitions

    -   Create `lib/types/gsi-types.ts` with GSI configuration interfaces ✅
    -   Define GSIConfiguration, GSIInfo, AttributeDefinition, and ProjectionType interfaces ✅
    -   Ensure compatibility with DynamoDB API types (validation helper added) ✅
    -   _Design Reference: Data Models section_

-   [x] 2. Complete GSI Manager construct props interface
    -   Add GSIManagerProps interface to type exports (error handling option added) ✅
    -   Define construct configuration options
    -   _Design Reference: Components and Interfaces section_

-   [x] 2a. Move GSI configuration validation into the custom resource Lambda
    -   Remove validation from construct layer ✅
    -   Implement validation in Lambda handler before processing ✅

## DynamoDB Service Layer

-   [x] 3. Implement DynamoDB GSI service

    -   [x] 3.1 Create DynamoDB service class implementing DynamoDBGSIService interface ✅

        -   Implement getCurrentGSIs method for retrieving current GSI state ✅
        -   Add table description parsing logic ✅
        -   _Design Reference: DynamoDB Service Interface_

    -   [x] 3.2 Implement GSI lifecycle operations ✅

        -   Add createGSI method with proper UpdateTable API calls ✅
        -   Implement deleteGSI method for GSI removal ✅
        -   Add updateGSI method for throughput updates ✅
        -   _Design Reference: Components and Interfaces section_

    -   [x] 3.3 Add GSI status monitoring ✅
        -   Implement waitForGSIStatus with polling logic ✅
        -   Add waitForTableStable method for operation sequencing ✅
        -   Include adaptive polling intervals ✅
        -   _Design Reference: Performance Optimizations section_

## Operation Planning and State Management

-   [ ] 4. Create GSI operation planner

    -   [x] 4.1 Implement GSI diff calculation ✅

        -   Compare current vs desired GSI configurations ✅
        -   Generate ordered list of required operations (create/update/delete) ✅
        -   Handle operation dependencies and sequencing ✅
        -   _Design Reference: Component Interaction Flow_

    -   [ ] 4.2 Add operation state tracking
        -   Create GSIOperationState and GSIOperation models
        -   Implement operation progress tracking
        -   Add operation result aggregation
        -   _Design Reference: Data Models section_

## Error Handling and Retry Logic

-   [ ] 5. Implement robust error handling

    -   [ ] 5.1 Create error classification system

        -   Categorize errors (validation, rate limiting, conflicts, permanent)
        -   Implement error type detection logic
        -   _Design Reference: Error Categories section_

    -   [x] 5.2 Add retry mechanism with exponential backoff ✅
        -   Implement configurable retry logic with jitter ✅
        -   Add circuit breaker for consecutive failures
        -   Include proper error propagation ✅
        -   _Design Reference: Retry Logic section_

## Lambda Function Implementation

-   [x] 6. Complete Lambda handler logic

    -   [x] 6.1 Implement CloudFormation event processing ✅

        -   Parse CustomResourceEvent for Create/Update/Delete operations ✅
        -   Extract and validate resource properties ✅
        -   Handle PhysicalResourceId management ✅
        -   _Design Reference: Lambda Function Handler section_

    -   [x] 6.2 Add GSI management orchestration ✅

        -   Integrate DynamoDB service with operation planner ✅
        -   Implement sequential GSI operation execution ✅
        -   Add comprehensive error handling and rollback logic ✅
        -   _Design Reference: Component Interaction Flow_

    -   [x] 6.3 Implement CloudFormation response handling ✅
        -   Complete sendResponse function with proper HTTP calls ⭐（Provider経由でハンドリング）
        -   Add structured response formatting ✅
        -   Include operation results in response data ✅
        -   _Design Reference: Lambda Function Handler section_

## CDK Construct Enhancement

-   [x] 7. Enhance GSI Manager construct

    -   [x] 7.1 Complete construct implementation ✅

        -   Add proper GSI configuration validation（handled in Lambda layer）
        -   Implement resource property transformation ✅
        -   Add construct-level error handling ✅
        -   _Design Reference: CDK Custom Resource Construct section_

    -   [x] 7.2 Add IAM permissions and security ✅
        -   Implement least-privilege IAM policies ✅
        -   Add resource-specific permissions ✅
        -   Include CloudWatch logging permissions ✅
        -   _Design Reference: Security Considerations section_

## Build and Deployment Setup

-   [ ] 8. Configure Lambda build process

    -   [ ] 8.1 Set up TypeScript compilation for Lambda

        -   Configure tsconfig.json for Lambda function
        -   Add build scripts for Lambda deployment package
        -   Set up source map generation
        -   _Implementation requirement for Lambda deployment_

    -   [ ] 8.2 Add Lambda packaging and deployment
        -   Create dist directory structure
        -   Configure CDK asset bundling
        -   Add proper dependency management
        -   _Implementation requirement for CDK deployment_

## Testing and Validation

-   [ ]\* 9. Create comprehensive test suite

    -   [ ]\* 9.1 Add unit tests for core functionality

        -   Test GSI configuration validation
        -   Test operation planning logic
        -   Test error handling scenarios
        -   _Design Reference: Unit Tests section_

    -   [ ]\* 9.2 Add integration tests

        -   Test DynamoDB API integration
        -   Test Custom Resource lifecycle
        -   Test concurrent operation handling
        -   _Design Reference: Integration Tests section_

    -   [ ]\* 9.3 Add end-to-end tests
        -   Test complete CDK deployment flow
        -   Test CloudFormation integration
        -   Test real GSI operations
        -   _Design Reference: End-to-End Tests section_

## Monitoring and Observability

-   [ ]\* 10. Add monitoring and logging

    -   [ ]\* 10.1 Implement structured logging

        -   Add JSON-formatted logging throughout
        -   Include operation correlation IDs
        -   Add performance metrics logging
        -   _Design Reference: Monitoring and Observability section_

    -   [ ]\* 10.2 Add CloudWatch metrics
        -   Implement custom metrics for operations
        -   Add success/failure rate tracking
        -   Include operation duration metrics
        -   _Design Reference: Monitoring and Observability section_
