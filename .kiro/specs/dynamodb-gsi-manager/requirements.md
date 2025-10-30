# Requirements Document

## Introduction

DynamoDB GSI Manager は、AWS CDK のカスタムリソースとして実装され、DynamoDB テーブルの Global Secondary Index (GSI) を一括で管理する機能を提供します。DynamoDB API の制限（一度に一つの GSI のみ操作可能）を考慮し、複数の GSI を順次処理することで、効率的な GSI 管理を実現します。

## Glossary

-   **GSI_Manager**: DynamoDB GSI を管理するカスタムリソース
-   **DynamoDB_Table**: GSI 操作の対象となる DynamoDB テーブル
-   **GSI_Configuration**: GSI の設定情報（インデックス名、パーティションキー、ソートキー）
-   **Custom_Resource**: AWS CDK で定義されるカスタムリソース
-   **Lambda_Function**: カスタムリソースのバックエンドとして動作する Lambda 関数

## Requirements

### Requirement 1

**User Story:** As a CDK developer, I want to define multiple GSIs in a single custom resource, so that I can manage all GSIs for a table in one place.

#### Acceptance Criteria

1. THE GSI_Manager SHALL accept a tableName parameter specifying the target DynamoDB_Table
2. THE GSI_Manager SHALL accept a globalSecondaryIndexes parameter containing an array of GSI_Configuration objects
3. WHEN a GSI_Configuration is provided, THE GSI_Manager SHALL validate the indexName, partitionKey, and sortKey properties
4. THE GSI_Manager SHALL support AttributeType.STRING for both partition and sort keys
5. WHERE a sortKey is optional, THE GSI_Manager SHALL handle GSI configurations with only partition keys

### Requirement 2

**User Story:** As a CDK developer, I want the custom resource to automatically synchronize the actual GSI state with my desired configuration, so that I don't need to manually manage individual GSI operations.

#### Acceptance Criteria

1. WHEN the Custom_Resource is created or updated, THE GSI_Manager SHALL retrieve the current GSI state from the DynamoDB_Table
2. THE GSI_Manager SHALL compare the current state with the desired GSI_Configuration array
3. THE GSI_Manager SHALL identify GSIs that need to be created, updated, or deleted
4. THE GSI_Manager SHALL execute the required operations to achieve the desired state
5. THE GSI_Manager SHALL process GSI operations sequentially due to DynamoDB API limitations

### Requirement 3

**User Story:** As a CDK developer, I want GSI operations to handle DynamoDB rate limits gracefully, so that my deployments don't fail due to API throttling.

#### Acceptance Criteria

1. WHEN executing GSI operations, THE GSI_Manager SHALL process one GSI at a time
2. AFTER each GSI operation, THE GSI_Manager SHALL poll the operation status until completion
3. THE GSI_Manager SHALL implement appropriate delays between polling requests to avoid rate limits
4. IF a GSI operation fails due to rate limiting, THE GSI_Manager SHALL retry with exponential backoff
5. THE GSI_Manager SHALL wait for each GSI operation to reach ACTIVE status before proceeding to the next

### Requirement 4

**User Story:** As a CDK developer, I want the custom resource to clean up GSIs when the resource is deleted, so that I don't leave orphaned indexes.

#### Acceptance Criteria

1. WHEN the Custom_Resource is deleted, THE GSI_Manager SHALL retrieve all GSIs from the target DynamoDB_Table
2. THE GSI_Manager SHALL delete each GSI that was managed by this Custom_Resource
3. THE GSI_Manager SHALL process GSI deletions sequentially
4. THE GSI_Manager SHALL poll each deletion operation until completion
5. THE GSI_Manager SHALL implement appropriate delays to avoid rate limits during deletion

### Requirement 5

**User Story:** As a CDK developer, I want proper error handling and logging, so that I can troubleshoot issues when GSI operations fail.

#### Acceptance Criteria

1. THE GSI_Manager SHALL log all GSI operations with appropriate detail levels
2. WHEN a GSI operation fails, THE GSI_Manager SHALL provide detailed error messages
3. THE GSI_Manager SHALL distinguish between retryable and non-retryable errors
4. IF maximum retry attempts are reached, THE GSI_Manager SHALL fail with a clear error message
5. THE GSI_Manager SHALL return appropriate CloudFormation response status for success and failure cases
