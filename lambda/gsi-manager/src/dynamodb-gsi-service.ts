// DynamoDB GSI service interface and implementation (Lambda side).
// The service encapsulates DescribeTable / UpdateTable flows so the handler can
// focus on orchestration rather than raw AWS SDK calls.

import {
  DescribeTableCommand,
  DynamoDBClient,
  KeySchemaElement,
  Projection,
  UpdateTableCommand,
  type AttributeDefinition as AwsAttributeDefinition,
  type GlobalSecondaryIndexUpdate,
  type DescribeTableCommandOutput,
  type GlobalSecondaryIndexDescription,
} from "@aws-sdk/client-dynamodb";
import type {
  AttributeDefinition,
  ErrorHandlingConfig,
  GSIConfiguration,
  GSIInfo,
} from "../../../lib/types/index.js";
import { mergeErrorHandlingConfig } from "../../../lib/types/index.js";
import { retryWithBackoff } from "./error-handling.js";

const DEFAULT_WAITER_CONFIG = {
  initialDelayMs: 3_000,
  maxDelayMs: 20_000,
  timeoutMs: 15 * 60 * 1_000,
};

const PROGRESS_LOG_INTERVAL_MS = 60_000;

interface WaiterConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export interface DynamoDBGSIServiceOptions {
  client?: DynamoDBClient;
  errorHandling?: Partial<ErrorHandlingConfig>;
  waiter?: Partial<WaiterConfig>;
}

export interface DynamoDBGSIService {
  getCurrentGSIs(tableName: string): Promise<GSIInfo[]>;
  createGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>;
  updateGSI(tableName: string, gsiConfig: GSIConfiguration): Promise<void>;
  deleteGSI(tableName: string, indexName: string): Promise<void>;
  waitForGSIStatus(
    tableName: string,
    indexName: string,
    targetStatus: "ACTIVE" | "DELETED"
  ): Promise<void>;
  waitForTableActive(tableName: string): Promise<void>;
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const toAttributeDefinitions = (
  gsiConfig: GSIConfiguration
): AwsAttributeDefinition[] => {
  // DynamoDB requires the full set of attribute definitions for key elements on creation.
  const map = new Map<string, AttributeDefinition>();
  map.set(gsiConfig.partitionKey.name, gsiConfig.partitionKey);
  if (gsiConfig.sortKey) {
    map.set(gsiConfig.sortKey.name, gsiConfig.sortKey);
  }

  return Array.from(map.values()).map((attribute) => ({
    AttributeName: attribute.name,
    AttributeType: attribute.type,
  }));
};

const toKeySchema = (
  gsiConfig: GSIConfiguration
): KeySchemaElement[] => {
  const keySchema: KeySchemaElement[] = [
    {
      AttributeName: gsiConfig.partitionKey.name,
      KeyType: "HASH",
    },
  ];

  if (gsiConfig.sortKey) {
    keySchema.push({
      AttributeName: gsiConfig.sortKey.name,
      KeyType: "RANGE",
    });
  }

  return keySchema;
};

const toProjection = (gsiConfig: GSIConfiguration): Projection => {
  const projectionType = gsiConfig.projectionType ?? "ALL";
  const projection: Projection = {
    ProjectionType: projectionType,
  };

  if (projectionType === "INCLUDE" && gsiConfig.nonKeyAttributes?.length) {
    projection.NonKeyAttributes = gsiConfig.nonKeyAttributes;
  }

  return projection;
};

const toProvisionedThroughput = (gsiConfig: GSIConfiguration) =>
  gsiConfig.provisionedThroughput
    ? {
        ReadCapacityUnits: gsiConfig.provisionedThroughput.readCapacityUnits,
        WriteCapacityUnits: gsiConfig.provisionedThroughput.writeCapacityUnits,
      }
    : undefined;

export class DynamoDBGSIServiceImpl implements DynamoDBGSIService {
  private readonly client: DynamoDBClient;
  private readonly errorHandling: ErrorHandlingConfig;
  private readonly waiter: WaiterConfig;

  constructor(options: DynamoDBGSIServiceOptions = {}) {
    this.client = options.client ?? new DynamoDBClient({});
    this.errorHandling = mergeErrorHandlingConfig(options.errorHandling);
    this.waiter = {
      initialDelayMs:
        options.waiter?.initialDelayMs ?? DEFAULT_WAITER_CONFIG.initialDelayMs,
      maxDelayMs:
        options.waiter?.maxDelayMs ?? DEFAULT_WAITER_CONFIG.maxDelayMs,
      timeoutMs:
        options.waiter?.timeoutMs ?? DEFAULT_WAITER_CONFIG.timeoutMs,
    };
  }

  async getCurrentGSIs(tableName: string): Promise<GSIInfo[]> {
    const output = await retryWithBackoff<DescribeTableCommandOutput>(
      () =>
        this.client.send<DescribeTableCommandOutput>(
          new DescribeTableCommand({ TableName: tableName })
        ),
      this.errorHandling
    );

    const table = output.Table;
    if (!table?.GlobalSecondaryIndexes) {
      return [];
    }

    return table.GlobalSecondaryIndexes.map(
      (gsi: GlobalSecondaryIndexDescription) => ({
        indexName: gsi.IndexName ?? "",
        keySchema:
          gsi.KeySchema?.map((item: KeySchemaElement) => ({
            attributeName: item.AttributeName ?? "",
            keyType: item.KeyType ?? "HASH",
          })) ?? [],
        projection: {
          projectionType:
            (gsi.Projection?.ProjectionType as "ALL" | "KEYS_ONLY" | "INCLUDE") ??
            "ALL",
          nonKeyAttributes: gsi.Projection?.NonKeyAttributes ?? undefined,
      },
      indexStatus: gsi.IndexStatus ?? undefined,
      provisionedThroughput: gsi.ProvisionedThroughput
        ? {
            readCapacityUnits:
              gsi.ProvisionedThroughput.ReadCapacityUnits ?? 0,
            writeCapacityUnits:
              gsi.ProvisionedThroughput.WriteCapacityUnits ?? 0,
          }
        : undefined,
    }));
  }

