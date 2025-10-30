# DynamoDB GSI Manager - 処理概要

## システム概要

このシステムは、DynamoDB テーブルの Global Secondary Index (GSI) を安全かつ自動的に管理するための CDK Construct と Lambda 関数で構成されています。CloudFormation Custom Resource を使用して、GSI の作成、更新、削除を CloudFormation デプロイメントのライフサイクルに統合しています。

## アーキテクチャ

```
┌─────────────────────────────────────────┐
│  CDK Stack                              │
│  ┌───────────────────────────────────┐  │
│  │ GsiManager Construct              │  │
│  │  - Lambda Function (Handler)      │  │
│  │  - Custom Resource Provider       │  │
│  │  - Custom Resource                │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Lambda Handler (handler.ts)            │
│  - CloudFormation イベント処理          │
│  - オペレーション計画の実行              │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌──────────────────┐   ┌──────────────────┐
│ Operation        │   │ DynamoDB GSI     │
│ Planner          │   │ Service          │
│ - 差分検出        │   │ - API 呼び出し   │
│ - 操作計画生成    │   │ - ステータス待機 │
└──────────────────┘   └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ Error Handling   │
                    │ - リトライロジック│
                    │ - エラー判定      │
                    └──────────────────┘
```

---

## 1. CDK Construct (`lib/gsi-manager-construct.ts`)

### 役割

CDK スタック内で使用される Construct で、GSI 管理に必要な Lambda 関数と Custom Resource を定義します。

### 主要コンポーネント

#### `GsiManager` クラス

- **props.table**: 管理対象の DynamoDB テーブル
- **props.globalSecondaryIndexes**: 作成・管理する GSI の設定リスト
- **props.errorHandling**: エラーハンドリング設定（リトライ回数、遅延時間など）
- **props.timeout**: Lambda のタイムアウト（デフォルト: 15 分）
- **props.logRetention**: CloudWatch Logs の保持期間（デフォルト: 1 週間）

#### 処理フロー

1. **Lambda 関数の作成**

   - `NodejsFunction` で TypeScript コードをバンドル
   - ESM 形式で出力（Node.js 20.x ランタイム）
   - メモリ 1024 MB、タイムアウト 15 分

2. **IAM 権限の付与**

   - `table.grantReadWriteData(handler)` でテーブルへの読み書き権限を付与

3. **Custom Resource Provider の作成**

   - Lambda 関数をイベントハンドラーとして登録

4. **Custom Resource の作成**
   - CloudFormation が Create/Update/Delete イベントを送信
   - プロパティとして `tableName`, `globalSecondaryIndexes`, `errorHandling` を渡す

#### 出力

- `managedIndexNames`: 管理対象の GSI 名のリスト（カンマ区切り文字列を配列に分割）

---

## 2. Lambda Handler (`lambda/gsi-manager/src/handler.ts`)

### 役割

CloudFormation Custom Resource のイベントを受け取り、GSI の操作を実行するメインハンドラー。

### CloudFormation イベント処理

#### `handler` 関数

CloudFormation から送信されるイベントタイプに応じて処理を分岐:

- **Create**: `handleCreateOrUpdate` を呼び出し
- **Update**: `handleCreateOrUpdate` を呼び出し
- **Delete**: `handleDelete` を呼び出し

### Create/Update 処理 (`handleCreateOrUpdate`)

1. **プロパティのパース**

   - CloudFormation から送られた JSON を `GSIManagerProps` 型に変換
   - プロパティ名の大文字小文字の違いを吸収（CloudFormation の仕様）

2. **バリデーション**

   - `validateGsiConfigurations` で GSI 設定の妥当性をチェック
   - エラーがあれば即座に失敗

3. **現在の GSI 状態を取得**

   - `DynamoDBGSIService.getCurrentGSIs` でテーブルの現在の GSI 情報を取得
   - 管理対象の GSI のみをフィルタリング

4. **操作計画の作成**

   - `planGsiOperations` で現在の状態と目標の状態の差分を計算
   - 必要な CREATE/UPDATE/DELETE 操作のリストを生成

5. **操作の実行**

   - `executeOperations` で操作を順次実行
   - 各操作後にテーブルとインデックスが ACTIVE になるまで待機

6. **レスポンス返却**
   - 実行した操作数と管理対象インデックス名をカンマ区切りで返す

### Delete 処理 (`handleDelete`)

1. **プロパティのパース**

   - Create/Update と同様

2. **現在の GSI 状態を取得**

   - 管理対象の GSI のみをフィルタリング

3. **削除操作の実行**
   - すべての管理対象 GSI に対して DELETE 操作を実行
   - 各削除後にステータスが DELETED になるまで待機

### 操作実行フロー (`executeOperations`)

各操作タイプごとに以下を実行:

#### DELETE 操作

1. `service.deleteGSI()` で GSI 削除を開始
2. `service.waitForTableActive()` でテーブルが ACTIVE になるまで待機
3. `service.waitForGSIStatus()` で GSI が DELETED になるまで待機

