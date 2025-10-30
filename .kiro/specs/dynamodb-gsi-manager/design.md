# Design Document

## Overview

DynamoDB GSI Manager は、AWS CDK のカスタムリソースとして実装され、DynamoDB テーブルの Global Secondary Index (GSI) を一括で管理する機能を提供します。DynamoDB API の制限（一度に一つの GSI のみ操作可能）を考慮し、複数の GSI を順次処理することで効率的な GSI 管理を実現します。

## Architecture

### High-Level Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   CDK Stack     │───▶│ Custom Resource  │───▶│ Lambda Function │
│                 │    │   Provider       │    │  (GSI Manager)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
                                                         ▼
                                               ┌─────────────────┐
                                               │  DynamoDB API   │
                                               │ (UpdateTable)   │
                                               └─────────────────┘
```

### Component Interaction Flow

1. **CDK Deployment**: カスタムリソースが作成/更新/削除される
2. **CloudFormation**: カスタムリソースプロバイダーの Lambda 関数を呼び出し
3. **Lambda Function**: DynamoDB API を使用して GSI 操作を実行
4. **Polling**: 各 GSI 操作の完了を監視
5. **Response**: CloudFormation に成功/失敗を報告

## Components and Interfaces

### 1. CDK Custom Resource Construct

```typescript
interface GSIManagerProps {
    tableName: string;
    globalSecondaryIndexes: GSIConfiguration[];
}

interface GSIConfiguration {
    indexName: string;
    partitionKey: {
        name: string;
        type: dynamodb.AttributeType;
    };
    sortKey?: {
        name: string;
        type: dynamodb.AttributeType;
    };
    projectionType?: "ALL" | "KEYS_ONLY" | "INCLUDE";
    nonKeyAttributes?: string[];
}
```

### 2. Lambda Function Handler

```typescript
interface CustomResourceEvent {
    RequestType: "Create" | "Update" | "Delete";
    ResourceProperties: {
        tableName: string;
        globalSecondaryIndexes: GSIConfiguration[];
    };
    PhysicalResourceId?: string;
}

interface GSIOperationResult {
    success: boolean;
    operationType: "CREATE" | "UPDATE" | "DELETE";
    indexName: string;
    error?: string;
}
```

### 3. DynamoDB Service Interface

```typescript
interface DynamoDBGSIService {
    getCurrentGSIs(tableName: string): Promise<GSIInfo[]>;
    createGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>;
    updateGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>;
    deleteGSI(tableName: string, indexName: string): Promise<void>;
    waitForGSIStatus(
        tableName: string,
        indexName: string,
        targetStatus: string
    ): Promise<void>;
}
```

## Data Models

### GSI Configuration Model

```typescript
interface GSIConfiguration {
    indexName: string;
    partitionKey: AttributeDefinition;
    sortKey?: AttributeDefinition;
    projectionType: ProjectionType;
    nonKeyAttributes?: string[];
    provisionedThroughput?: {
        readCapacityUnits: number;
        writeCapacityUnits: number;
    };
}

interface AttributeDefinition {
    name: string;
    type: "S" | "N" | "B"; // String, Number, Binary
}

type ProjectionType = "ALL" | "KEYS_ONLY" | "INCLUDE";
```

### Operation State Model

```typescript
interface GSIOperationState {
    tableName: string;
    operations: GSIOperation[];
    currentOperationIndex: number;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

interface GSIOperation {
    type: "CREATE" | "UPDATE" | "DELETE";
    indexName: string;
    configuration?: GSIConfiguration;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
    retryCount: number;
}
```

## Error Handling

### Error Categories

1. **Validation Errors**: 設定の検証エラー（即座に失敗）
2. **Rate Limiting Errors**: DynamoDB API 制限（指数バックオフで再試行）
3. **Resource Conflicts**: 同時操作エラー（再試行）
4. **Permanent Errors**: 回復不可能なエラー（即座に失敗）

### Error Handling Strategy

```typescript
interface ErrorHandlingConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retryableErrorCodes: string[];
}

const DEFAULT_ERROR_CONFIG: ErrorHandlingConfig = {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    retryableErrorCodes: [
        "ThrottlingException",
        "ProvisionedThroughputExceededException",
        "ResourceInUseException",
    ],
};
```

### Retry Logic

1. **Exponential Backoff**: `delay = min(baseDelay * 2^retryCount, maxDelay)`
2. **Jitter**: ランダムな遅延を追加して thundering herd を回避
3. **Circuit Breaker**: 連続失敗時の早期終了

## Testing Strategy

### Unit Tests

1. **GSI Configuration Validation**: 設定の検証ロジック
2. **Operation Planning**: 現在状態と目標状態の差分計算
3. **Error Handling**: 各種エラーケースの処理
4. **Retry Logic**: 指数バックオフと jitter の動作

### Integration Tests

1. **DynamoDB API Integration**: 実際の DynamoDB API との連携
2. **Custom Resource Lifecycle**: 作成/更新/削除の完全なフロー
3. **Concurrent Operations**: 複数 GSI の順次処理
4. **Error Recovery**: 部分的失敗からの回復

### End-to-End Tests

1. **CDK Deployment**: 実際の CDK スタックでのデプロイメント
2. **CloudFormation Integration**: CloudFormation との完全な連携

## Implementation Considerations

### DynamoDB API Limitations

1. **Single GSI Operation**: 一度に一つの GSI のみ操作可能
2. **Rate Limiting**: API 呼び出し頻度の制限
3. **Status Polling**: 操作完了の監視が必要
4. **Backfill Time**: 大きなテーブルでの GSI 作成時間

### Performance Optimizations

1. **Parallel Status Checking**: 複数 GSI の状態を並行チェック
2. **Intelligent Polling**: 適応的なポーリング間隔
3. **Early Termination**: 不要な操作のスキップ
4. **Resource Cleanup**: 失敗時の部分的なクリーンアップ

### Security Considerations

1. **IAM Permissions**: 最小権限の原則
2. **Resource Isolation**: テーブル単位でのアクセス制御
3. **Error Information**: 機密情報の漏洩防止

### Monitoring and Observability

1. **CloudWatch Metrics**: カスタムメトリクスの出力
2. **Structured Logging**: JSON 形式での構造化ログ