  async createGSI(
    tableName: string,
    gsiConfig: GSIConfiguration
  ): Promise<void> {
    const AttributeDefinitions = toAttributeDefinitions(gsiConfig);
    const KeySchema = toKeySchema(gsiConfig);

    const Projection = toProjection(gsiConfig);
    const ProvisionedThroughput = toProvisionedThroughput(gsiConfig);

    const update: GlobalSecondaryIndexUpdate = {
      Create: {
        IndexName: gsiConfig.indexName,
        KeySchema,
        Projection,
        ProvisionedThroughput,
      },
    };

    await retryWithBackoff(
      () =>
        this.client.send(
          new UpdateTableCommand({
            TableName: tableName,
            AttributeDefinitions,
            GlobalSecondaryIndexUpdates: [update],
          })
        ),
      this.errorHandling
    );
  }

  async updateGSI(
    tableName: string,
    gsiConfig: GSIConfiguration
  ): Promise<void> {
    if (!gsiConfig.provisionedThroughput) {
      return;
    }

    const update: GlobalSecondaryIndexUpdate = {
      Update: {
        IndexName: gsiConfig.indexName,
        ProvisionedThroughput: toProvisionedThroughput(gsiConfig),
      },
    };

    await retryWithBackoff(
      () =>
        this.client.send(
          new UpdateTableCommand({
            TableName: tableName,
            GlobalSecondaryIndexUpdates: [update],
          })
        ),
      this.errorHandling
    );
  }

  async deleteGSI(tableName: string, indexName: string): Promise<void> {
    const update: GlobalSecondaryIndexUpdate = {
      Delete: {
        IndexName: indexName,
      },
    };

    await retryWithBackoff(
      () =>
        this.client.send(
          new UpdateTableCommand({
            TableName: tableName,
            GlobalSecondaryIndexUpdates: [update],
          })
        ),
      this.errorHandling
    );
  }

  async waitForGSIStatus(
    tableName: string,
    indexName: string,
    targetStatus: "ACTIVE" | "DELETED"
  ): Promise<void> {
    const start = Date.now();
    let delay = this.waiter.initialDelayMs;
    let lastProgressLog = -PROGRESS_LOG_INTERVAL_MS;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Poll DescribeTable until the index disappears (delete) or becomes ACTIVE.
      const indexes = await this.getCurrentGSIs(tableName);
      const match = indexes.find((gsi) => gsi.indexName === indexName);
      const elapsed = Date.now() - start;

      if (targetStatus === "DELETED") {
        if (!match) {
          return;
        }
      } else if (match?.indexStatus === targetStatus) {
        return;
      }

      if (Date.now() - start > this.waiter.timeoutMs) {
        throw new Error(
          `Timed out waiting for GSI "${indexName}" to reach status ${targetStatus}`
        );
      }

      if (elapsed - lastProgressLog >= PROGRESS_LOG_INTERVAL_MS) {
        console.log(
          `[GSI Manager][waitForGSIStatus] table=${tableName}, index=${indexName}, target=${targetStatus}, current=${
            match?.indexStatus ?? "MISSING"
          }, elapsed=${Math.round(elapsed / 1000)}s`
        );
        lastProgressLog = elapsed;
      }

      await sleep(Math.min(delay, this.waiter.maxDelayMs));
      delay = Math.min(delay * 2, this.waiter.maxDelayMs);
    }
  }

  async waitForTableActive(tableName: string): Promise<void> {
    const start = Date.now();
    let delay = this.waiter.initialDelayMs;
    let lastProgressLog = -PROGRESS_LOG_INTERVAL_MS;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Ensures subsequent GSI operations are not started while the table is UPDATING.
      const response = await retryWithBackoff<DescribeTableCommandOutput>(
        () =>
          this.client.send<DescribeTableCommandOutput>(
            new DescribeTableCommand({ TableName: tableName })
          ),
        this.errorHandling
      );

      const tableStatus = response.Table?.TableStatus;
      const elapsed = Date.now() - start;
      if (tableStatus === "ACTIVE") {
        return;
      }

      if (Date.now() - start > this.waiter.timeoutMs) {
        throw new Error(
          `Timed out waiting for table "${tableName}" to become ACTIVE`
        );
      }

      if (elapsed - lastProgressLog >= PROGRESS_LOG_INTERVAL_MS) {
        console.log(
          `[GSI Manager][waitForTableActive] table=${tableName}, status=${
            tableStatus ?? "UNKNOWN"
          }, elapsed=${Math.round(elapsed / 1000)}s`
        );
        lastProgressLog = elapsed;
      }

      await sleep(Math.min(delay, this.waiter.maxDelayMs));
      delay = Math.min(delay * 2, this.waiter.maxDelayMs);
    }
  }
}