#### CREATE 操作

1. `service.createGSI()` で GSI 作成を開始
2. `service.waitForTableActive()` でテーブルが ACTIVE になるまで待機
3. `service.waitForGSIStatus()` で GSI が ACTIVE になるまで待機

#### UPDATE 操作

1. `service.updateGSI()` でスループット更新を開始
2. `service.waitForTableActive()` でテーブルが ACTIVE になるまで待機
3. `service.waitForGSIStatus()` で GSI が ACTIVE になるまで待機

---

## 3. DynamoDB GSI Service (`lambda/gsi-manager/src/dynamodb-gsi-service.ts`)

### 役割

DynamoDB の API 呼び出しをカプセル化し、GSI の CRUD 操作と待機処理を提供するサービス層。

### 主要メソッド

#### `getCurrentGSIs(tableName: string): Promise<GSIInfo[]>`

- `DescribeTableCommand` でテーブル情報を取得
- GSI のリストを `GSIInfo` 型に変換して返す
- リトライロジック付き

#### `createGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>`

1. GSI 設定から AttributeDefinitions を生成
2. KeySchema（パーティションキー、ソートキー）を生成
3. Projection（射影タイプと非キー属性）を生成
4. ProvisionedThroughput（プロビジョニングされたスループット）を生成
5. `UpdateTableCommand` で GSI 作成を実行

#### `updateGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>`

- プロビジョニングされたスループットのみ更新可能
- `UpdateTableCommand` でスループット変更を実行

#### `deleteGSI(tableName: string, indexName: string): Promise<void>`

- `UpdateTableCommand` で GSI 削除を実行

#### `waitForGSIStatus(tableName: string, indexName: string, targetStatus: "ACTIVE" | "DELETED"): Promise<void>`

**ポーリングベースの待機処理**:

1. 初期遅延: 3 秒
2. 最大遅延: 20 秒
3. タイムアウト: 15 分
4. 指数バックオフで遅延を倍増（最大遅延まで）
5. 対象ステータスに達するまでループ

**DELETED の場合**:

- `getCurrentGSIs` で GSI が見つからなくなるまで待機

**ACTIVE の場合**:

- GSI の `indexStatus` が ACTIVE になるまで待機

#### `waitForTableActive(tableName: string): Promise<void>`

- テーブルの `TableStatus` が ACTIVE になるまで待機
- GSI 操作を連続で実行する前に必ず呼び出す

### リトライ戦略

- すべての API 呼び出しは `retryWithBackoff` でラップ
- デフォルトで `ThrottlingException`, `ProvisionedThroughputExceededException` などをリトライ

---

## 4. Operation Planner (`lambda/gsi-manager/src/operation-planner.ts`)

### 役割

現在の GSI 状態と目標の GSI 状態を比較し、必要最小限の操作（CREATE/UPDATE/DELETE）を計算します。

### `planGsiOperations(current: GSIInfo[], desired: GSIConfiguration[]): GSIOperation[]`

#### ステップ 1: 削除対象の検出

- 現在存在するが、目標には含まれない GSI → DELETE 操作を追加

#### ステップ 2: 各目標 GSI の処理

各目標 GSI に対して:

1. **存在しない場合**

   - CREATE 操作を追加

2. **存在するが変更が必要な場合**

   - **キースキーマ変更を検出**: `keySchemaChanged`

     - パーティションキーの変更
     - ソートキーの追加/削除/変更

   - **射影変更を検出**: `projectionChanged`

     - ProjectionType の変更（ALL, KEYS_ONLY, INCLUDE）
     - 非キー属性リストの変更

   - **キースキーマまたは射影が変更された場合**:

     - DELETE 操作を追加（既存 GSI を削除）
     - CREATE 操作を追加（新しい GSI を作成）

   - **スループットのみ変更された場合**: `shouldUpdateThroughput`
     - UPDATE 操作を追加（インプレース更新）

#### 変更検出ロジック

**キースキーマ変更** (`keySchemaChanged`):

- パーティションキー名が一致しているか
- ソートキーの有無と名前が一致しているか

**射影変更** (`projectionChanged`):

- ProjectionType が一致しているか
- INCLUDE の場合、非キー属性リストが同じか（順序は無視）

**スループット変更** (`shouldUpdateThroughput`):

- PAY_PER_REQUEST モードの場合は更新不要
- ReadCapacityUnits または WriteCapacityUnits が異なる場合

---

## 5. Error Handling (`lambda/gsi-manager/src/error-handling.ts`)

### 役割

AWS SDK 呼び出しに対する指数バックオフリトライロジックを提供します。

### `retryWithBackoff<T>(operation: () => Promise<T>, config: ErrorHandlingConfig, customRetryRule?: (err: unknown) => boolean): Promise<T>`

#### リトライアルゴリズム

1. **初期試行**: 操作を実行
2. **エラー発生時**:

   - エラーコードがリトライ可能かチェック
   - 最大リトライ回数に達していないかチェック
   - 待機（ベース遅延 × 2^試行回数、ジッター付き）
   - 再試行

3. **リトライ対象エラーコード** (デフォルト):

   - `ThrottlingException`
   - `ProvisionedThroughputExceededException`
   - `LimitExceededException`
   - `RequestLimitExceeded`
   - `TooManyRequestsException`
   - `InternalServerError`
   - `ServiceUnavailable`

4. **ジッター**:
   - ベース遅延の 20% をランダムに加算
   - 同時リトライによる衝突を回避

#### エラーコード抽出

- `error.code` または `error.name` からエラーコードを取得
- SDK のエラーオブジェクトと一般的な Error オブジェクトの両方に対応

---

## 処理フロー全体図

```
┌─────────────────────────────────────────────────────┐
│ CloudFormation: Create/Update スタック              │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Custom Resource: イベント送信                       │
│ - tableName: "MyTable"                              │
│ - globalSecondaryIndexes: [...]                     │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Lambda Handler: イベント受信                        │
│ 1. プロパティをパース                                │
│ 2. GSI 設定をバリデーション                          │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ DynamoDB Service: 現在の GSI 取得                   │
│ - DescribeTable API 呼び出し                        │
│ - リトライロジック適用                               │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Operation Planner: 差分計算                         │
│ - 現在: [GSI-A, GSI-B]                              │
│ - 目標: [GSI-A (変更), GSI-C]                       │
│ - 計画: [UPDATE GSI-A, DELETE GSI-B, CREATE GSI-C]  │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Operation Execution: 操作を順次実行                 │
│                                                     │
│ 1. UPDATE GSI-A                                     │
│    - UpdateTable API 呼び出し                       │
│    - テーブルが ACTIVE になるまで待機                │
│    - GSI-A が ACTIVE になるまで待機                 │
│                                                     │
│ 2. DELETE GSI-B                                     │
│    - UpdateTable API 呼び出し                       │
│    - テーブルが ACTIVE になるまで待機                │
│    - GSI-B が DELETED になるまで待機                │
│                                                     │
│ 3. CREATE GSI-C                                     │
│    - UpdateTable API 呼び出し                       │
│    - テーブルが ACTIVE になるまで待機                │
│    - GSI-C が ACTIVE になるまで待機                 │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Lambda Handler: レスポンス返却                      │
│ - PhysicalResourceId: "GSIManager-MyTable"          │
│ - Data:                                             │
│   - operationsExecuted: 3                           │
│   - managedIndexes: "GSI-A,GSI-C"                   │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ CloudFormation: デプロイメント完了                  │
└─────────────────────────────────────────────────────┘
```

---

## 設計上の重要なポイント

### 1. 順次実行と待機

- DynamoDB は同時に複数の GSI 操作を受け付けない
- 各操作後、必ずテーブルと GSI が安定状態（ACTIVE/DELETED）になるまで待機

### 2. 指数バックオフリトライ

- スロットリングエラーや一時的なエラーに対して自動リトライ
- ジッターを加えることで同時リトライの衝突を回避

### 3. インプレース更新 vs 再作成

- **スループットのみ変更**: UPDATE 操作でインプレース更新
- **キースキーマまたは射影変更**: DELETE → CREATE で再作成

### 4. CloudFormation 統合

- Custom Resource パターンでデプロイメントライフサイクルに統合
- スタック削除時に自動的に GSI もクリーンアップ

### 5. エラーハンドリング設定の柔軟性

- リトライ回数、遅延時間、対象エラーコードをカスタマイズ可能
- デフォルト値でほとんどのケースに対応

---

## 使用例

```typescript
import { GsiManager } from "./lib/gsi-manager-construct";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

const table = new dynamodb.Table(this, "MyTable", {
  partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
  // ... その他の設定
});

new GsiManager(this, "GsiManager", {
  table,
  globalSecondaryIndexes: [
    {
      indexName: "GSI-UserEmail",
      partitionKey: { name: "email", type: "S" },
      projectionType: "ALL",
    },
    {
      indexName: "GSI-CreatedAt",
      partitionKey: { name: "createdAt", type: "N" },
      sortKey: { name: "userId", type: "S" },
      projectionType: "INCLUDE",
      nonKeyAttributes: ["status", "updatedAt"],
      provisionedThroughput: {
        readCapacityUnits: 5,
        writeCapacityUnits: 5,
      },
    },
  ],
  timeout: Duration.minutes(15),
  logRetention: logs.RetentionDays.ONE_WEEK,
  errorHandling: {
    maxRetries: 5,
    baseDelayMs: 1000,
  },
});
```

デプロイ時、このコンストラクトは:

1. GSI-UserEmail と GSI-CreatedAt が存在しない場合、作成
2. すでに存在する場合、設定の差分を検出して更新または再作成
3. 管理対象外の GSI は削除せず、管理対象のみを操作
